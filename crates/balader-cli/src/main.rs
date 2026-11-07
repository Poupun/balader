//! `balader` – the engine without the pixels. Built for humans *and* for
//! automated testing: every subcommand can print JSON, `call` reaches any
//! command of the dispatcher with the exact JSON the UI sends, and `serve`
//! exposes the real core over HTTP + SSE so the web UI and Playwright can
//! run against real downloads in a plain browser.

mod serve;

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use balader_core::{
    AudioFormat, Container, Core, CoreEvent, CorePaths, DownloadRequest, JobStatus, Mode, ProbeResult, selector, util,
};
use clap::{Parser, Subcommand, ValueEnum};
use serde_json::{Value, json};

#[derive(Parser)]
#[command(name = "balader", version, about = "Balader engine CLI (probe, download, test server)")]
struct Cli {
    /// Isolate config/data/cache under this folder (sets BALADER_HOME).
    #[arg(long, global = true)]
    home: Option<PathBuf>,
    /// Use this engine folder (sets BALADER_ENGINE_DIR). Lets isolated runs share one engine.
    #[arg(long, global = true)]
    engine_dir: Option<PathBuf>,
    /// Default download folder (sets BALADER_OUTPUT_DIR).
    #[arg(long, global = true)]
    out_dir: Option<PathBuf>,
    /// Machine-readable output (one JSON document, or NDJSON for streams).
    #[arg(long, global = true)]
    json: bool,
    /// More logs on stderr (also: RUST_LOG=debug).
    #[arg(short, long, global = true)]
    verbose: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Engine room: status, install, update.
    Engine {
        #[command(subcommand)]
        action: EngineCmd,
    },
    /// Ask what a link holds (no download).
    Probe { url: String },
    /// Download a link, exactly the way the app would.
    Download(DownloadArgs),
    /// Call any core command with JSON args, e.g. `balader call probe '{"url":"…"}'`.
    Call {
        command: String,
        #[arg(default_value = "{}")]
        args: String,
    },
    /// List the dispatcher's commands.
    Commands,
    /// HTTP + SSE bridge to the real core (for the web UI and e2e tests).
    Serve {
        #[arg(long, default_value_t = 4317)]
        port: u16,
        /// Fixed access token (default: random, printed at start).
        #[arg(long)]
        token: Option<String>,
        /// Extra allowed browser origin (localhost:1420 and 127.0.0.1:1420 are always allowed).
        #[arg(long)]
        origin: Vec<String>,
    },
}

#[derive(Subcommand)]
enum EngineCmd {
    /// Show what's installed (re-scans the disk).
    Status,
    /// Install components (all missing ones when none given).
    Install {
        components: Vec<String>,
        #[arg(long)]
        force: bool,
    },
    /// Check the release servers for newer versions.
    Check,
    /// Check, then reinstall anything outdated.
    Update,
}

#[derive(Clone, Copy, ValueEnum)]
enum ContainerArg {
    Mp4,
    Mkv,
}

#[derive(Clone, Copy, ValueEnum)]
enum AudioArg {
    Mp3,
    M4a,
    Opus,
    Flac,
    Wav,
}

#[derive(clap::Args)]
struct DownloadArgs {
    url: String,
    /// Resolution tier (short side), e.g. 1080. Default: best.
    #[arg(long)]
    tier: Option<u32>,
    #[arg(long, value_enum, default_value_t = ContainerArg::Mp4)]
    container: ContainerArg,
    /// Audio only, in this format.
    #[arg(long, value_enum)]
    audio: Option<AudioArg>,
    /// Audio quality: best | original | 320 | 256 | 192 | 128 …
    #[arg(long, default_value = "best")]
    quality: String,
    /// Download the whole playlist.
    #[arg(long)]
    playlist: bool,
    /// Only the first N playlist entries.
    #[arg(long)]
    limit: Option<u32>,
    /// Cut: start here (83, 1:23, 1:23.5, 1h2m3s…). Default: the beginning.
    #[arg(long, value_parser = parse_time)]
    from: Option<f64>,
    /// Cut: stop here. Default: the end.
    #[arg(long, value_parser = parse_time)]
    to: Option<f64>,
    /// Cut on keyframes, keeping the original streams (faster, may start a bit early).
    #[arg(long)]
    fast_cut: bool,
    /// Print the yt-dlp command instead of running it.
    #[arg(long)]
    dry_run: bool,
}

