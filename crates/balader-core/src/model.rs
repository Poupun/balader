//! Shared data model. Every type here crosses the IPC boundary (Tauri, the
//! test HTTP server, the CLI's JSON output) and is exported to TypeScript by
//! ts-rs, so the UI and the engine can never drift apart silently.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::ErrorPayload;

// ---------------------------------------------------------------- enums

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Mode {
    #[default]
    Video,
    Audio,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Container {
    /// H.264/AAC first: plays in QuickTime, Windows Media Player, editors.
    #[default]
    Mp4,
    /// Original codecs (AV1/VP9/Opus), best quality per byte.
    Mkv,
}

impl Container {
    pub fn ext(self) -> &'static str {
        match self {
            Container::Mp4 => "mp4",
            Container::Mkv => "mkv",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum AudioFormat {
    #[default]
    Mp3,
    M4a,
    Opus,
    Flac,
    Wav,
}

impl AudioFormat {
    pub fn ext(self) -> &'static str {
        match self {
            AudioFormat::Mp3 => "mp3",
            AudioFormat::M4a => "m4a",
            AudioFormat::Opus => "opus",
            AudioFormat::Flac => "flac",
            AudioFormat::Wav => "wav",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            AudioFormat::Mp3 => "MP3",
            AudioFormat::M4a => "M4A",
            AudioFormat::Opus => "OPUS",
            AudioFormat::Flac => "FLAC",
            AudioFormat::Wav => "WAV",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FilenameStyle {
    #[default]
    Title,
    TitleId,
    UploaderTitle,
    DateTitle,
}

// ---------------------------------------------------------------- probe

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlatformInfo {
    pub key: String,
    pub name: String,
    /// Accent colour used for the platform badge (hex).
    pub color: String,
}

/// What a quality card will actually download, for one container choice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TierPick {
    pub video_id: String,
    pub audio_id: Option<String>,
    /// The video format already carries audio (no merge needed).
    pub combined: bool,
    /// No audio track anywhere for this video.
    pub silent: bool,
    pub vcodec: String,
    pub acodec: Option<String>,
    pub ext: String,
    pub fps: Option<u32>,
    pub hdr: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[ts(type = "number | null")]
    pub size: Option<u64>,
    #[ts(type = "number | null")]
    pub video_size: Option<u64>,
    #[ts(type = "number | null")]
    pub audio_size: Option<u64>,
    /// Sizes come from the site (true) or are estimated from bitrate (false).
    pub size_exact: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VideoTier {
    /// Resolution label measured on the short side (1080 for 1920x1080 and 1080x1920).
    pub label: u32,
    pub mp4: TierPick,
    pub mkv: TierPick,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AudioTrack {
    pub format_id: String,
    pub codec: String,
    pub ext: String,
    pub abr: Option<f64>,
    #[ts(type = "number | null")]
    pub size: Option<u64>,
    pub size_exact: bool,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AudioInfo {
    pub available: bool,
    /// Audio has to be pulled out of a combined video file.
    pub from_combined: bool,
    pub best: Option<AudioTrack>,
    /// Every distinct audio-only track, best first (deduplicated by codec+bitrate).
    pub tracks: Vec<AudioTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MediaInfo {
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub platform: PlatformInfo,
    pub extractor: String,
    pub webpage_url: String,
    pub view_count: Option<f64>,
    pub like_count: Option<f64>,
    pub upload_date: Option<String>,
    pub live: bool,
    pub has_video: bool,
    pub tiers: Vec<VideoTier>,
    pub audio: AudioInfo,
    pub subtitles: Vec<String>,
    pub format_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlaylistEntry {
    pub id: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlaylistInfo {
    pub id: Option<String>,
    pub title: String,
    pub uploader: Option<String>,
    pub platform: PlatformInfo,
    pub webpage_url: String,
    pub count: u32,
    pub thumbnail: Option<String>,
    /// First entries only (enough for a preview fan).
    pub entries: Vec<PlaylistEntry>,
}

/// A media URL found by Balader's own HTML scraper when yt-dlp has no extractor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SniffCandidate {
    pub url: String,
    /// "video", "audio" or "stream" (HLS/DASH manifest).
    pub kind: String,
    pub ext: Option<String>,
    pub label: String,
    /// Where it was found: "og:video", "<video>", "json-ld", "link"...
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
#[allow(clippy::large_enum_variant)]
pub enum ProbeResult {
    Video { media: MediaInfo },
    Playlist { playlist: PlaylistInfo },
    Sniffed { page: String, candidates: Vec<SniffCandidate> },
}

// ---------------------------------------------------------------- downloads

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct DownloadRequest {
    pub url: String,
    pub mode: Mode,
    // Display data echoed back in the job card.
    pub title: Option<String>,
    pub thumbnail: Option<String>,
    pub platform: Option<PlatformInfo>,
    pub duration: Option<f64>,
    pub summary: Option<String>,
    // Video choice.
    /// Tier label (short side). None = best available.
    pub tier: Option<u32>,
    pub container: Container,
    /// Exact format ids from the probe (single videos). Fallbacks are always added.
    pub video_id: Option<String>,
    pub audio_id: Option<String>,
    pub combined: bool,
    pub silent: bool,
    /// Codec/container of the picked video format (decides remux vs re-encode).
    pub pick_vcodec: Option<String>,
    pub pick_ext: Option<String>,
    #[ts(type = "number | null")]
    pub expected_video: Option<u64>,
    #[ts(type = "number | null")]
    pub expected_audio: Option<u64>,
    // Audio choice.
    pub audio_format: AudioFormat,
    /// "best", "original", or a bitrate in kbps such as "320".
    pub audio_quality: String,
    pub audio_source_id: Option<String>,
    // Playlist.
    pub playlist: bool,
    pub playlist_count: Option<u32>,
    /// Limit to the first N entries.
    pub playlist_limit: Option<u32>,
    /// Sent as Referer (media found by the scraper).
    pub referer: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum JobStatus {
    Queued,
    Starting,
    Downloading,
    Processing,
    Done,
    Error,
    Cancelled,
}

impl JobStatus {
    pub fn is_active(self) -> bool {
        matches!(self, JobStatus::Queued | JobStatus::Starting | JobStatus::Downloading | JobStatus::Processing)
    }
    pub fn is_running(self) -> bool {
        matches!(self, JobStatus::Starting | JobStatus::Downloading | JobStatus::Processing)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JobSnapshot {
    pub id: String,
    pub url: String,
    pub title: String,
    pub thumbnail: Option<String>,
    pub platform: Option<PlatformInfo>,
    pub mode: Mode,
    pub summary: String,
    pub status: JobStatus,
    /// Machine key: queued, extract, video, audio, media, subs, merge, convert, embed, tags, fixup, remux, move, done, error, cancelled.
    pub stage: String,
    pub stage_label: String,
    /// Overall progress 0..1 (monotonic within a run).
    pub progress: f64,
    pub item: Option<u32>,
    pub items: Option<u32>,
    pub part: Option<u32>,
    pub parts: Option<u32>,
    #[ts(type = "number")]
    pub downloaded: u64,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
    /// Bytes per second.
    pub speed: Option<f64>,
    /// Seconds.
    pub eta: Option<f64>,
    pub files: Vec<String>,
    pub output_dir: String,
    pub error: Option<ErrorPayload>,
    pub warnings: Vec<String>,
    pub already_existed: bool,
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number | null")]
    pub finished_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryEntry {
    pub id: String,
    pub url: String,
    pub title: String,
    pub thumbnail: Option<String>,
    pub platform: Option<PlatformInfo>,
    pub mode: Mode,
    pub summary: String,
    pub files: Vec<String>,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub finished_at: u64,
}

// ---------------------------------------------------------------- settings

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Settings {
    pub output_dir: String,
    pub filename: FilenameStyle,
    pub max_concurrent: u8,
    /// chrome, firefox, safari, edge, brave, chromium, opera, vivaldi (None = off).
    pub cookies_browser: Option<String>,
    pub embed_thumbnail: bool,
    pub embed_metadata: bool,
    pub embed_subs: bool,
    pub sub_langs: String,
    // Remembered choices.
    pub mode: Mode,
    pub container: Container,
    pub audio_format: AudioFormat,
    pub audio_quality: String,
    // Feel.
    pub sound: bool,
    pub volume: f64,
    pub crt: bool,
    pub background_motion: bool,
    pub reduced_motion: bool,
    pub screen_shake: bool,
    pub auto_update: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            output_dir: String::new(),
            filename: FilenameStyle::Title,
            max_concurrent: 2,
            cookies_browser: None,
            embed_thumbnail: true,
            embed_metadata: true,
            embed_subs: false,
            sub_langs: "en.*".into(),
            mode: Mode::Video,
            container: Container::Mp4,
            audio_format: AudioFormat::Mp3,
            audio_quality: "best".into(),
            sound: true,
            volume: 0.6,
            crt: true,
            background_motion: true,
            reduced_motion: false,
            screen_shake: true,
            auto_update: true,
        }
    }
}

// ---------------------------------------------------------------- engine

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ComponentState {
    Ready,
    Missing,
    Installing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ComponentStatus {
    /// "ytdlp", "ffmpeg" or "deno".
    pub id: String,
    pub name: String,
    pub role: String,
    pub required: bool,
    pub state: ComponentState,
    /// "managed" (installed by Balader) or "system" (found on this machine).
    pub source: Option<String>,
    pub path: Option<String>,
    pub version: Option<String>,
    pub latest: Option<String>,
    pub update_available: bool,
    pub error: Option<String>,
    /// Approximate download size if Balader has to fetch it.
    #[ts(type = "number")]
    pub download_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EngineStatus {
    pub components: Vec<ComponentStatus>,
    /// Every required component is ready.
    pub ready: bool,
    pub engine_dir: String,
    pub platform: String,
    pub arch: String,
    /// "deno (managed)", "node (system)"... None when YouTube runs degraded.
    pub js_runtime: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum InstallStage {
    Download,
    Verify,
    Extract,
    Check,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub config_dir: String,
    pub data_dir: String,
    pub engine_dir: String,
    pub default_output_dir: String,
    /// "tauri", "http" (test server) or "cli".
    pub host: String,
}
