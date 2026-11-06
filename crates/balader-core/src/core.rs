//! `Core` ties everything together and exposes ONE command contract:
//! `dispatch(cmd, json_args) -> json`. The Tauri app, the test HTTP server
//! (`balader serve`) and the CLI (`balader call`) all go through it, so a
//! command tested from the terminal behaves exactly like the button in the UI.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::download::JobManager;
use crate::engine::Engine;
use crate::error::{CoreError, ErrorCode, ErrorPayload, Result};
use crate::events::{CoreEvent, EventBus};
use crate::model::{AppInfo, DownloadRequest, Settings};
use crate::store::{HistoryStore, SettingsStore};
use crate::thumbs::Thumbs;
use crate::util::path_str;
use crate::{probe, sniff, util};

pub const IDENTIFIER: &str = "com.balader.desktop";

#[derive(Debug, Clone)]
pub struct CorePaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub engine_dir: PathBuf,
    pub default_output_dir: PathBuf,
}

impl CorePaths {
    /// The real per-user locations (shared by the app and the CLI, so the
    /// engine installed by one is used by the other).
    ///
    /// Overrides (handy for tests): `BALADER_HOME` puts config/data/cache
    /// under one folder, `BALADER_ENGINE_DIR` and `BALADER_OUTPUT_DIR` move
    /// the engine and the default download folder.
    pub fn standard() -> Self {
        let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        let mut paths = match std::env::var_os("BALADER_HOME") {
            Some(root) => Self::rooted(Path::new(&root)),
            None => {
                let data = dirs::data_local_dir().unwrap_or_else(|| home.clone()).join(IDENTIFIER);
                CorePaths {
                    config_dir: dirs::config_dir().unwrap_or_else(|| home.clone()).join(IDENTIFIER),
                    engine_dir: data.join("engine"),
                    data_dir: data,
                    cache_dir: dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join(IDENTIFIER),
                    default_output_dir: dirs::download_dir().unwrap_or_else(|| home.join("Downloads")).join("Balader"),
                }
            }
        };
        if let Some(e) = std::env::var_os("BALADER_ENGINE_DIR") {
            paths.engine_dir = PathBuf::from(e);
        }
        if let Some(o) = std::env::var_os("BALADER_OUTPUT_DIR") {
            paths.default_output_dir = PathBuf::from(o);
        }
        paths
    }

    /// Everything under one root (isolated test runs).
    pub fn rooted(root: &Path) -> Self {
        CorePaths {
            config_dir: root.join("config"),
            data_dir: root.join("data"),
            cache_dir: root.join("cache"),
            engine_dir: root.join("data").join("engine"),
            default_output_dir: root.join("Downloads"),
        }
    }
}

pub struct Core {
    pub paths: CorePaths,
    pub events: EventBus,
    pub engine: Arc<Engine>,
    pub settings: Arc<SettingsStore>,
    pub history: Arc<HistoryStore>,
    pub jobs: JobManager,
    thumbs: Thumbs,
    web: reqwest::Client,
    host: String,
    engine_checked: watch::Receiver<bool>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct EngineStatusArgs {
    refresh: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct InstallArgs {
    components: Vec<String>,
    force: bool,
}

#[derive(Deserialize)]
struct UrlArgs {
    url: String,
}

#[derive(Deserialize)]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
struct PathArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbArgs {
    url: String,
    referer: Option<String>,
}

#[derive(Deserialize)]
struct RequestArgs {
    request: DownloadRequest,
}

#[derive(Deserialize)]
struct SettingsArgs {
    settings: Settings,
}

fn parse<T: DeserializeOwned>(args: Value) -> Result<T> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|e| CoreError::coded(ErrorCode::BadRequest, format!("bad arguments: {e}")))
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

impl Core {
    /// Build the core. Returns immediately; the engine scan runs in the
    /// background (`engine_status` waits for it).
    pub fn start(paths: CorePaths, host: &str) -> Arc<Core> {
        for d in [&paths.config_dir, &paths.data_dir, &paths.cache_dir, &paths.engine_dir] {
            let _ = std::fs::create_dir_all(d);
        }
        let events = EventBus::new();
        let engine = Arc::new(Engine::new(paths.engine_dir.clone(), paths.cache_dir.clone(), events.clone()));
        let settings = Arc::new(SettingsStore::load(paths.config_dir.join("settings.json"), paths.default_output_dir.clone()));
        let history = Arc::new(HistoryStore::load(paths.data_dir.join("history.json")));
        let parts = paths.cache_dir.join("parts");
        // Leftovers from a crash: nothing can be resuming them now.
        let _ = std::fs::remove_dir_all(&parts);
        let _ = std::fs::remove_dir_all(paths.engine_dir.join(".staging"));
        let jobs = JobManager::new(events.clone(), engine.clone(), settings.clone(), history.clone(), parts);
        let web = reqwest::Client::builder()
            .user_agent(sniff::BROWSER_UA)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(40))
            .build()
            .expect("http client");
        let (tx, rx) = watch::channel(false);
        let core = Arc::new(Core {
            paths,
            events,
            engine,
            settings,
            history,
            jobs,
            thumbs: Thumbs::new(web.clone()),
            web,
            host: host.into(),
            engine_checked: rx,
        });
        let c = core.clone();
        tokio::spawn(async move {
            c.engine.refresh().await;
            let _ = tx.send(true);
            if c.settings.get().auto_update {
                c.auto_update().await;
            }
        });
        core
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<CoreEvent> {
        self.events.subscribe()
    }

