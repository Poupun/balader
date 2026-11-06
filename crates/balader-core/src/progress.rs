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

pub fn parse_line(raw: &str) -> Line {
    let line = raw.trim_end_matches(['\r', '\n']).trim_start_matches('\r');
    let trimmed = line.trim();

    if let Some(json) = trimmed.strip_prefix(PROGRESS_PREFIX.trim_end()).map(str::trim_start) {
        if let Ok(p) = serde_json::from_str::<ProgressLine>(json) {
            return Line::Progress(Box::new(p));
        }
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
    fn errors_and_noise() {
        assert_eq!(parse_line("ERROR: [youtube] x: Video unavailable"), Line::Error("[youtube] x: Video unavailable".into()));
        assert_eq!(parse_line("WARNING: something"), Line::Warning("something".into()));
        assert!(matches!(parse_line("random text"), Line::Other(_)));
        // A broken progress line must not panic or be mistaken for progress.
        assert!(matches!(parse_line("BLDR {not json"), Line::Other(_)));
    }
}
