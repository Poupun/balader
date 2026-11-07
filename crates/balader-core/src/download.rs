//! The download queue. Jobs run as yt-dlp child processes (at most
//! `settings.max_concurrent` at once). Each job gets its own scratch folder
//! for partial files: cancelling deletes it, so the user's Downloads folder
//! never fills up with `.part` junk; retrying resumes from it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{Notify, mpsc};

use crate::cut;
use crate::engine::Engine;
use crate::error::{CoreError, ErrorCode, ErrorPayload, Result, classify_ytdlp_error};
use crate::events::{CoreEvent, EventBus};
use crate::model::{DownloadRequest, HistoryEntry, JobSnapshot, JobStatus, Mode};
use crate::progress::{Line, ProgressLine, parse_line, post_stage};
use crate::selector::{ArgsContext, active_cut, download_args};
use crate::store::{HistoryStore, SettingsStore};
use crate::util::{new_id, now_ms, path_str};
use crate::proc;

struct Job {
    snap: JobSnapshot,
    req: DownloadRequest,
    cancel: Arc<Notify>,
    cancel_requested: bool,
}

pub struct JobManager {
    inner: Arc<Inner>,
}

struct Inner {
    jobs: Mutex<Vec<Job>>,
    events: EventBus,
    engine: Arc<Engine>,
    settings: Arc<SettingsStore>,
    history: Arc<HistoryStore>,
    parts_dir: PathBuf,
}

pub fn summary_for(req: &DownloadRequest) -> String {
    if let Some(s) = req.summary.as_deref().filter(|s| !s.trim().is_empty()) {
        return s.to_string();
    }
    let core = match req.mode {
        Mode::Video => {
            let tier = req.tier.filter(|t| *t > 0).map(|t| format!("{t}p")).unwrap_or_else(|| "BEST".into());
            format!("{tier} · {}", req.container.ext().to_ascii_uppercase())
        }
        Mode::Audio => {
            let q = match req.audio_quality.as_str() {
                "" | "best" | "original" => "BEST".to_string(),
                n => format!("{}K", n.trim_end_matches(['k', 'K'])),
            };
            format!("{} · {q}", req.audio_format.label())
        }
    };
    if req.playlist {
        let n = req.playlist_limit.or(req.playlist_count).map(|n| format!("{n} · ")).unwrap_or_default();
        format!("Playlist · {n}{core}")
    } else {
        core
    }
}

impl JobManager {
    pub fn new(events: EventBus, engine: Arc<Engine>, settings: Arc<SettingsStore>, history: Arc<HistoryStore>, parts_dir: PathBuf) -> Self {
        JobManager { inner: Arc::new(Inner { jobs: Mutex::new(Vec::new()), events, engine, settings, history, parts_dir }) }
    }

    pub fn list(&self) -> Vec<JobSnapshot> {
        self.inner.jobs.lock().unwrap().iter().map(|j| j.snap.clone()).collect()
    }

    pub fn active_count(&self) -> usize {
        self.inner.jobs.lock().unwrap().iter().filter(|j| j.snap.status.is_active()).count()
    }