fn parse_time(s: &str) -> Result<f64, String> {
    balader_core::cut::parse_timestamp(s).ok_or_else(|| format!("`{s}` isn't a time (try 83, 1:23 or 1:23.5)"))
}

fn print_json(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    // SAFETY: single-threaded at this point (before the core spawns anything).
    unsafe {
        if let Some(h) = &cli.home {
            std::env::set_var("BALADER_HOME", h);
        }
        if let Some(e) = &cli.engine_dir {
            std::env::set_var("BALADER_ENGINE_DIR", e);
        }
        if let Some(o) = &cli.out_dir {
            std::env::set_var("BALADER_OUTPUT_DIR", o);
        }
    }
    let level = if cli.verbose { "debug" } else { "warn" };
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(level)).format_target(false).init();

    let host = if matches!(cli.cmd, Cmd::Serve { .. }) { "http" } else { "cli" };
    let core = Core::start(CorePaths::standard(), host);
    let code = match run(&cli, core.clone()).await {
        Ok(code) => code,
        Err(e) => {
            if cli.json {
                print_json(&json!({ "error": e }));
            } else {
                eprintln!("✗ {}", e.message);
                if let Some(h) = &e.hint {
                    eprintln!("  {h}");
                }
                if cli.verbose {
                    if let Some(d) = &e.detail {
                        eprintln!("--- detail ---\n{d}");
                    }
                }
            }
            ExitCode::from(1)
        }
    };
    core.shutdown().await;
    code
}

