//! The engine room: finds, installs, verifies and updates the three tools
//! Balader drives.
//!
//! * yt-dlp  – the extractor (1800+ sites, kept current: sites change weekly)
//! * ffmpeg  – merges video+audio, converts audio, embeds covers
//! * deno    – runs YouTube's JavaScript challenge for yt-dlp (optional but
//!   strongly recommended; Node.js >= 20 found on the system works too)
//!
//! Managed copies live in `<engine_dir>/<component>/` and are always preferred
//! over system copies. Every download is SHA-256 verified against the
//! checksum file published next to it before anything is executed.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use regex::Regex;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::error::{CoreError, ErrorCode, Result};
use crate::events::{CoreEvent, EventBus};
use crate::model::{ComponentState, ComponentStatus, EngineStatus, InstallStage};
use crate::proc;
use crate::util::path_str;

pub const COMPONENTS: [&str; 3] = ["ytdlp", "ffmpeg", "deno"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinSource {
    Managed,
    System,
}

impl BinSource {
    fn as_str(self) -> &'static str {
        match self {
            BinSource::Managed => "managed",
            BinSource::System => "system",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Bin {
    pub path: PathBuf,
    pub source: BinSource,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Resolved {
    pub ytdlp: Option<Bin>,
    pub ffmpeg: Option<Bin>,
    pub ffprobe: Option<PathBuf>,
    pub deno: Option<Bin>,
    pub node: Option<Bin>,
}

// ------------------------------------------------------------ sources

#[derive(Debug, Clone)]
enum Checksum {
    /// A SHA2-256SUMS style file: "<hash>  <name>" per line.
    Sums { url: String, name: String },
    /// A file holding the hash somewhere (also PowerShell Get-FileHash output).
    Sidecar { url: String },
    /// `<final redirected url><suffix>`.
    FinalSidecar { suffix: &'static str },
}

#[derive(Debug, Clone, Copy)]
enum Pick {
    /// Keep the archive layout (yt-dlp's onedir build).
    All,
    /// Flatten; keep files whose basename is listed.
    Names(&'static [&'static str]),
    /// Flatten; keep everything under a `/bin/` folder except ffplay.
    FfmpegBin,
}

#[derive(Debug, Clone)]
struct Asset {
    url: String,
    checksum: Checksum,
    pick: Pick,
}

fn gh_latest(repo: &str, asset: &str) -> String {
    format!("https://github.com/{repo}/releases/latest/download/{asset}")
}

fn os() -> &'static str {
    std::env::consts::OS
}

fn arm() -> bool {
    std::env::consts::ARCH == "aarch64"
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

fn ytdlp_zip() -> &'static str {
    match (os(), arm()) {
        ("macos", _) => "yt-dlp_macos.zip",
        ("windows", false) => "yt-dlp_win.zip",
        ("windows", true) => "yt-dlp_win_arm64.zip",
        (_, false) => "yt-dlp_linux.zip",
        (_, true) => "yt-dlp_linux_aarch64.zip",
    }
}

fn deno_triple() -> &'static str {
    match (os(), arm()) {
        ("macos", true) => "aarch64-apple-darwin",
        ("macos", false) => "x86_64-apple-darwin",
        ("windows", true) => "aarch64-pc-windows-msvc",
        ("windows", false) => "x86_64-pc-windows-msvc",
        (_, true) => "aarch64-unknown-linux-gnu",
        (_, false) => "x86_64-unknown-linux-gnu",
    }
}

fn assets(id: &str) -> Vec<Asset> {
    match id {
        "ytdlp" => vec![Asset {
            url: gh_latest("yt-dlp/yt-dlp", ytdlp_zip()),
            checksum: Checksum::Sums { url: gh_latest("yt-dlp/yt-dlp", "SHA2-256SUMS"), name: ytdlp_zip().into() },
            pick: Pick::All,
        }],
        "ffmpeg" if os() == "windows" => {
            let name = if arm() { "ffmpeg-master-latest-winarm64-gpl-shared.zip" } else { "ffmpeg-master-latest-win64-gpl-shared.zip" };
            vec![Asset {
                url: format!("https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/{name}"),
                checksum: Checksum::Sums {
                    url: "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/checksums.sha256".into(),
                    name: name.into(),
                },
                pick: Pick::FfmpegBin,
            }]
        }
        "ffmpeg" => {
            // Static, signed builds by Martin Riedl for macOS and Linux.
            let platform = if os() == "macos" { "macos" } else { "linux" };
            let a = if arm() { "arm64" } else { "amd64" };
            ["ffmpeg", "ffprobe"]
                .iter()
                .map(|tool| Asset {
                    url: format!("https://ffmpeg.martin-riedl.de/redirect/latest/{platform}/{a}/release/{tool}.zip"),
                    checksum: Checksum::FinalSidecar { suffix: ".sha256" },
                    pick: Pick::Names(&["ffmpeg", "ffprobe"]),
                })
                .collect()
        }
        "deno" => {
            let name = format!("deno-{}.zip", deno_triple());
            vec![Asset {
                url: gh_latest("denoland/deno", &name),
                checksum: Checksum::Sidecar { url: gh_latest("denoland/deno", &format!("{name}.sha256sum")) },
                pick: Pick::Names(&["deno", "deno.exe"]),
            }]
        }
        _ => Vec::new(),
    }
}

fn approx_download_size(id: &str) -> u64 {
    match (id, os()) {
        ("ytdlp", "macos") => 54_000_000,
        ("ytdlp", _) => 24_000_000,
        ("ffmpeg", "windows") => 91_000_000,
        ("ffmpeg", _) => 62_000_000,
        ("deno", _) => 42_000_000,
        _ => 0,
    }
}

// ------------------------------------------------------------ discovery

const YTDLP_NAMES: &[&str] = &["yt-dlp_macos", "yt-dlp.exe", "yt-dlp_arm64.exe", "yt-dlp_linux", "yt-dlp_linux_aarch64", "yt-dlp"];

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// GUI apps on macOS get a minimal PATH, so also look where package managers put things.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();
    let extra: Vec<PathBuf> = match os() {
        "macos" => vec![
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
            "/opt/local/bin".into(),
            home.join(".deno/bin"),
            home.join(".local/bin"),
            home.join("bin"),
            "/usr/bin".into(),
        ],
        "windows" => {
            let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
            let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| "C:\\Program Files".into());
            vec![
                home.join(".deno\\bin"),
                local.join("Microsoft\\WinGet\\Links"),
                home.join("scoop\\shims"),
                "C:\\ProgramData\\chocolatey\\bin".into(),
                pf.join("nodejs"),
            ]
        }
        _ => vec!["/usr/local/bin".into(), "/usr/bin".into(), home.join(".local/bin"), home.join(".deno/bin")],
    };
    for e in extra {
        if !dirs.contains(&e) {
            dirs.push(e);
        }
    }
    dirs
}