    pub fn enqueue(&self, mut req: DownloadRequest) -> Result<JobSnapshot> {
        req.url = crate::probe::normalize_url(&req.url)?;
        req.cut = if req.playlist { None } else { cut::normalize(req.cut, req.duration)? };
        self.inner.engine.ytdlp_path()?;
        let settings = self.inner.settings.get();
        let output_dir = if settings.output_dir.trim().is_empty() { self.inner.settings.default_output() } else { PathBuf::from(&settings.output_dir) };
        let snap = JobSnapshot {
            id: new_id("j"),
            url: req.url.clone(),
            title: req.title.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| req.url.clone()),
            thumbnail: req.thumbnail.clone(),
            platform: req.platform.clone(),
            mode: req.mode,
            summary: summary_for(&req),
            cut: req.cut,
            status: JobStatus::Queued,
            stage: "queued".into(),
            stage_label: "Waiting in line".into(),
            progress: 0.0,
            item: None,
            items: if req.playlist { req.playlist_limit.or(req.playlist_count) } else { None },
            part: None,
            parts: None,
            downloaded: 0,
            total: None,
            speed: None,
            eta: None,
            files: Vec::new(),
            output_dir: path_str(&output_dir),
            error: None,
            warnings: Vec::new(),
            already_existed: false,
            created_at: now_ms(),
            finished_at: None,
        };
        self.inner.jobs.lock().unwrap().push(Job { snap: snap.clone(), req, cancel: Arc::new(Notify::new()), cancel_requested: false });
        self.inner.events.emit(CoreEvent::Job { job: snap.clone() });
        Inner::pump(&self.inner);
        Ok(snap)
    }

    pub fn cancel(&self, id: &str) -> Result<JobSnapshot> {
        let mut jobs = self.inner.jobs.lock().unwrap();
        let job = jobs.iter_mut().find(|j| j.snap.id == id).ok_or_else(not_found)?;
        match job.snap.status {
            JobStatus::Queued => {
                job.snap.status = JobStatus::Cancelled;
                job.snap.stage = "cancelled".into();
                job.snap.stage_label = "Folded".into();
                job.snap.finished_at = Some(now_ms());
                self.inner.events.emit(CoreEvent::Job { job: job.snap.clone() });
            }
            s if s.is_running() => {
                job.cancel_requested = true;
                job.cancel.notify_one();
            }
            _ => {}
        }
        Ok(job.snap.clone())
    }

    pub fn retry(&self, id: &str) -> Result<JobSnapshot> {
        let snap = {
            let mut jobs = self.inner.jobs.lock().unwrap();
            let job = jobs.iter_mut().find(|j| j.snap.id == id).ok_or_else(not_found)?;
            if job.snap.status.is_active() {
                return Ok(job.snap.clone());
            }
            let s = &mut job.snap;
            s.status = JobStatus::Queued;
            s.stage = "queued".into();
            s.stage_label = "Waiting in line".into();
            s.progress = 0.0;
            s.error = None;
            s.warnings.clear();
            s.files.clear();
            s.downloaded = 0;
            s.total = None;
            s.speed = None;
            s.eta = None;
            s.finished_at = None;
            s.already_existed = false;
            job.cancel = Arc::new(Notify::new());
            job.cancel_requested = false;
            s.clone()
        };
        self.inner.events.emit(CoreEvent::Job { job: snap.clone() });
        Inner::pump(&self.inner);
        Ok(snap)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let running = {
            let jobs = self.inner.jobs.lock().unwrap();
            jobs.iter().find(|j| j.snap.id == id).map(|j| j.snap.status.is_running()).ok_or_else(not_found)?
        };
        if running {
            self.cancel(id)?;
        }
        self.inner.jobs.lock().unwrap().retain(|j| j.snap.id != id);
        if !running {
            let _ = std::fs::remove_dir_all(self.inner.parts_dir.join(id));
        }
        self.inner.events.emit(CoreEvent::JobRemoved { id: id.into() });
        Ok(())
    }

    pub fn clear_finished(&self) -> Vec<String> {
        let removed: Vec<String> = {
            let mut jobs = self.inner.jobs.lock().unwrap();
            let ids = jobs.iter().filter(|j| !j.snap.status.is_active()).map(|j| j.snap.id.clone()).collect();
            jobs.retain(|j| j.snap.status.is_active());
            ids
        };
        for id in &removed {
            let _ = std::fs::remove_dir_all(self.inner.parts_dir.join(id));
            self.inner.events.emit(CoreEvent::JobRemoved { id: id.clone() });
        }
        removed
    }

    /// Settings changed (max concurrency may be higher now).
    pub fn pump(&self) {
        Inner::pump(&self.inner);
    }

    /// Stop everything (app quitting). Waits a little for children to die.
    pub async fn shutdown(&self) {
        let ids: Vec<String> = self.inner.jobs.lock().unwrap().iter().filter(|j| j.snap.status.is_running()).map(|j| j.snap.id.clone()).collect();
        for id in &ids {
            let _ = self.cancel(id);
        }
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline && self.inner.jobs.lock().unwrap().iter().any(|j| j.snap.status.is_running()) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn not_found() -> CoreError {
    CoreError::coded(ErrorCode::NotFound, "No such download.")
}

enum Outcome {
    Done { files: Vec<String>, warnings: Vec<String>, already: bool },
    Cancelled,
}

impl Inner {
    fn pump(this: &Arc<Inner>) {
        let max = this.settings.get().max_concurrent.clamp(1, 6) as usize;
        let mut to_start = Vec::new();
        {
            let mut jobs = this.jobs.lock().unwrap();
            let running = jobs.iter().filter(|j| j.snap.status.is_running()).count();
            let free = max.saturating_sub(running);
            for job in jobs.iter_mut().filter(|j| j.snap.status == JobStatus::Queued).take(free) {
                job.snap.status = JobStatus::Starting;
                job.snap.stage = "extract".into();
                job.snap.stage_label = "Shuffling the deck".into();
                to_start.push((job.snap.clone(), job.req.clone(), job.cancel.clone()));
            }
        }
        for (snap, req, cancel) in to_start {
            this.events.emit(CoreEvent::Job { job: snap.clone() });
            let inner = this.clone();
            tokio::spawn(async move {
                let id = snap.id.clone();
                let result = inner.run(&snap, &req, &cancel).await;
                inner.finish(&id, result);
                Inner::pump(&inner);
            });
        }
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut JobSnapshot)) -> Option<JobSnapshot> {
        let mut jobs = self.jobs.lock().unwrap();
        let job = jobs.iter_mut().find(|j| j.snap.id == id)?;
        f(&mut job.snap);
        Some(job.snap.clone())
    }

    fn cancel_requested(&self, id: &str) -> bool {
        self.jobs.lock().unwrap().iter().find(|j| j.snap.id == id).is_some_and(|j| j.cancel_requested)
    }

    async fn run(&self, snap: &JobSnapshot, req: &DownloadRequest, cancel: &Notify) -> Result<Outcome> {
        let ytdlp = self.engine.ytdlp_path()?;
        let settings = self.settings.get();
        let home = PathBuf::from(&snap.output_dir);
        // yt-dlp never touches the user's folder: it works in a private
        // staging area and Balader moves the finished files itself. This way
        // an existing file can never be reused, overwritten or deleted by a
        // later grab with the same title (e.g. the audio of a saved video).
        let temp = self.parts_dir.join(&snap.id);
        let stage = temp.join("out");
        let parts = temp.join("parts");
        tokio::fs::create_dir_all(&home).await.map_err(|e| {
            CoreError::coded(ErrorCode::Io, format!("Can't write to {}: {e}", home.display())).with_hint("Pick another folder in Settings.")
        })?;
        tokio::fs::create_dir_all(&stage).await?;
        tokio::fs::create_dir_all(&parts).await?;
        let print_file = temp.join("files.txt");
        let _ = tokio::fs::remove_file(&print_file).await;

        let mut args = self.engine.base_args();
        args.extend(download_args(req, &ArgsContext { settings: &settings, home_dir: &stage, temp_dir: &parts, print_file: &print_file }));
        log::info!("job {} → yt-dlp {}", snap.id, args.join(" "));

        if self.cancel_requested(&snap.id) {
            let _ = tokio::fs::remove_dir_all(&temp).await;
            return Ok(Outcome::Cancelled);
        }

        let mut cmd = proc::command(&ytdlp);
        proc::isolate(&mut cmd);
        if let Some(ca) = self.engine.ca_bundle() {
            cmd.env("SSL_CERT_FILE", ca);
        }
        cmd.args(&args);
        let mut child = cmd.spawn()?;
        let (tx, mut rx) = mpsc::channel::<(bool, String)>(512);
        spawn_reader(child.stdout.take(), tx.clone(), false);
        spawn_reader(child.stderr.take(), tx, true);

        let mut state = RunState::new(req);
        let mut stderr_buf = String::new();
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut cancelled = false;

        loop {
            tokio::select! {
                biased;
                _ = cancel.notified() => {
                    cancelled = true;
                    proc::kill_tree(&mut child).await;
                    break;
                }
                msg = rx.recv() => {
                    let Some((is_err, text)) = msg else { break };
                    let line = parse_line(&text);
                    // Keep the tail (errors come last), minus FFmpeg's stats chatter.
                    if is_err && !matches!(line, Line::Ffmpeg { .. }) {
                        push_tail(&mut stderr_buf, &text, 64_000);
                    }
                    let stage_changed = state.apply(line);
                    if stage_changed || last_emit.elapsed() >= Duration::from_millis(125) {
                        last_emit = Instant::now();
                        if let Some(s) = self.update(&snap.id, |s| state.write(s)) {
                            self.events.emit(CoreEvent::Job { job: s });
                        }
                    }
                }
            }
        }

        if cancelled {
            let _ = tokio::fs::remove_dir_all(&temp).await;
            return Ok(Outcome::Cancelled);
        }

        let status = tokio::select! {
            s = child.wait() => s?,
            _ = cancel.notified() => {
                proc::kill_tree(&mut child).await;
                let _ = tokio::fs::remove_dir_all(&temp).await;
                return Ok(Outcome::Cancelled);
            }
        };

        let mut staged: Vec<PathBuf> = Vec::new();
        if let Ok(text) = tokio::fs::read_to_string(&print_file).await {
            for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                let p = PathBuf::from(line);
                if !staged.contains(&p) && p.exists() {
                    staged.push(p);
                }
            }
        }
        for p in &state.already {
            let p = PathBuf::from(p);
            if !staged.contains(&p) && p.exists() && p.starts_with(&stage) {
                staged.push(p);
            }
        }

        if status.success() || !staged.is_empty() {
            if let Some(s) = self.update(&snap.id, |s| {
                s.status = JobStatus::Processing;
                s.stage = "move".into();
                s.stage_label = "Moving to folder".into();
            }) {
                self.events.emit(CoreEvent::Job { job: s });
            }
            let (stage_c, home_c) = (stage.clone(), home.clone());
            let files = tokio::task::spawn_blocking(move || deliver(&staged, &stage_c, &home_c))
                .await
                .map_err(|e| CoreError::coded(ErrorCode::Io, format!("move task failed: {e}")))??;
            let mut warnings = state.warnings.clone();
            if !status.success() {
                warnings.extend(state.errors.iter().cloned());
            }
            let _ = tokio::fs::remove_dir_all(&temp).await;
            return Ok(Outcome::Done { files, warnings, already: false });
        }
        Err(classify_ytdlp_error(&stderr_buf))
    }

    fn finish(&self, id: &str, result: Result<Outcome>) {
        let snap = self.update(id, |s| {
            s.finished_at = Some(now_ms());
            s.speed = None;
            s.eta = None;
            match &result {
                Ok(Outcome::Done { files, warnings, already }) => {
                    s.status = JobStatus::Done;
                    s.stage = "done".into();
                    s.stage_label = if *already { "Already in your stash".into() } else { "Saved".into() };
                    s.progress = 1.0;
                    s.files = files.clone();
                    s.warnings = warnings.iter().take(8).cloned().collect();
                    s.already_existed = *already;
                    if let Some(t) = s.total {
                        s.downloaded = t;
                    }
                }
                Ok(Outcome::Cancelled) => {
                    s.status = JobStatus::Cancelled;
                    s.stage = "cancelled".into();
                    s.stage_label = "Folded".into();
                }
                Err(e) => {
                    let p: ErrorPayload = e.payload();
                    s.status = JobStatus::Error;
                    s.stage = "error".into();
                    s.stage_label = p.message.clone();
                    s.error = Some(p);
                }
            }
        });
        let Some(snap) = snap else { return };
        if snap.status == JobStatus::Done {
            let size = snap.files.iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| m.len()).sum();
            self.history.add(HistoryEntry {
                id: snap.id.clone(),
                url: snap.url.clone(),
                title: snap.title.clone(),
                thumbnail: snap.thumbnail.clone(),
                platform: snap.platform.clone(),
                mode: snap.mode,
                summary: snap.summary.clone(),
                cut: snap.cut,
                files: snap.files.clone(),
                size,
                finished_at: snap.finished_at.unwrap_or_else(now_ms),
            });
            self.events.emit(CoreEvent::HistoryChanged);
        }
        self.events.emit(CoreEvent::Job { job: snap });
    }
}