async fn run(cli: &Cli, core: Arc<Core>) -> Result<ExitCode, balader_core::ErrorPayload> {
    match &cli.cmd {
        Cmd::Commands => {
            for c in balader_core::COMMANDS {
                println!("{c}");
            }
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Call { command, args } => {
            let args: Value = serde_json::from_str(args).map_err(|e| balader_core::ErrorPayload {
                code: balader_core::ErrorCode::BadRequest,
                message: format!("args must be JSON: {e}"),
                hint: None,
                detail: None,
            })?;
            let v = core.dispatch(command, args).await?;
            print_json(&v);
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Engine { action } => engine(cli, &core, action).await,
        Cmd::Probe { url } => {
            let v = core.dispatch("probe", json!({ "url": url })).await?;
            if cli.json {
                print_json(&v);
            } else {
                let r: ProbeResult = serde_json::from_value(v).expect("probe shape");
                print_probe(&r);
            }
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Download(args) => download(cli, &core, args).await,
        Cmd::Serve { port, token, origin } => {
            serve::serve(core, *port, token.clone(), origin.clone()).await;
            Ok(ExitCode::SUCCESS)
        }
    }
}

async fn engine(cli: &Cli, core: &Arc<Core>, action: &EngineCmd) -> Result<ExitCode, balader_core::ErrorPayload> {
    let mut progress = (!cli.json).then(|| spawn_install_printer(core));
    let v = match action {
        EngineCmd::Status => core.dispatch("engine_status", json!({ "refresh": true })).await?,
        EngineCmd::Install { components, force } => core.dispatch("engine_install", json!({ "components": components, "force": force })).await?,
        EngineCmd::Check => core.dispatch("engine_check_updates", Value::Null).await?,
        EngineCmd::Update => {
            let st = core.dispatch("engine_check_updates", Value::Null).await?;
            let stale: Vec<String> = st["components"]
                .as_array()
                .map(|a| a.iter().filter(|c| c["updateAvailable"] == true).filter_map(|c| c["id"].as_str().map(String::from)).collect())
                .unwrap_or_default();
            if stale.is_empty() {
                st
            } else {
                core.dispatch("engine_install", json!({ "components": stale, "force": true })).await?
            }
        }
    };
    if let Some(h) = progress.take() {
        h.abort();
    }
    if cli.json {
        print_json(&v);
    } else {
        print_engine(&v);
    }
    Ok(if v["ready"] == true { ExitCode::SUCCESS } else { ExitCode::from(2) })
}

fn spawn_install_printer(core: &Arc<Core>) -> tokio::task::JoinHandle<()> {
    let mut rx = core.subscribe();
    let tty = std::io::stderr().is_terminal();
    tokio::spawn(async move {
        let mut last: Option<(String, String, u64)> = None;
        while let Ok(ev) = rx.recv().await {
            if let CoreEvent::EngineProgress { component, stage, downloaded, total, message } = ev {
                let pct_n = total.filter(|t| *t > 0).map(|t| downloaded * 100 / t);
                let pct = pct_n.map(|p| format!(" {p:>3}%")).unwrap_or_default();
                let size = if downloaded > 0 { format!(" {}", util::human_bytes(downloaded)) } else { String::new() };
                let msg = message.map(|m| format!(" {m}")).unwrap_or_default();
                let stage_s = format!("{stage:?}").to_lowercase();
                let line = format!("  {component:<7} {stage_s:<9}{pct}{size}{msg}");
                if tty {
                    eprint!("\r{line}          ");
                    if matches!(stage, balader_core::InstallStage::Done | balader_core::InstallStage::Error) {
                        eprintln!();
                    }
                    let _ = std::io::stderr().flush();
                } else {
                    // Piped (tests, CI): one line per stage and per 25%.
                    let bucket = pct_n.unwrap_or(0) / 25;
                    let key = (component.clone(), stage_s.clone(), bucket);
                    if last.as_ref() != Some(&key) {
                        eprintln!("{line}");
                        last = Some(key);
                    }
                }
            }
        }
    })
}

fn print_engine(v: &Value) {
    println!("Engine  {}  ({} {})", v["engineDir"].as_str().unwrap_or(""), v["platform"].as_str().unwrap_or(""), v["arch"].as_str().unwrap_or(""));
    for c in v["components"].as_array().into_iter().flatten() {
        let state = c["state"].as_str().unwrap_or("?");
        let mark = match state {
            "ready" => "✓",
            "installing" => "…",
            _ if c["required"] == true => "✗",
            _ => "·",
        };
        let ver = c["version"].as_str().unwrap_or("-");
        let src = c["source"].as_str().unwrap_or("");
        let upd = if c["updateAvailable"] == true { format!("  → {} available", c["latest"].as_str().unwrap_or("?")) } else { String::new() };
        let err = c["error"].as_str().map(|e| format!("  ({e})")).unwrap_or_default();
        println!("  {mark} {:<8} {:<10} {:<22} {src}{upd}{err}", c["name"].as_str().unwrap_or(""), state, ver);
    }
    println!("  JS runtime: {}", v["jsRuntime"].as_str().unwrap_or("none (YouTube may lose formats)"));
    println!("  ready: {}", v["ready"]);
}

fn fmt_dur(s: Option<f64>) -> String {
    match s {
        Some(s) if s.is_finite() && s >= 0.0 => {
            let s = s.round() as u64;
            if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
        }
        _ => "--:--".into(),
    }
}

fn print_probe(r: &ProbeResult) {
    match r {
        ProbeResult::Video { media } => {
            println!("{}  [{}]", media.title, media.platform.name);
            println!("  by {}  ·  {}  ·  {} formats", media.uploader.as_deref().unwrap_or("?"), fmt_dur(media.duration), media.format_count);
            if media.tiers.is_empty() {
                println!("  (no video)");
            }
            for t in &media.tiers {
                let label = if t.label == 0 { "BEST".to_string() } else { format!("{}p{}", t.label, t.mp4.fps.filter(|f| *f > 30).map(|f| f.to_string()).unwrap_or_default()) };
                let side = |p: &balader_core::TierPick| {
                    let size = p.size.map(|s| format!("{}{}", if p.size_exact { "" } else { "~" }, util::human_bytes(s))).unwrap_or_else(|| "?".into());
                    let ids = match &p.audio_id {
                        Some(a) => format!("{}+{a}", p.video_id),
                        None => p.video_id.clone(),
                    };
                    format!("{}{}{} {size} ({ids})", p.vcodec, p.acodec.as_ref().map(|a| format!("+{a}")).unwrap_or_default(), if p.hdr { " HDR" } else { "" })
                };
                println!("  {label:<8} MP4: {:<40} MKV: {}", side(&t.mp4), side(&t.mkv));
            }
            let a = &media.audio;
            if a.available {
                let tracks: Vec<String> =
                    a.tracks.iter().map(|t| format!("{} {}k ({})", t.codec, t.abr.map(|b| b.round().to_string()).unwrap_or_else(|| "?".into()), t.format_id)).collect();
                println!("  audio: {}{}", if tracks.is_empty() { "from the video file".into() } else { tracks.join(", ") }, if a.from_combined { " (extracted)" } else { "" });
            }
            if !media.subtitles.is_empty() {
                println!("  subtitles: {}", media.subtitles.join(", "));
            }
        }
        ProbeResult::Playlist { playlist } => {
            println!("{}  [{} playlist · {} items]", playlist.title, playlist.platform.name, playlist.count);
            for (i, e) in playlist.entries.iter().take(15).enumerate() {
                println!("  {:>3}. {}  {}", i + 1, e.title.as_deref().unwrap_or("?"), fmt_dur(e.duration));
            }
            if playlist.count as usize > 15 {
                println!("  …");
            }
        }
        ProbeResult::Sniffed { page, candidates } => {
            println!("No extractor for {page}; the scraper found {} media URL(s):", candidates.len());
            for c in candidates {
                println!("  · {:<14} {}  ({})", c.label, c.url, c.source);
            }
        }
    }
}

/// Build the same request the UI builds after the user picks a card.
fn build_request(args: &DownloadArgs, probe: &ProbeResult) -> DownloadRequest {
    let container = match args.container {
        ContainerArg::Mp4 => Container::Mp4,
        ContainerArg::Mkv => Container::Mkv,
    };
    let mut req = DownloadRequest { url: args.url.clone(), container, audio_quality: args.quality.clone(), ..Default::default() };
    if let Some(a) = args.audio {
        req.mode = Mode::Audio;
        req.audio_format = match a {
            AudioArg::Mp3 => AudioFormat::Mp3,
            AudioArg::M4a => AudioFormat::M4a,
            AudioArg::Opus => AudioFormat::Opus,
            AudioArg::Flac => AudioFormat::Flac,
            AudioArg::Wav => AudioFormat::Wav,
        };
    }
    match probe {
        ProbeResult::Video { media } => {
            req.url = media.webpage_url.clone();
            req.title = Some(media.title.clone());
            req.thumbnail = media.thumbnail.clone();
            req.platform = Some(media.platform.clone());
            req.duration = media.duration;
            if req.mode == Mode::Video {
                let tier = match args.tier {
                    Some(t) => media.tiers.iter().filter(|x| x.label <= t).max_by_key(|x| x.label).or(media.tiers.last()),
                    None => media.tiers.first(),
                };
                if let Some(t) = tier {
                    let p = if container == Container::Mp4 { &t.mp4 } else { &t.mkv };
                    req.tier = (t.label > 0).then_some(t.label);
                    req.video_id = Some(p.video_id.clone());
                    req.audio_id = p.audio_id.clone();
                    req.combined = p.combined;
                    req.silent = p.silent;
                    req.pick_vcodec = Some(p.vcodec.clone());
                    req.pick_ext = Some(p.ext.clone());
                    req.expected_video = p.video_size;
                    req.expected_audio = p.audio_size;
                }
            } else {
                let fam = match req.audio_format {
                    AudioFormat::M4a => Some("AAC"),
                    AudioFormat::Opus => Some("Opus"),
                    _ => None,
                };
                let src = match fam {
                    Some(f) => media.audio.tracks.iter().find(|t| t.codec == f),
                    None => media.audio.best.as_ref(),
                };
                req.audio_source_id = src.map(|t| t.format_id.clone()).filter(|_| !media.audio.from_combined);
            }
        }
        ProbeResult::Playlist { playlist } => {
            req.url = playlist.webpage_url.clone();
            req.title = Some(playlist.title.clone());
            req.platform = Some(playlist.platform.clone());
            req.thumbnail = playlist.thumbnail.clone();
            req.playlist = true;
            req.playlist_count = Some(playlist.count);
            req.playlist_limit = args.limit;
            req.tier = args.tier;
        }
        ProbeResult::Sniffed { page, candidates } => {
            if let Some(c) = candidates.first() {
                req.url = c.url.clone();
                req.referer = Some(page.clone());
                req.title = Some(c.label.clone());
            }
        }
    }
    if (args.from.is_some() || args.to.is_some()) && !req.playlist {
        // No --to: up to the end. yt-dlp needs a real number, so the length
        // must be known (it is for nearly every site).
        if let Some(end) = args.to.or(req.duration) {
            req.cut = Some(balader_core::Cut { start: args.from.unwrap_or(0.0), end, exact: !args.fast_cut });
        } else {
            eprintln!("This one's length is unknown: give --to as well.");
            std::process::exit(2);
        }
    }
    req
}

async fn download(cli: &Cli, core: &Arc<Core>, args: &DownloadArgs) -> Result<ExitCode, balader_core::ErrorPayload> {
    let probe_v = core.dispatch("probe", json!({ "url": args.url })).await?;
    let probe: ProbeResult = serde_json::from_value(probe_v).expect("probe shape");
    let req = build_request(args, &probe);

    if args.dry_run {
        let settings = core.settings.get();
        let tmp = std::env::temp_dir().join("balader-dry-run");
        let home = PathBuf::from(&settings.output_dir);
        let print = tmp.join("files.txt");
        let mut full = core.engine.base_args();
        full.extend(selector::download_args(&req, &selector::ArgsContext { settings: &settings, home_dir: &home, temp_dir: &tmp, print_file: &print }));
        if cli.json {
            print_json(&json!({ "request": req, "args": full }));
        } else {
            println!("request: {}", serde_json::to_string(&req).unwrap_or_default());
            println!("yt-dlp {}", full.iter().map(|a| if a.contains(' ') { format!("'{a}'") } else { a.clone() }).collect::<Vec<_>>().join(" "));
        }
        return Ok(ExitCode::SUCCESS);
    }

    let mut rx = core.subscribe();
    let job = core.dispatch("start_download", json!({ "request": req })).await?;
    let id = job["id"].as_str().unwrap_or_default().to_string();
    if !cli.json {
        let cut = serde_json::from_value::<balader_core::Cut>(job["cut"].clone())
            .map(|c| format!(" · cut {} ({})", balader_core::cut::label(&c), if c.exact || req.mode == Mode::Audio { "exact" } else { "fast" }))
            .unwrap_or_default();
        eprintln!("▶ {}  ({}{cut})", job["title"].as_str().unwrap_or(""), job["summary"].as_str().unwrap_or(""));
    }
    let tty = std::io::stderr().is_terminal();
    let mut last_line: Option<(String, u32)> = None;
    loop {
        let ev = match rx.recv().await {
            Ok(ev) => ev,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => break,
        };
        let CoreEvent::Job { job } = ev else { continue };
        if job.id != id {
            continue;
        }
        if cli.json {
            println!("{}", serde_json::to_string(&job).unwrap_or_default());
        } else {
            let width = 24usize;
            let filled = ((job.progress * width as f64).round() as usize).min(width);
            let speed = job.speed.map(|s| format!("{}/s", util::human_bytes(s as u64))).unwrap_or_default();
            let eta = job.eta.map(|e| format!("ETA {}", fmt_dur(Some(e)))).unwrap_or_default();
            let item = match (job.item, job.items) {
                (Some(i), Some(n)) => format!(" [{i}/{n}]"),
                _ => String::new(),
            };
            let pct = (job.progress * 100.0).floor() as u32;
            let line = format!(
                "  [{}{}] {pct:>3}%  {:<20}{item} {speed:>11} {eta:<10}",
                "#".repeat(filled),
                "-".repeat(width - filled),
                job.stage_label.chars().take(20).collect::<String>()
            );
            if tty {
                eprint!("\r{line}   ");
                let _ = std::io::stderr().flush();
            } else {
                // Piped: one line per stage change or 10% step.
                let key = (job.stage.clone(), pct / 10);
                if last_line.as_ref() != Some(&key) {
                    eprintln!("{line}");
                    last_line = Some(key);
                }
            }
        }
        match job.status {
            JobStatus::Done => {
                if !cli.json {
                    eprintln!();
                    for f in &job.files {
                        println!("✓ {f}");
                    }
                    if job.files.is_empty() {
                        println!("✓ saved in {}", job.output_dir);
                    }
                }
                return Ok(ExitCode::SUCCESS);
            }
            JobStatus::Error => {
                if !cli.json {
                    eprintln!();
                }
                return Err(job.error.unwrap_or(balader_core::ErrorPayload {
                    code: balader_core::ErrorCode::Unknown,
                    message: "download failed".into(),
                    hint: None,
                    detail: None,
                }));
            }
            JobStatus::Cancelled => return Ok(ExitCode::from(130)),
            _ => {}
        }
    }
    Ok(ExitCode::from(1))
}