fn find_system(name: &str) -> Option<PathBuf> {
    let file = exe(name);
    search_dirs().into_iter().map(|d| d.join(&file)).find(|p| is_executable(p))
}

static VERSION_RES: std::sync::LazyLock<[Regex; 3]> = std::sync::LazyLock::new(|| {
    [
        Regex::new(r"ffmpeg version (\S+)").unwrap(),
        Regex::new(r"deno (\S+)").unwrap(),
        Regex::new(r"v?(\d+\.\d+\.\d+)").unwrap(),
    ]
});

async fn version_of(kind: &str, path: &Path) -> std::result::Result<String, String> {
    let args: Vec<String> = match kind {
        "ffmpeg" => vec!["-hide_banner".into(), "-version".into()],
        _ => vec!["--version".into()],
    };
    // A freshly unpacked binary can take a while on first launch (macOS scans it).
    let out = proc::run(path, &args, Duration::from_secs(45)).await.map_err(|e| format!("can't start: {e}"))?;
    if out.timed_out {
        return Err("didn't answer in time".into());
    }
    if !out.success {
        let tail: String = out.stderr.lines().last().unwrap_or("").chars().take(160).collect();
        return Err(format!("exited with an error {tail}").trim().to_string());
    }
    let first = out.stdout.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
    let v = match kind {
        "ffmpeg" => VERSION_RES[0].captures(&first).map(|c| clean_ffmpeg_version(&c[1])),
        "deno" => VERSION_RES[1].captures(&first).map(|c| c[1].to_string()),
        "node" => VERSION_RES[2].captures(&first).map(|c| c[1].to_string()),
        _ => Some(first.clone()),
    };
    let v = v.unwrap_or(first);
    Ok(v.chars().take(32).collect())
}