/// `Title.mp4` → `Title (2).mp4`, `Title (3).mp4`… until the name is free.
pub(crate) fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    for n in 2..10_000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} ({}){ext}", crate::util::now_ms()))
}

/// Rename, or copy + delete when the destination is on another volume.
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(from, to)?;
            std::fs::remove_file(from)
        }
    }
}

/// Move staged results into the user's folder, keeping playlist sub-folders,
/// never overwriting anything that's already there.
pub(crate) fn deliver(staged: &[PathBuf], stage: &Path, home: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for f in staged {
        let rel = f.strip_prefix(stage).map(Path::to_path_buf).unwrap_or_else(|_| PathBuf::from(f.file_name().unwrap_or_default()));
        let dest = unique_path(&home.join(rel));
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)?;
        }
        move_file(f, &dest).map_err(|e| CoreError::coded(ErrorCode::Io, format!("Couldn't move the file into {}: {e}", home.display())))?;
        out.push(path_str(&dest));
    }
    Ok(out)
}

fn spawn_reader<R: AsyncRead + Unpin + Send + 'static>(pipe: Option<R>, tx: mpsc::Sender<(bool, String)>, is_err: bool) {
    let Some(mut pipe) = pipe else { return };
    tokio::spawn(async move {
        let mut chunk = vec![0u8; 16 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match pipe.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&chunk[..n]);
            for piece in take_pieces(&mut pending) {
                if tx.send((is_err, piece)).await.is_err() {
                    return;
                }
            }
            if pending.len() > 1 << 20 {
                pending.clear();
            }
        }
        let rest = String::from_utf8_lossy(&pending).trim_end().to_string();
        if !rest.trim().is_empty() {
            let _ = tx.send((is_err, rest)).await;
        }
    });
}

