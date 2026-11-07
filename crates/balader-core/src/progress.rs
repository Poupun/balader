//! Parses yt-dlp's stdout/stderr, line by line, into typed events.

use regex::Regex;
use serde::Deserialize;
use std::sync::LazyLock;

use crate::selector::PROGRESS_PREFIX;

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProgressDict {
    pub status: Option<String>,
    pub downloaded_bytes: Option<f64>,
    pub total_bytes: Option<f64>,
    pub total_bytes_estimate: Option<f64>,
    pub speed: Option<f64>,
    pub eta: Option<f64>,
    pub fragment_index: Option<f64>,
    pub fragment_count: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProgressInfo {
    pub format_id: Option<String>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub playlist_index: Option<f64>,
    pub playlist_count: Option<f64>,
    pub n_entries: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProgressLine {
    pub p: ProgressDict,
    pub i: ProgressInfo,
}

impl ProgressLine {
    /// Fraction of the current file, 0..1, if it can be known.
    pub fn fraction(&self) -> Option<f64> {
        let d = &self.p;
        if d.status.as_deref() == Some("finished") {
            return Some(1.0);
        }
        let done = d.downloaded_bytes.unwrap_or(0.0);
        if let Some(t) = d.total_bytes.filter(|t| *t > 0.0) {
            return Some((done / t).clamp(0.0, 1.0));
        }
        if let (Some(i), Some(n)) = (d.fragment_index, d.fragment_count.filter(|n| *n > 0.0)) {
            return Some((i / n).clamp(0.0, 1.0));
        }
        d.total_bytes_estimate.filter(|t| *t > 0.0).map(|t| (done / t).clamp(0.0, 0.99))
    }

    pub fn total(&self) -> Option<f64> {
        self.p.total_bytes.filter(|t| *t > 0.0).or(self.p.total_bytes_estimate.filter(|t| *t > 0.0))
    }

    pub fn is_video(&self) -> bool {
        self.i.vcodec.as_deref().is_some_and(|v| v != "none")
    }

    pub fn is_audio_only(&self) -> bool {
        self.i.vcodec.as_deref() == Some("none") && self.i.acodec.as_deref().is_some_and(|a| a != "none")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    Progress(Box<ProgressLine>),
    /// `[info] id: Downloading 1 format(s): 137+140`
    Formats(Vec<String>),
    /// `[download] Downloading item 3 of 24`
    Item { index: u32, count: u32 },
    Destination(String),
    AlreadyDownloaded(String),
    /// A post-processor step: `[Merger] Merging formats into "x.mp4"`.
    Post { name: String, text: String },
    /// An extractor talking: `[youtube] abc: Downloading webpage`.
    Extract { extractor: String, text: String },
    /// FFmpeg's live stats while it cuts a section (it prints them itself):
    /// `frame= 259 fps=171 q=26.0 size= 1024KiB time=00:00:04.38 … speed=2.9x`.
    /// `time` is the position in the clip, `size` the bytes written so far.
    Ffmpeg { time: Option<f64>, size: Option<u64>, speed: Option<f64> },
    Error(String),
    Warning(String),
    Other(String),
}

const POSTPROCESSORS: &[&str] = &[
    "Merger",
    "ExtractAudio",
    "EmbedThumbnail",
    "ThumbnailsConvertor",
    "Metadata",
    "EmbedSubtitle",
    "SubtitlesConvertor",
    "VideoRemuxer",
    "VideoConvertor",
    "MoveFiles",
    "SponsorBlock",
    "ModifyChapters",
    "SplitChapters",
    "FFmpegCopyStream",
    "Exec",
];

static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[([A-Za-z0-9_:\-\.]+)\]\s*(.*)$").unwrap());
static FORMATS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Downloading \d+ format\(s\):\s*(\S+)").unwrap());
static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Downloading (?:item|video) (\d+) of (\d+)").unwrap());
static FF_TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"time=\s*(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)").unwrap());
static FF_SIZE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"size=\s*(\d+(?:\.\d+)?)\s*([KMG]iB|[kKmMgG]B|B)").unwrap());
static FF_SPEED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"speed=\s*(\d+(?:\.\d+)?)x").unwrap());