// ------------------------------------------------------------ engine

pub struct Engine {
    dir: PathBuf,
    cache_dir: PathBuf,
    http: reqwest::Client,
    http_noredirect: reqwest::Client,
    events: EventBus,
    resolved: RwLock<Resolved>,
    installing: Mutex<HashSet<String>>,
    errors: Mutex<HashMap<String, String>>,
    latest: Mutex<HashMap<String, String>>,
    install_lock: tokio::sync::Mutex<()>,
}

impl Engine {
    pub fn new(dir: PathBuf, cache_dir: PathBuf, events: EventBus) -> Self {
        let ua = format!("Balader/{} (+https://github.com/balader)", env!("CARGO_PKG_VERSION"));
        let http = reqwest::Client::builder()
            .user_agent(ua.clone())
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .build()
            .expect("http client");
        let http_noredirect = reqwest::Client::builder()
            .user_agent(ua)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .expect("http client");
        Engine {
            dir,
            cache_dir,
            http,
            http_noredirect,
            events,
            resolved: RwLock::new(Resolved::default()),
            installing: Mutex::new(HashSet::new()),
            errors: Mutex::new(HashMap::new()),
            latest: Mutex::new(HashMap::new()),
            install_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn resolved(&self) -> Resolved {
        self.resolved.read().unwrap().clone()
    }

    fn managed_dir(&self, id: &str) -> PathBuf {
        self.dir.join(match id {
            "ytdlp" => "yt-dlp",
            other => other,
        })
    }

    fn managed_bin(&self, id: &str) -> Option<PathBuf> {
        let dir = self.managed_dir(id);
        let names: Vec<String> = match id {
            "ytdlp" => YTDLP_NAMES.iter().map(|s| s.to_string()).collect(),
            other => vec![exe(other)],
        };
        names.into_iter().map(|n| dir.join(n)).find(|p| is_executable(p))
    }

    async fn locate(&self, id: &str) -> (Option<Bin>, Option<String>) {
        let mut candidates: Vec<(PathBuf, BinSource)> = Vec::new();
        if let Some(p) = self.managed_bin(id) {
            candidates.push((p, BinSource::Managed));
        }
        let sys = match id {
            "ytdlp" => find_system("yt-dlp"),
            other => find_system(other),
        };
        if let Some(p) = sys {
            candidates.push((p, BinSource::System));
        }
        let mut last_err = None;
        for (path, source) in candidates {
            match version_of(id, &path).await {
                Ok(v) => return (Some(Bin { path, source, version: Some(v) }), None),
                Err(e) => last_err = Some(format!("{} copy {}", source.as_str(), e)),
            }
        }
        (None, last_err)
    }

    /// Re-scan the disk for every component and refresh versions.
    pub async fn refresh(&self) -> EngineStatus {
        let (ytdlp, ffmpeg, deno) = tokio::join!(self.locate("ytdlp"), self.locate("ffmpeg"), self.locate("deno"));
        let node = if deno.0.is_none() {
            match find_system("node") {
                Some(p) => match version_of("node", &p).await {
                    Ok(v) if v.split('.').next().and_then(|m| m.parse::<u32>().ok()).unwrap_or(0) >= 20 => {
                        Some(Bin { path: p, source: BinSource::System, version: Some(v) })
                    }
                    _ => None,
                },
                None => None,
            }
        } else {
            None
        };
        let ffprobe = ffmpeg.0.as_ref().and_then(|b| {
            let p = b.path.with_file_name(exe("ffprobe"));
            is_executable(&p).then_some(p)
        });
        {
            let mut errs = self.errors.lock().unwrap();
            for (id, err) in [("ytdlp", &ytdlp.1), ("ffmpeg", &ffmpeg.1), ("deno", &deno.1)] {
                match err {
                    Some(e) => {
                        errs.insert(id.into(), e.clone());
                    }
                    None => {
                        errs.remove(id);
                    }
                }
            }
        }
        *self.resolved.write().unwrap() = Resolved { ytdlp: ytdlp.0, ffmpeg: ffmpeg.0, ffprobe, deno: deno.0, node };
        let status = self.status();
        self.events.emit(CoreEvent::EngineStatus { status: status.clone() });
        status
    }

    pub fn status(&self) -> EngineStatus {
        let r = self.resolved();
        let installing = self.installing.lock().unwrap().clone();
        let errors = self.errors.lock().unwrap().clone();
        let latest = self.latest.lock().unwrap().clone();
        let comp = |id: &str, name: &str, role: &str, required: bool, bin: Option<&Bin>| {
            let state = if installing.contains(id) {
                ComponentState::Installing
            } else if bin.is_some() {
                ComponentState::Ready
            } else if errors.contains_key(id) {
                ComponentState::Error
            } else {
                ComponentState::Missing
            };
            let version = bin.and_then(|b| b.version.clone());
            let latest_v = latest.get(id).cloned();
            let update_available = matches!((&latest_v, &version, bin.map(|b| b.source)), (Some(l), Some(v), Some(BinSource::Managed)) if norm(l) != norm(v));
            ComponentStatus {
                id: id.into(),
                name: name.into(),
                role: role.into(),
                required,
                state,
                source: bin.map(|b| b.source.as_str().to_string()),
                path: bin.map(|b| path_str(&b.path)),
                version,
                latest: latest_v,
                update_available,
                error: if bin.is_none() { errors.get(id).cloned() } else { None },
                download_size: approx_download_size(id),
            }
        };
        let mut deno = comp("deno", "Deno", "Solves YouTube's JS challenge", false, r.deno.as_ref());
        if r.deno.is_none() {
            if let Some(node) = &r.node {
                deno.state = ComponentState::Ready;
                deno.name = "Node.js".into();
                deno.source = Some("system".into());
                deno.path = Some(path_str(&node.path));
                deno.version = node.version.clone();
                deno.error = None;
            }
        }
        let components = vec![
            comp("ytdlp", "yt-dlp", "Reads 1800+ sites", true, r.ytdlp.as_ref()),
            comp("ffmpeg", "FFmpeg", "Merges, converts, embeds", true, r.ffmpeg.as_ref()),
            deno,
        ];
        let ready = components.iter().filter(|c| c.required).all(|c| c.state == ComponentState::Ready);
        let js_runtime = match (&r.deno, &r.node) {
            (Some(d), _) => Some(format!("deno ({})", d.source.as_str())),
            (None, Some(_)) => Some("node (system)".into()),
            _ => None,
        };
        EngineStatus {
            components,
            ready,
            engine_dir: path_str(&self.dir),
            platform: os().into(),
            arch: std::env::consts::ARCH.into(),
            js_runtime,
        }
    }

    pub fn ytdlp_path(&self) -> Result<PathBuf> {
        self.resolved().ytdlp.map(|b| b.path).ok_or_else(|| {
            CoreError::coded(ErrorCode::EngineMissing, "The engine isn't installed yet.").with_hint("Open the engine room and install it (one click).")
        })
    }

    /// Arguments every yt-dlp invocation gets: no user config, our ffmpeg,
    /// our JS runtime, our cache.
    pub fn base_args(&self) -> Vec<String> {
        let r = self.resolved();
        let mut a: Vec<String> = vec!["--ignore-config".into(), "--color".into(), "never".into()];
        if let Some(ff) = &r.ffmpeg {
            a.push("--ffmpeg-location".into());
            a.push(path_str(ff.path.parent().unwrap_or(&ff.path)));
        }
        match (&r.deno, &r.node) {
            (Some(d), _) => {
                a.push("--js-runtimes".into());
                a.push(format!("deno:{}", path_str(&d.path)));
            }
            (None, Some(n)) => {
                a.push("--js-runtimes".into());
                a.push(format!("node:{}", path_str(&n.path)));
            }
            _ => {}
        }
        a.push("--cache-dir".into());
        a.push(path_str(&self.cache_dir.join("yt-dlp")));
        a
    }

    // -------------------------------------------------------- updates

    async fn redirect_target(&self, url: &str) -> Option<String> {
        let resp = self.http_noredirect.get(url).send().await.ok()?;
        resp.headers().get(reqwest::header::LOCATION)?.to_str().ok().map(str::to_string)
    }

    /// Ask the release servers for the newest versions (no API quota used).
    pub async fn check_updates(&self) -> EngineStatus {
        let yt = self.redirect_target("https://github.com/yt-dlp/yt-dlp/releases/latest");
        let de = self.redirect_target("https://github.com/denoland/deno/releases/latest");
        let ff = async {
            if os() == "windows" {
                return None;
            }
            let platform = if os() == "macos" { "macos" } else { "linux" };
            let a = if arm() { "arm64" } else { "amd64" };
            self.redirect_target(&format!("https://ffmpeg.martin-riedl.de/redirect/latest/{platform}/{a}/release/ffmpeg.zip")).await
        };
        let (yt, de, ff) = tokio::join!(yt, de, ff);
        {
            let mut latest = self.latest.lock().unwrap();
            if let Some(tag) = yt.as_deref().and_then(|l| l.rsplit('/').next()) {
                latest.insert("ytdlp".into(), tag.to_string());
            }
            if let Some(tag) = de.as_deref().and_then(|l| l.rsplit('/').next()) {
                latest.insert("deno".into(), tag.trim_start_matches('v').to_string());
            }
            // .../download/macos/arm64/1789931890_9.0.2/ffmpeg.zip
            if let Some(v) = ff.as_deref().and_then(|l| l.rsplit('/').nth(1)).and_then(|seg| seg.split_once('_')).map(|(_, v)| v.to_string()) {
                latest.insert("ffmpeg".into(), v);
            }
        }
        let status = self.status();
        self.events.emit(CoreEvent::EngineStatus { status: status.clone() });
        status
    }

    // -------------------------------------------------------- install

    fn progress(&self, component: &str, stage: InstallStage, downloaded: u64, total: Option<u64>, message: Option<String>) {
        self.events.emit(CoreEvent::EngineProgress { component: component.into(), stage, downloaded, total, message });
    }

    /// Install `ids` (or everything missing when empty). `force` reinstalls
    /// managed copies even when present (that's how updates happen).
    pub async fn install(&self, ids: &[String], force: bool) -> Result<EngineStatus> {
        let _guard = self.install_lock.lock().await;
        let current = self.status();
        let wanted: Vec<String> = if ids.is_empty() {
            current.components.iter().filter(|c| force || c.state != ComponentState::Ready).map(|c| c.id.clone()).collect()
        } else {
            ids.iter().filter(|id| COMPONENTS.contains(&id.as_str())).cloned().collect()
        };
        let mut first_error: Option<CoreError> = None;
        for id in &wanted {
            if !force && self.managed_bin(id).is_some() {
                continue;
            }
            self.installing.lock().unwrap().insert(id.clone());
            self.events.emit(CoreEvent::EngineStatus { status: self.status() });
            let result = self.install_one(id).await;
            self.installing.lock().unwrap().remove(id);
            match result {
                Ok(()) => {
                    self.errors.lock().unwrap().remove(id);
                    self.progress(id, InstallStage::Done, 0, None, None);
                }
                Err(e) => {
                    let msg = e.payload().message;
                    log::warn!("install {id} failed: {e}");
                    self.errors.lock().unwrap().insert(id.clone(), msg.clone());
                    self.progress(id, InstallStage::Error, 0, None, Some(msg));
                    if first_error.is_none() {
                        first_error = Some(e);
                    }
                }
            }
        }
        let status = self.refresh().await;
        match first_error {
            Some(e) => Err(e),
            None => Ok(status),
        }
    }

    async fn install_one(&self, id: &str) -> Result<()> {
        let staging = self.dir.join(".staging").join(format!("{id}-{}", crate::util::new_id("")));
        let out_dir = staging.join("out");
        tokio::fs::create_dir_all(&out_dir).await?;
        let cleanup = scopeguard(staging.clone());

        for (i, asset) in assets(id).iter().enumerate() {
            let archive = staging.join(format!("asset-{i}.zip"));
            let (hash, final_url) = self.download(id, &asset.url, &archive).await?;
            self.progress(id, InstallStage::Verify, 0, None, None);
            let expected = self.expected_hash(&asset.checksum, &final_url).await?;
            if !expected.eq_ignore_ascii_case(&hash) {
                return Err(CoreError::coded(ErrorCode::Checksum, format!("{id}: checksum mismatch, download discarded"))
                    .with_detail(format!("expected {expected}\nactual   {hash}\nfrom {final_url}")));
            }
            self.progress(id, InstallStage::Extract, 0, None, None);
            let (archive_c, out_c, pick) = (archive.clone(), out_dir.clone(), asset.pick);
            tokio::task::spawn_blocking(move || extract_zip(&archive_c, &out_c, pick))
                .await
                .map_err(|e| CoreError::coded(ErrorCode::Io, format!("extract task failed: {e}")))??;
            let _ = tokio::fs::remove_file(&archive).await;
        }

        // Swap the new folder in, keeping the old one until the new one runs.
        self.progress(id, InstallStage::Check, 0, None, None);
        let target = self.managed_dir(id);
        let backup = staging.join("previous");
        if target.exists() {
            tokio::fs::rename(&target, &backup).await.map_err(|e| {
                CoreError::coded(ErrorCode::EngineBusy, format!("Couldn't replace {id}: {e}")).with_hint("Close anything using it (or wait for downloads to finish) and retry.")
            })?;
        }
        tokio::fs::rename(&out_dir, &target).await?;
        let bin = self.managed_bin(id).ok_or_else(|| CoreError::coded(ErrorCode::Unknown, format!("{id}: executable missing from the archive")));
        let check = match bin {
            Ok(p) => version_of(id, &p).await.map_err(|e| CoreError::coded(ErrorCode::Unknown, format!("{id} was installed but {e}"))),
            Err(e) => Err(e),
        };
        if let Err(e) = check {
            let _ = tokio::fs::remove_dir_all(&target).await;
            if backup.exists() {
                let _ = tokio::fs::rename(&backup, &target).await;
            }
            return Err(e);
        }
        drop(cleanup);
        Ok(())
    }

    async fn download(&self, id: &str, url: &str, dest: &Path) -> Result<(String, String)> {
        let resp = self.http.get(url).send().await?.error_for_status()?;
        let final_url = resp.url().to_string();
        let total = resp.content_length();
        let mut file = tokio::io::BufWriter::new(tokio::fs::File::create(dest).await?);
        let mut hasher = Sha256::new();
        let mut done: u64 = 0;
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut stream = resp.bytes_stream();
        self.progress(id, InstallStage::Download, 0, total, None);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            done += chunk.len() as u64;
            if last.elapsed() >= Duration::from_millis(120) {
                last = Instant::now();
                self.progress(id, InstallStage::Download, done, total, None);
            }
        }
        file.flush().await?;
        self.progress(id, InstallStage::Download, done, total.or(Some(done)), None);
        Ok((hex::encode(hasher.finalize()), final_url))
    }

    async fn expected_hash(&self, checksum: &Checksum, final_url: &str) -> Result<String> {
        let (url, name) = match checksum {
            Checksum::Sums { url, name } => (url.clone(), Some(name.clone())),
            Checksum::Sidecar { url } => (url.clone(), None),
            Checksum::FinalSidecar { suffix } => (format!("{final_url}{suffix}"), None),
        };
        let text = self.http.get(&url).send().await?.error_for_status()?.text().await?;
        parse_checksum(&text, name.as_deref()).ok_or_else(|| {
            CoreError::coded(ErrorCode::Checksum, "Couldn't read the published checksum, so the download was not trusted.").with_detail(url)
        })
    }
}

fn norm(v: &str) -> String {
    v.trim().trim_start_matches('v').to_string()
}

/// "9.0.2-https://www.martin-riedl.de" → "9.0.2", "7.1.1-essentials_build-www.gyan.dev" → "7.1.1",
/// "N-128220-gbea9d176f7-20261105" → "N-128220" (git master builds).
pub fn clean_ffmpeg_version(raw: &str) -> String {
    let raw = raw.trim().trim_start_matches('n');
    if let Some(rest) = raw.strip_prefix("N-") {
        return format!("N-{}", rest.split('-').next().unwrap_or(rest));
    }
    raw.split('-').next().unwrap_or(raw).to_string()
}

/// Find a SHA-256 in a checksum file. With `name`, use the matching line.
pub fn parse_checksum(text: &str, name: Option<&str>) -> Option<String> {
    static HEX: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"(?i)\b([0-9a-f]{64})\b").unwrap());
    if let Some(name) = name {
        for line in text.lines() {
            let mut parts = line.split_whitespace();
            let (Some(hash), Some(file)) = (parts.next(), parts.next()) else { continue };
            if file.trim_start_matches('*') == name && HEX.is_match(hash) {
                return Some(hash.to_ascii_lowercase());
            }
        }
        return None;
    }
    HEX.captures(text).map(|c| c[1].to_ascii_lowercase())
}