/// Cut complete pieces off the front of `pending`. yt-dlp ends its lines with
/// `\n`; FFmpeg redraws its stats line with `\r`, so both end a piece (and a
/// stats update arrives as it happens, not when FFmpeg finally prints `\n`).
pub(crate) fn take_pieces(pending: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = pending.iter().position(|b| *b == b'\n' || *b == b'\r') {
        let piece: Vec<u8> = pending.drain(..=pos).collect();
        let text = String::from_utf8_lossy(&piece[..piece.len() - 1]).trim_end().to_string();
        if !text.trim().is_empty() {
            out.push(text);
        }
    }
    out
}

/// Append a line, keeping only the last `max` bytes (on a char boundary).
fn push_tail(buf: &mut String, line: &str, max: usize) {
    buf.push_str(line);
    buf.push('\n');
    if buf.len() > max + max / 2 {
        let mut cut_at = buf.len() - max;
        while !buf.is_char_boundary(cut_at) {
            cut_at += 1;
        }
        buf.drain(..cut_at);
    }
}

// ------------------------------------------------------------ progress state

pub(crate) struct RunState {
    mode: Mode,
    audio_label: &'static str,
    expected: HashMap<String, u64>,
    formats: Vec<String>,
    frac: HashMap<String, f64>,
    totals: HashMap<String, f64>,
    item: u32,
    items: u32,
    stage: String,
    stage_label: String,
    processing: bool,
    overall: f64,
    speed: Option<f64>,
    eta: Option<f64>,
    pub(crate) warnings: Vec<String>,
    pub(crate) errors: Vec<String>,
    pub(crate) already: Vec<String>,
    pub(crate) downloaded_any: bool,
    current_part: Option<u32>,
    /// Clip length when cutting: FFmpeg reports its position in the clip.
    cut_len: Option<f64>,
    cut_label: &'static str,
    cut_started: bool,
    cut_frac: f64,
    cut_bytes: u64,
    cut_eta: Option<f64>,
    cut_bps: Option<f64>,
    cut_last: Option<(Instant, u64)>,
}

impl RunState {
    pub(crate) fn new(req: &DownloadRequest) -> Self {
        let mut expected = HashMap::new();
        if let (Some(v), Some(n)) = (&req.video_id, req.expected_video) {
            expected.insert(v.clone(), n);
        }
        if let (Some(a), Some(n)) = (&req.audio_id, req.expected_audio) {
            expected.insert(a.clone(), n);
        }
        RunState {
            mode: req.mode,
            audio_label: req.audio_format.label(),
            expected,
            formats: Vec::new(),
            frac: HashMap::new(),
            totals: HashMap::new(),
            item: 1,
            items: if req.playlist { req.playlist_limit.or(req.playlist_count).unwrap_or(1).max(1) } else { 1 },
            stage: "extract".into(),
            stage_label: "Shuffling the deck".into(),
            processing: false,
            overall: 0.0,
            speed: None,
            eta: None,
            warnings: Vec::new(),
            errors: Vec::new(),
            already: Vec::new(),
            downloaded_any: false,
            current_part: None,
            cut_len: active_cut(req).map(|c| c.end - c.start).filter(|l| *l > 0.0),
            cut_label: if req.mode == Mode::Audio { "Cutting the track" } else { "Cutting the clip" },
            cut_started: false,
            cut_frac: 0.0,
            cut_bytes: 0,
            cut_eta: None,
            cut_bps: None,
            cut_last: None,
        }
    }