fn parse_ffmpeg_stats(line: &str) -> Line {
    let time = FF_TIME.captures(line).and_then(|c| {
        if c.get(1).is_some() {
            // A hair below zero at the very start.
            return Some(0.0);
        }
        Some(c[2].parse::<f64>().ok()? * 3600.0 + c[3].parse::<f64>().ok()? * 60.0 + c[4].parse::<f64>().ok()?)
    });
    let size = FF_SIZE.captures(line).and_then(|c| {
        let v: f64 = c[1].parse().ok()?;
        let unit = match &c[2] {
            "B" => 1.0,
            "KiB" | "kB" | "KB" => 1024.0,
            "MiB" | "mB" | "MB" => 1024.0 * 1024.0,
            _ => 1024.0 * 1024.0 * 1024.0,
        };
        Some((v * unit) as u64)
    });
    let speed = FF_SPEED.captures(line).and_then(|c| c[1].parse().ok()).filter(|s: &f64| *s > 0.0);
    Line::Ffmpeg { time, size, speed }
}

pub fn parse_line(raw: &str) -> Line {
    let line = raw.trim_end_matches(['\r', '\n']).trim_start_matches('\r');
    let trimmed = line.trim();

    if let Some(json) = trimmed.strip_prefix(PROGRESS_PREFIX.trim_end()).map(str::trim_start) {
        if let Ok(p) = serde_json::from_str::<ProgressLine>(json) {
            return Line::Progress(Box::new(p));
        }
    }
    if (trimmed.starts_with("frame=") || trimmed.starts_with("size=") || trimmed.starts_with("Lsize=")) && trimmed.contains("time=") {
        return parse_ffmpeg_stats(trimmed);
    }
    if let Some(msg) = trimmed.strip_prefix("ERROR:") {
        return Line::Error(msg.trim().to_string());
    }
    if let Some(msg) = trimmed.strip_prefix("WARNING:") {
        return Line::Warning(msg.trim().to_string());
    }
    let Some(caps) = TAG.captures(trimmed) else {
        return Line::Other(trimmed.to_string());
    };
    let tag = caps[1].to_string();
    let text = caps[2].to_string();
    match tag.as_str() {
        "info" => {
            if let Some(c) = FORMATS.captures(&text) {
                return Line::Formats(c[1].split('+').map(str::to_string).collect());
            }
            Line::Other(trimmed.to_string())
        }
        "download" => {
            if let Some(rest) = text.strip_prefix("Destination:") {
                return Line::Destination(rest.trim().to_string());
            }
            if let Some(c) = ITEM.captures(&text) {
                return Line::Item { index: c[1].parse().unwrap_or(1), count: c[2].parse().unwrap_or(1) };
            }
            if let Some(path) = text.strip_suffix("has already been downloaded") {
                return Line::AlreadyDownloaded(path.trim().to_string());
            }
            Line::Other(trimmed.to_string())
        }
        t if POSTPROCESSORS.contains(&t) || t.starts_with("Fixup") => Line::Post { name: tag, text },
        _ => Line::Extract { extractor: tag, text },
    }
}