/// Removes a folder when dropped (unless defused with `drop` after success,
/// in which case the staging leftovers still go).
struct StagingGuard(PathBuf);
fn scopeguard(p: PathBuf) -> StagingGuard {
    StagingGuard(p)
}
impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn extract_zip(archive: &Path, out: &Path, pick: Pick) -> Result<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    let mut extracted = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        // enclosed_name() rejects absolute paths and `..` (zip-slip).
        let Some(rel) = entry.enclosed_name() else { continue };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let base = rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let dest: PathBuf = match pick {
            Pick::All => out.join(&rel),
            Pick::Names(names) => {
                if entry.is_dir() || !names.contains(&base.as_str()) {
                    continue;
                }
                out.join(&base)
            }
            Pick::FfmpegBin => {
                if entry.is_dir() || !rel_str.contains("/bin/") || base.eq_ignore_ascii_case("ffplay.exe") {
                    continue;
                }
                out.join(&base)
            }
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = std::fs::File::create(&dest)?;
        std::io::copy(&mut entry, &mut f)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = entry.unix_mode().unwrap_or(0o644);
            let exec_name = matches!(base.as_str(), "ffmpeg" | "ffprobe" | "deno") || base.starts_with("yt-dlp");
            let mode = if exec_name || mode & 0o111 != 0 { 0o755 } else { 0o644 };
            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(mode))?;
        }
        extracted += 1;
    }
    if extracted == 0 {
        return Err(CoreError::coded(ErrorCode::Unknown, "The archive didn't contain the expected files."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_formats() {
        let sums = "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d  yt-dlp.exe\n20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1  yt-dlp_macos.zip\n";
        assert_eq!(
            parse_checksum(sums, Some("yt-dlp_macos.zip")).as_deref(),
            Some("20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1")
        );
        assert_eq!(parse_checksum(sums, Some("missing.zip")), None);
        let powershell = "\nAlgorithm : SHA256\nHash      : CBA84B26E0DF5AE7F74FC66B86A95B866872A86292EBD84FA1E959927EDD93BF\nPath      : C:\\a\\deno.zip\n";
        assert_eq!(parse_checksum(powershell, None).as_deref(), Some("cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf"));
        let sidecar = "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924  ffmpeg.zip";
        assert!(parse_checksum(sidecar, None).unwrap().starts_with("c8ed4c4e"));
    }

    #[test]
    fn ffmpeg_versions_are_cleaned() {
        assert_eq!(clean_ffmpeg_version("9.0.2-https://www.martin-riedl.de"), "9.0.2");
        assert_eq!(clean_ffmpeg_version("7.1.1-essentials_build-www.gyan.dev"), "7.1.1");
        assert_eq!(clean_ffmpeg_version("N-128220-gbea9d176f7-20261105"), "N-128220");
        assert_eq!(clean_ffmpeg_version("n8.0"), "8.0");
        assert_eq!(clean_ffmpeg_version("8.0"), "8.0");
    }

    #[test]
    fn every_component_has_sources() {
        for id in COMPONENTS {
            let a = assets(id);
            assert!(!a.is_empty(), "{id}");
            assert!(a.iter().all(|x| x.url.starts_with("https://")), "{id}");
        }
    }

    #[test]
    fn base_args_without_tools_are_safe() {
        let e = Engine::new("/tmp/engine".into(), "/tmp/cache".into(), EventBus::new());
        let a = e.base_args();
        assert!(a.contains(&"--ignore-config".to_string()));
        assert!(!a.contains(&"--ffmpeg-location".to_string()));
        assert!(e.ytdlp_path().is_err());
    }
}