    fn set_stage(&mut self, key: &str, label: impl Into<String>) -> bool {
        let label = label.into();
        if self.stage == key && self.stage_label == label {
            return false;
        }
        self.stage = key.into();
        self.stage_label = label;
        true
    }

    /// Returns true when the stage changed (worth an immediate UI update).
    pub(crate) fn apply(&mut self, line: Line) -> bool {
        match line {
            Line::Progress(p) => self.on_progress(&p),
            Line::Formats(list) => {
                self.formats = list;
                self.frac.clear();
                self.totals.clear();
                self.processing = false;
                false
            }
            Line::Item { index, count } => {
                self.item = index.max(1);
                self.items = count.max(1);
                self.formats.clear();
                self.frac.clear();
                self.totals.clear();
                self.processing = false;
                self.set_stage("extract", format!("Reading card {} of {}", self.item, self.items))
            }
            Line::Extract { .. } if self.stage == "extract" || self.stage == "queued" => self.set_stage("extract", "Shuffling the deck"),
            Line::Ffmpeg { time, size, speed } => self.on_cut_stats(time, size, speed),
            Line::Post { name, .. } => {
                // Some steps (thumbnail conversion) run *before* the download:
                // they must not push the bar to the post-processing zone.
                if self.frac.is_empty() && !self.cut_started {
                    return self.set_stage("extract", "Preparing");
                }
                self.processing = true;
                self.speed = None;
                self.eta = None;
                let (key, label) = post_stage(&name);
                let label = if key == "convert" { format!("Converting to {}", self.audio_label) } else { label.to_string() };
                self.set_stage(key, label)
            }
            Line::AlreadyDownloaded(path) => {
                self.already.push(path);
                self.frac.insert("_already".into(), 1.0);
                self.set_stage("done", "Already in your stash")
            }
            Line::Error(msg) => {
                self.errors.push(msg);
                false
            }
            Line::Warning(msg) => {
                if self.warnings.len() < 8 && !msg.to_ascii_lowercase().contains("not supported between instances") {
                    self.warnings.push(msg);
                }
                false
            }
            _ => false,
        }
    }

    /// FFmpeg is cutting: its clock position over the clip length is the progress.
    fn on_cut_stats(&mut self, time: Option<f64>, size: Option<u64>, speed: Option<f64>) -> bool {
        let Some(len) = self.cut_len else { return false };
        if self.processing {
            return false;
        }
        if let Some(t) = time {
            self.cut_frac = self.cut_frac.max((t / len).clamp(0.0, 1.0));
            self.cut_eta = speed.map(|x| (len - t).max(0.0) / x);
        }
        if let Some(b) = size {
            let now = Instant::now();
            match self.cut_last {
                Some((t0, b0)) => {
                    let dt = now.duration_since(t0).as_secs_f64();
                    if dt >= 0.2 && b >= b0 {
                        let rate = (b - b0) as f64 / dt;
                        self.cut_bps = Some(self.cut_bps.map_or(rate, |prev| prev * 0.6 + rate * 0.4));
                        self.cut_last = Some((now, b));
                    }
                }
                None => self.cut_last = Some((now, b)),
            }
            self.cut_bytes = self.cut_bytes.max(b);
            if b > 0 {
                self.downloaded_any = true;
            }
        }
        self.cut_started = true;
        let label = self.cut_label;
        self.set_stage("cut", label)
    }

    fn on_progress(&mut self, p: &ProgressLine) -> bool {
        if self.cut_len.is_some() {
            // Cutting: yt-dlp reports once, when FFmpeg is done (format "299+140").
            if let Some(f) = p.fraction() {
                self.cut_frac = self.cut_frac.max(f);
            }
            if let Some(t) = p.total() {
                self.cut_bytes = self.cut_bytes.max(t as u64);
            }
            self.cut_started = true;
            let label = self.cut_label;
            return self.set_stage("cut", label);
        }
        if let (Some(i), Some(n)) = (p.i.playlist_index, p.i.n_entries.or(p.i.playlist_count)) {
            if i >= 1.0 && n >= 1.0 {
                self.item = i as u32;
                self.items = self.items.max(n as u32);
            }
        }
        let fmt = p.i.format_id.clone().unwrap_or_else(|| "_".into());
        let known = self.formats.is_empty() || self.formats.contains(&fmt);
        if !known {
            // Subtitles or other side files.
            return self.set_stage("subs", "Fetching subtitles");
        }
        if self.formats.is_empty() {
            self.formats.push(fmt.clone());
        }
        let frac = p.fraction().unwrap_or(0.0);
        self.frac.insert(fmt.clone(), frac);
        if let Some(t) = p.total() {
            self.totals.insert(fmt.clone(), t);
        }
        if p.p.downloaded_bytes.unwrap_or(0.0) > 0.0 {
            self.downloaded_any = true;
        }
        self.speed = p.p.speed.filter(|s| *s > 0.0);
        self.eta = p.p.eta.filter(|e| *e >= 0.0);
        self.current_part = self.formats.iter().position(|f| *f == fmt).map(|i| i as u32 + 1);
        self.processing = false;
        let (key, label) = match self.mode {
            Mode::Audio => ("audio", "Downloading audio"),
            Mode::Video if self.formats.len() > 1 && p.is_audio_only() => ("audio", "Downloading audio"),
            Mode::Video if self.formats.len() > 1 && p.is_video() => ("video", "Downloading video"),
            Mode::Video => ("media", "Downloading"),
        };
        self.set_stage(key, label)
    }