/// Stage key + label for a post-processor name.
pub fn post_stage(name: &str) -> (&'static str, &'static str) {
    match name {
        "Merger" => ("merge", "Merging"),
        "ExtractAudio" => ("convert", "Converting audio"),
        "EmbedThumbnail" | "ThumbnailsConvertor" => ("embed", "Embedding cover"),
        "Metadata" => ("tags", "Writing tags"),
        "EmbedSubtitle" | "SubtitlesConvertor" => ("subs", "Embedding subtitles"),
        "VideoRemuxer" | "VideoConvertor" => ("remux", "Rewrapping"),
        "MoveFiles" => ("move", "Moving to folder"),
        n if n.starts_with("Fixup") => ("fixup", "Polishing"),
        _ => ("post", "Finishing up"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_json_line() {
        let l = parse_line(
            r#"BLDR {"p":{"status":"downloading","downloaded_bytes":1048576,"total_bytes":4194304,"speed":524288.0,"eta":6,"_percent_str":" 25.0%"},"i":{"format_id":"299","vcodec":"avc1.64002a","acodec":"none","playlist_index":null}}"#,
        );
        let Line::Progress(p) = l else { panic!("not progress: {l:?}") };
        assert_eq!(p.fraction(), Some(0.25));
        assert_eq!(p.i.format_id.as_deref(), Some("299"));
        assert!(p.is_video());
        assert_eq!(p.p.speed, Some(524288.0));
    }

    #[test]
    fn hls_progress_uses_fragments() {
        let l = parse_line(r#"BLDR {"p":{"status":"downloading","downloaded_bytes":500,"total_bytes_estimate":100000,"fragment_index":3,"fragment_count":12},"i":{"format_id":"hls-720","vcodec":"avc1","acodec":"mp4a"}}"#);
        let Line::Progress(p) = l else { panic!() };
        assert_eq!(p.fraction(), Some(0.25));
    }

    #[test]
    fn info_and_download_lines() {
        assert_eq!(parse_line("[info] BaW_jenozKc: Downloading 1 format(s): 137+140"), Line::Formats(vec!["137".into(), "140".into()]));
        assert_eq!(parse_line("[download] Downloading item 3 of 24"), Line::Item { index: 3, count: 24 });
        assert_eq!(parse_line("[download] Destination: /tmp/a.f137.mp4"), Line::Destination("/tmp/a.f137.mp4".into()));
        assert_eq!(parse_line("[download] /out/a.mp4 has already been downloaded"), Line::AlreadyDownloaded("/out/a.mp4".into()));
    }

    #[test]
    fn postprocessors_and_extractors() {
        assert!(matches!(parse_line("[Merger] Merging formats into \"a.mp4\""), Line::Post { ref name, .. } if name == "Merger"));
        assert!(matches!(parse_line("[FixupM3u8] Fixing MPEG-TS in MP4 container"), Line::Post { ref name, .. } if name == "FixupM3u8"));
        assert!(matches!(parse_line("[youtube] BaW_jenozKc: Downloading webpage"), Line::Extract { ref extractor, .. } if extractor == "youtube"));
        assert!(matches!(parse_line("[youtube:tab] x: Downloading page 1"), Line::Extract { .. }));
        assert_eq!(post_stage("ExtractAudio").0, "convert");
        assert_eq!(post_stage("FixupM4a").0, "fixup");
    }

    #[test]
    fn ffmpeg_stats_lines() {
        let l = parse_line("frame=  259 fps=171 q=26.0 size=    1024KiB time=00:00:04.38 bitrate=1911.4kbits/s speed= 2.9x elapsed=0:00:01.51    ");
        assert_eq!(l, Line::Ffmpeg { time: Some(4.38), size: Some(1024 * 1024), speed: Some(2.9) });
        // Final line (Lsize), hours, audio-only output.
        let l = parse_line("frame= 1200 fps=155 q=-1.0 Lsize=    7606KiB time=01:00:20.50 bitrate=3113.1kbits/s speed=2.59x");
        assert_eq!(l, Line::Ffmpeg { time: Some(3620.5), size: Some(7606 * 1024), speed: Some(2.59) });
        let l = parse_line("size=     256kB time=00:00:10.00 bitrate= 209.7kbits/s speed=20x");
        assert_eq!(l, Line::Ffmpeg { time: Some(10.0), size: Some(256 * 1024), speed: Some(20.0) });
        // The very first line: nothing known yet.
        let l = parse_line("frame=    0 fps=0.0 q=0.0 size=       0KiB time=-00:00:00.02 bitrate=N/A speed=N/A");
        assert_eq!(l, Line::Ffmpeg { time: Some(0.0), size: Some(0), speed: None });
        let l = parse_line("size=N/A time=N/A bitrate=N/A speed=N/A");
        assert_eq!(l, Line::Ffmpeg { time: None, size: None, speed: None });
        // Not stats.
        assert!(matches!(parse_line("frame rate is 25"), Line::Other(_)));
    }

    #[test]
    fn errors_and_noise() {
        assert_eq!(parse_line("ERROR: [youtube] x: Video unavailable"), Line::Error("[youtube] x: Video unavailable".into()));
        assert_eq!(parse_line("WARNING: something"), Line::Warning("something".into()));
        assert!(matches!(parse_line("random text"), Line::Other(_)));
        // A broken progress line must not panic or be mistaken for progress.
        assert!(matches!(parse_line("BLDR {not json"), Line::Other(_)));
    }
}