    async fn wait_engine_checked(&self) {
        let mut rx = self.engine_checked.clone();
        let _ = tokio::time::timeout(Duration::from_secs(90), rx.wait_for(|v| *v)).await;
    }

    /// Keep yt-dlp fresh (sites break old versions within weeks). Only
    /// touches the managed copy and never while something is downloading.
    pub async fn auto_update(&self) {
        let status = self.engine.check_updates().await;
        let stale = status.components.iter().any(|c| c.id == "ytdlp" && c.update_available);
        if stale && self.jobs.active_count() == 0 {
            log::info!("auto-updating yt-dlp");
            if let Err(e) = self.engine.install(&["ytdlp".to_string()], true).await {
                log::warn!("auto-update failed: {e}");
            }
        }
    }

    pub fn app_info(&self) -> AppInfo {
        AppInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            platform: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            config_dir: path_str(&self.paths.config_dir),
            data_dir: path_str(&self.paths.data_dir),
            engine_dir: path_str(&self.paths.engine_dir),
            default_output_dir: path_str(&self.paths.default_output_dir),
            host: self.host.clone(),
        }
    }

    /// The single command contract. Errors come back as `ErrorPayload`.
    pub async fn dispatch(&self, cmd: &str, args: Value) -> std::result::Result<Value, ErrorPayload> {
        self.dispatch_inner(cmd, args).await.map_err(|e| e.payload())
    }