    fn weights(&self) -> Vec<f64> {
        let sizes: Vec<Option<f64>> =
            self.formats.iter().map(|f| self.expected.get(f).map(|v| *v as f64).or_else(|| self.totals.get(f).copied())).collect();
        if sizes.iter().all(|s| s.is_some_and(|v| v > 0.0)) {
            sizes.into_iter().map(|s| s.unwrap()).collect()
        } else {
            // Video first, audio second: audio is roughly a tenth of the bytes.
            (0..self.formats.len()).map(|i| if i == 0 { 9.0 } else { 1.0 }).collect()
        }
    }

    fn item_fraction(&self) -> f64 {
        if self.frac.contains_key("_already") {
            return 1.0;
        }
        if self.cut_len.is_some() {
            return self.cut_frac;
        }
        if self.formats.len() <= 1 {
            return self.frac.values().copied().fold(0.0, f64::max);
        }
        let w = self.weights();
        let sum: f64 = w.iter().sum();
        if sum <= 0.0 {
            return 0.0;
        }
        self.formats.iter().zip(w.iter()).map(|(f, w)| self.frac.get(f).copied().unwrap_or(0.0) * w).sum::<f64>() / sum
    }

    fn bytes(&self) -> (u64, Option<u64>) {
        if self.cut_len.is_some() {
            // The clip's final size is only known once it's written.
            return (self.cut_bytes, (self.cut_frac >= 1.0 && self.cut_bytes > 0).then_some(self.cut_bytes));
        }
        let mut done = 0.0;
        let mut total = 0.0;
        let mut all_known = !self.formats.is_empty();
        for f in &self.formats {
            let t = self.totals.get(f).copied().or_else(|| self.expected.get(f).map(|v| *v as f64));
            match t {
                Some(t) => {
                    total += t;
                    done += t * self.frac.get(f).copied().unwrap_or(0.0);
                }
                None => all_known = false,
            }
        }
        (done as u64, if all_known && total > 0.0 { Some(total as u64) } else { None })
    }

    pub(crate) fn progress(&mut self) -> f64 {
        let in_item = if self.processing { 0.97 } else { self.item_fraction() * 0.94 };
        let raw = ((self.item.saturating_sub(1)) as f64 + in_item) / self.items.max(1) as f64;
        self.overall = self.overall.max(raw.clamp(0.0, 0.99));
        self.overall
    }

    pub(crate) fn write(&mut self, s: &mut JobSnapshot) {
        s.progress = self.progress();
        s.status = if self.processing { JobStatus::Processing } else if self.stage == "extract" { JobStatus::Starting } else { JobStatus::Downloading };
        s.stage = self.stage.clone();
        s.stage_label = self.stage_label.clone();
        let (done, total) = self.bytes();
        s.downloaded = done;
        s.total = total;
        s.speed = self.speed;
        s.eta = match (total, self.speed) {
            (Some(t), Some(sp)) if sp > 0.0 && self.formats.len() > 1 => Some(((t.saturating_sub(done)) as f64 / sp).max(0.0)),
            _ => self.eta,
        };
        s.parts = if self.formats.len() > 1 { Some(self.formats.len() as u32) } else { None };
        s.part = if self.formats.len() > 1 { self.current_part } else { None };
        if self.cut_len.is_some() {
            // One FFmpeg pass reads video and audio together: no parts.
            s.speed = if self.processing { None } else { self.cut_bps };
            s.eta = if self.processing { None } else { self.cut_eta };
            s.parts = None;
            s.part = None;
        }
        if self.items > 1 {
            s.item = Some(self.item);
            s.items = Some(self.items);
        }
        s.warnings = self.warnings.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AudioFormat, Container, Cut};

    fn snap() -> JobSnapshot {
        JobSnapshot {
            id: "j1".into(),
            url: "u".into(),
            title: "t".into(),
            thumbnail: None,
            platform: None,
            mode: Mode::Video,
            summary: String::new(),
            cut: None,
            status: JobStatus::Starting,
            stage: "extract".into(),
            stage_label: String::new(),
            progress: 0.0,
            item: None,
            items: None,
            part: None,
            parts: None,
            downloaded: 0,
            total: None,
            speed: None,
            eta: None,
            files: vec![],
            output_dir: String::new(),
            error: None,
            warnings: vec![],
            already_existed: false,
            created_at: 0,
            finished_at: None,
        }
    }

    fn prog(fmt: &str, v: &str, a: &str, done: u64, total: u64) -> Line {
        parse_line(&format!(
            r#"BLDR {{"p":{{"status":"downloading","downloaded_bytes":{done},"total_bytes":{total},"speed":1000000}},"i":{{"format_id":"{fmt}","vcodec":"{v}","acodec":"{a}"}}}}"#
        ))
    }

    #[test]
    fn two_part_progress_is_weighted_and_monotonic() {
        let req = DownloadRequest {
            mode: Mode::Video,
            container: Container::Mp4,
            video_id: Some("299".into()),
            audio_id: Some("140".into()),
            expected_video: Some(90_000_000),
            expected_audio: Some(10_000_000),
            ..Default::default()
        };
        let mut st = RunState::new(&req);
        let mut s = snap();
        st.apply(parse_line("[youtube] x: Downloading webpage"));
        st.apply(parse_line("[info] x: Downloading 1 format(s): 299+140"));
        assert!(st.apply(prog("299", "avc1", "none", 45_000_000, 90_000_000)), "stage changes to video");
        st.write(&mut s);
        assert_eq!(s.stage, "video");
        assert_eq!(s.status, JobStatus::Downloading);
        assert!((s.progress - 0.45 * 0.94).abs() < 1e-6, "{}", s.progress);
        assert_eq!(s.part, Some(1));
        assert_eq!(s.parts, Some(2));

        st.apply(prog("299", "avc1", "none", 90_000_000, 90_000_000));
        st.apply(prog("140", "none", "mp4a", 5_000_000, 10_000_000));
        st.write(&mut s);
        assert_eq!(s.stage, "audio");
        assert!((s.progress - 0.95 * 0.94).abs() < 1e-6, "{}", s.progress);
        assert_eq!(s.downloaded, 95_000_000);
        assert_eq!(s.total, Some(100_000_000));
        let before = s.progress;

        st.apply(parse_line("[Merger] Merging formats into \"/out/a.mp4\""));
        st.write(&mut s);
        assert_eq!(s.status, JobStatus::Processing);
        assert_eq!(s.stage, "merge");
        assert!(s.progress >= before);
    }

    #[test]
    fn playlist_progress_spans_items() {
        let req = DownloadRequest { mode: Mode::Audio, audio_format: AudioFormat::Mp3, playlist: true, playlist_count: Some(4), ..Default::default() };
        let mut st = RunState::new(&req);
        let mut s = snap();
        st.apply(parse_line("[download] Downloading item 3 of 4"));
        st.apply(parse_line("[info] y: Downloading 1 format(s): 251"));
        st.apply(prog("251", "none", "opus", 50, 100));
        st.write(&mut s);
        assert_eq!(s.item, Some(3));
        assert_eq!(s.items, Some(4));
        assert!((s.progress - (2.0 + 0.5 * 0.94) / 4.0).abs() < 1e-6);
        st.apply(parse_line("[ExtractAudio] Destination: /out/y.mp3"));
        st.write(&mut s);
        assert_eq!(s.stage_label, "Converting to MP3");
    }

    #[test]
    fn early_thumbnail_conversion_is_not_post_processing() {
        let req = DownloadRequest { mode: Mode::Audio, ..Default::default() };
        let mut st = RunState::new(&req);
        let mut s = snap();
        st.apply(parse_line("[ThumbnailsConvertor] Converting thumbnail \"x.webp\" to jpg"));
        st.apply(parse_line("[info] x: Downloading 1 format(s): hls_aac_160k"));
        st.apply(prog("hls_aac_160k", "none", "mp4a", 10, 100));
        st.write(&mut s);
        assert_eq!(s.status, JobStatus::Downloading);
        assert!(s.progress < 0.2, "{}", s.progress);
    }

    #[test]
    fn side_files_do_not_move_the_bar() {
        let req = DownloadRequest { mode: Mode::Video, ..Default::default() };
        let mut st = RunState::new(&req);
        let mut s = snap();
        st.apply(parse_line("[info] x: Downloading 1 format(s): 22"));
        st.apply(prog("22", "avc1", "mp4a", 10, 100));
        st.apply(prog("en", "none", "none", 1, 2));
        st.write(&mut s);
        assert_eq!(s.stage, "subs");
        assert!((s.progress - 0.1 * 0.94).abs() < 1e-6);
    }