    async fn dispatch_inner(&self, cmd: &str, args: Value) -> Result<Value> {
        match cmd {
            "ping" => ok("pong"),
            "app_info" => ok(self.app_info()),

            "engine_status" => {
                let a: EngineStatusArgs = parse(args)?;
                self.wait_engine_checked().await;
                if a.refresh { ok(self.engine.refresh().await) } else { ok(self.engine.status()) }
            }
            "engine_install" => {
                let a: InstallArgs = parse(args)?;
                if a.force && self.jobs.active_count() > 0 {
                    return Err(CoreError::coded(ErrorCode::EngineBusy, "Downloads are running.").with_hint("Updates wait until the queue is empty."));
                }
                ok(self.engine.install(&a.components, a.force).await?)
            }
            "engine_check_updates" => ok(self.engine.check_updates().await),

            "probe" => {
                let a: UrlArgs = parse(args)?;
                self.wait_engine_checked().await;
                ok(probe::probe(&self.engine, &self.settings.get(), &self.web, &a.url).await?)
            }
            "sniff" => {
                let a: UrlArgs = parse(args)?;
                let url = probe::normalize_url(&a.url)?;
                ok(sniff::sniff(&self.web, &url).await?)
            }

            "start_download" => {
                let a: RequestArgs = parse(args)?;
                ok(self.jobs.enqueue(a.request)?)
            }
            "list_jobs" => ok(self.jobs.list()),
            "cancel_job" => ok(self.jobs.cancel(&parse::<IdArgs>(args)?.id)?),
            "retry_job" => ok(self.jobs.retry(&parse::<IdArgs>(args)?.id)?),
            "remove_job" => {
                self.jobs.remove(&parse::<IdArgs>(args)?.id)?;
                ok(true)
            }
            "clear_finished" => ok(self.jobs.clear_finished()),

            "get_settings" => ok(self.settings.get()),
            "save_settings" => {
                let a: SettingsArgs = parse(args)?;
                let saved = self.settings.save(a.settings)?;
                self.events.emit(CoreEvent::SettingsChanged { settings: saved.clone() });
                self.jobs.pump();
                ok(saved)
            }

            "get_history" => ok(self.history.list()),
            "remove_history" => {
                self.history.remove(&parse::<IdArgs>(args)?.id);
                self.events.emit(CoreEvent::HistoryChanged);
                ok(true)
            }
            "clear_history" => {
                self.history.clear();
                self.events.emit(CoreEvent::HistoryChanged);
                ok(true)
            }

            "thumbnail" => {
                let a: ThumbArgs = parse(args)?;
                ok(self.thumbs.get(&a.url, a.referer.as_deref()).await?)
            }
            "open_path" => {
                util::open_path(Path::new(&parse::<PathArgs>(args)?.path))?;
                ok(true)
            }
            "reveal_path" => {
                util::reveal_path(Path::new(&parse::<PathArgs>(args)?.path))?;
                ok(true)
            }
            "default_output_dir" => ok(path_str(&self.paths.default_output_dir)),

            other => Err(CoreError::coded(ErrorCode::BadRequest, format!("unknown command `{other}`"))),
        }
    }

    pub async fn shutdown(&self) {
        self.jobs.shutdown().await;
    }
}

/// Every command name the dispatcher understands (used by tests and the CLI's help).
pub const COMMANDS: &[&str] = &[
    "ping",
    "app_info",
    "engine_status",
    "engine_install",
    "engine_check_updates",
    "probe",
    "sniff",
    "start_download",
    "list_jobs",
    "cancel_job",
    "retry_job",
    "remove_job",
    "clear_finished",
    "get_settings",
    "save_settings",
    "get_history",
    "remove_history",
    "clear_history",
    "thumbnail",
    "open_path",
    "reveal_path",
    "default_output_dir",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("balader-core-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[tokio::test]
    async fn dispatcher_contract() {
        let core = Core::start(CorePaths::rooted(&isolated("dispatch")), "test");
        assert_eq!(core.dispatch("ping", Value::Null).await.unwrap(), json!("pong"));
        let info = core.dispatch("app_info", Value::Null).await.unwrap();
        assert_eq!(info["host"], "test");

        let bad = core.dispatch("nope", Value::Null).await.unwrap_err();
        assert_eq!(bad.code, ErrorCode::BadRequest);
        let bad_args = core.dispatch("probe", json!({"link": 1})).await.unwrap_err();
        assert_eq!(bad_args.code, ErrorCode::BadRequest);

        // Settings round-trip through the same JSON the UI sends.
        let mut s = core.dispatch("get_settings", Value::Null).await.unwrap();
        s["maxConcurrent"] = json!(3);
        s["container"] = json!("mkv");
        let saved = core.dispatch("save_settings", json!({ "settings": s })).await.unwrap();
        assert_eq!(saved["maxConcurrent"], 3);
        assert_eq!(saved["container"], "mkv");

        assert_eq!(core.dispatch("list_jobs", Value::Null).await.unwrap(), json!([]));
        let missing = core.dispatch("cancel_job", json!({"id": "nope"})).await.unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn every_listed_command_is_routed() {
        let core = Core::start(CorePaths::rooted(&isolated("routes")), "test");
        for cmd in COMMANDS {
            // Commands that touch the network/engine are skipped: only routing is checked here.
            if matches!(*cmd, "engine_status" | "engine_install" | "engine_check_updates" | "probe" | "sniff" | "thumbnail") {
                continue;
            }
            if let Err(e) = core.dispatch(cmd, json!({})).await {
                assert_ne!(e.message, format!("unknown command `{cmd}`"));
            }
        }
    }
}