    #[test]
    fn cut_progress_follows_ffmpeg() {
        let req = DownloadRequest {
            mode: Mode::Video,
            video_id: Some("299".into()),
            audio_id: Some("140".into()),
            expected_video: Some(90_000_000),
            expected_audio: Some(10_000_000),
            cut: Some(Cut { start: 10.0, end: 30.0, exact: true }),
            ..Default::default()
        };
        let mut st = RunState::new(&req);
        let mut s = snap();
        st.apply(parse_line("[ThumbnailsConvertor] Converting thumbnail \"x.webp\" to jpg"));
        st.apply(parse_line("[info] x: Downloading 1 format(s): 299+140"));
        st.apply(parse_line("[info] x: Downloading 1 time ranges: 10.0-30.0"));
        st.apply(parse_line("[download] Destination: /stage/x (10s-30s).mp4"));
        st.write(&mut s);
        assert_eq!(s.status, JobStatus::Starting, "{}", s.stage_label);
        assert!(s.progress < 0.01);

        assert!(st.apply(parse_line("frame=  259 fps=171 q=26.0 size=    1024KiB time=00:00:05.00 bitrate=1911.4kbits/s speed=2.5x")));
        st.write(&mut s);
        assert_eq!(s.stage, "cut");
        assert_eq!(s.stage_label, "Cutting the clip");
        assert_eq!(s.status, JobStatus::Downloading);
        assert!((s.progress - 0.25 * 0.94).abs() < 1e-9, "{}", s.progress);
        assert_eq!(s.downloaded, 1024 * 1024);
        assert_eq!(s.total, None, "a clip's size is unknown until it's written");
        assert_eq!(s.eta, Some(6.0), "15 s of clip left at 2.5x");
        assert_eq!((s.part, s.parts), (None, None), "one FFmpeg pass, no parts");

        // yt-dlp's single report at the end carries the merged format id.
        st.apply(parse_line(r#"BLDR {"p":{"status":"finished","downloaded_bytes":7789051,"total_bytes":7789051},"i":{"format_id":"299+140","vcodec":"avc1","acodec":"mp4a"}}"#));
        st.write(&mut s);
        assert_eq!(s.stage, "cut", "not mistaken for subtitles");
        assert!((s.progress - 0.94).abs() < 1e-9, "{}", s.progress);
        assert_eq!(s.total, Some(7_789_051));

        st.apply(parse_line("[EmbedThumbnail] ffmpeg: Adding thumbnail to \"x.mp4\""));
        st.write(&mut s);
        assert_eq!(s.status, JobStatus::Processing);
        assert_eq!(s.stage, "embed");
        assert!(s.progress >= 0.94);
        assert_eq!(s.speed, None);
    }

    #[test]
    fn audio_cut_label_and_playlists_ignore_cuts() {
        let cut = Some(Cut { start: 0.0, end: 8.0, exact: true });
        let mut st = RunState::new(&DownloadRequest { mode: Mode::Audio, cut, ..Default::default() });
        let mut s = snap();
        st.apply(parse_line("size=     256KiB time=00:00:02.00 bitrate= 209.7kbits/s speed=20x"));
        st.write(&mut s);
        assert_eq!(s.stage_label, "Cutting the track");
        assert!((s.progress - 0.25 * 0.94).abs() < 1e-9);
        // Playlists never cut, so FFmpeg stats (from elsewhere) change nothing.
        let mut st = RunState::new(&DownloadRequest { mode: Mode::Audio, playlist: true, cut, ..Default::default() });
        assert!(!st.apply(parse_line("size=     256KiB time=00:00:02.00 bitrate= 209.7kbits/s speed=20x")));
    }

    #[test]
    fn pieces_split_on_cr_and_lf() {
        let mut pending = b"[download] Destination: a.mp4\nframe= 1 time=00:00:01.00\rframe= 2 time=00:00:02.00\rpartial".to_vec();
        assert_eq!(take_pieces(&mut pending), vec!["[download] Destination: a.mp4", "frame= 1 time=00:00:01.00", "frame= 2 time=00:00:02.00"]);
        assert_eq!(pending, b"partial");
        // CRLF makes no empty pieces; multi-byte characters survive.
        let mut pending = "Éclair ☕\r\n".as_bytes().to_vec();
        assert_eq!(take_pieces(&mut pending), vec!["Éclair ☕"]);
        assert!(pending.is_empty());
    }

    #[test]
    fn stderr_keeps_the_tail() {
        let mut buf = String::new();
        for i in 0..2000 {
            push_tail(&mut buf, &format!("line {i} é"), 1000);
        }
        assert!(buf.len() <= 1500);
        assert!(buf.ends_with("line 1999 é\n"));
        assert!(!buf.contains("line 0 "));
    }

    #[test]
    fn delivery_never_overwrites() {
        let root = std::env::temp_dir().join(format!("balader-deliver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (stage, home) = (root.join("stage"), root.join("home"));
        std::fs::create_dir_all(stage.join("My List")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        // The user already has a video with this title: it must survive.
        std::fs::write(home.join("Clip.mp4"), b"user video").unwrap();
        std::fs::write(stage.join("Clip.mp4"), b"new").unwrap();
        std::fs::write(stage.join("Clip.mp3"), b"audio").unwrap();
        std::fs::write(stage.join("My List").join("001 - a.mp3"), b"a").unwrap();
        let staged = vec![stage.join("Clip.mp4"), stage.join("Clip.mp3"), stage.join("My List").join("001 - a.mp3")];
        let files = deliver(&staged, &stage, &home).unwrap();
        assert_eq!(std::fs::read(home.join("Clip.mp4")).unwrap(), b"user video");
        assert!(files[0].ends_with("Clip (2).mp4"), "{files:?}");
        assert!(files[1].ends_with("Clip.mp3"));
        assert!(files[2].ends_with("001 - a.mp3") && files[2].contains("My List"));
        assert!(!stage.join("Clip.mp3").exists(), "staged files are moved, not copied");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn summaries() {
        let v = DownloadRequest { mode: Mode::Video, tier: Some(1080), container: Container::Mp4, ..Default::default() };
        assert_eq!(summary_for(&v), "1080p · MP4");
        let a = DownloadRequest { mode: Mode::Audio, audio_format: AudioFormat::Mp3, audio_quality: "320".into(), ..Default::default() };
        assert_eq!(summary_for(&a), "MP3 · 320K");
        let p = DownloadRequest { playlist: true, playlist_count: Some(12), ..a };
        assert_eq!(summary_for(&p), "Playlist · 12 · MP3 · 320K");
    }
}
