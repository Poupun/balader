//! Turns yt-dlp's raw format list into the "hand" the UI deals: one card per
//! resolution tier, each with an exact pick for MP4 (compatibility first) and
//! MKV (original codecs first), plus the audio tracks for audio-only mode.
//!
//! Resolution is measured on the short side, so a 1080x1920 TikTok is
//! "1080" just like a 1920x1080 YouTube video (same rule as `yt-dlp -S res`).

use std::collections::BTreeMap;

use regex::Regex;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::model::{AudioInfo, AudioTrack, MediaInfo, PlaylistEntry, PlaylistInfo, TierPick, VideoTier};
use crate::platform::platform_for;

// ------------------------------------------------------------ raw json

fn lenient_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    })
}

fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::String(s)) => Some(s),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    })
}

fn lenient_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Bool(b)) => Some(b),
        Some(Value::Number(n)) => Some(n.as_f64().unwrap_or(0.0) != 0.0),
        Some(Value::String(s)) => Some(matches!(s.as_str(), "true" | "True" | "1" | "maybe")),
        _ => None,
    })
}

fn lenient_vec<'de, D: Deserializer<'de>, T: serde::de::DeserializeOwned>(d: D) -> Result<Vec<T>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::Array(items)) => items.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect(),
        _ => Vec::new(),
    })
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct RawFormat {
    #[serde(deserialize_with = "lenient_string")]
    pub format_id: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub format_note: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub ext: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub vcodec: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub acodec: Option<String>,
    #[serde(deserialize_with = "lenient_f64")]
    pub width: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    pub height: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    pub fps: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    pub tbr: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    pub vbr: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    pub abr: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    pub filesize: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    pub filesize_approx: Option<f64>,
    #[serde(deserialize_with = "lenient_string")]
    pub dynamic_range: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub protocol: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub language: Option<String>,
    #[serde(deserialize_with = "lenient_f64")]
    pub language_preference: Option<f64>,
    #[serde(deserialize_with = "lenient_bool")]
    pub has_drm: Option<bool>,
    #[serde(deserialize_with = "lenient_string")]
    pub video_ext: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub audio_ext: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct RawThumb {
    #[serde(deserialize_with = "lenient_string")]
    pub url: Option<String>,
    #[serde(deserialize_with = "lenient_f64")]
    pub width: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    pub preference: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct RawInfo {
    #[serde(rename = "_type", deserialize_with = "lenient_string")]
    pub kind: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub id: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub title: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub fulltitle: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub uploader: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub channel: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub creator: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub uploader_id: Option<String>,
    #[serde(deserialize_with = "lenient_f64")]
    pub duration: Option<f64>,
    #[serde(deserialize_with = "lenient_string")]
    pub thumbnail: Option<String>,
    #[serde(deserialize_with = "lenient_vec")]
    pub thumbnails: Vec<RawThumb>,
    #[serde(deserialize_with = "lenient_string")]
    pub webpage_url: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub original_url: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub url: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub extractor: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub extractor_key: Option<String>,
    #[serde(deserialize_with = "lenient_f64")]
    pub view_count: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    pub like_count: Option<f64>,
    #[serde(deserialize_with = "lenient_string")]
    pub upload_date: Option<String>,
    #[serde(deserialize_with = "lenient_bool")]
    pub is_live: Option<bool>,
    #[serde(deserialize_with = "lenient_string")]
    pub live_status: Option<String>,
    #[serde(deserialize_with = "lenient_vec")]
    pub formats: Vec<RawFormat>,
    pub subtitles: Option<BTreeMap<String, Value>>,
    pub entries: Option<Vec<Value>>,
    #[serde(deserialize_with = "lenient_f64")]
    pub playlist_count: Option<f64>,
}

impl RawInfo {
    pub fn parse(json: &str) -> serde_json::Result<(RawInfo, Value)> {
        let value: Value = serde_json::from_str(json)?;
        let mut info: RawInfo = serde_json::from_value(value.clone())?;
        // Some extractors return a single inline format instead of a list.
        if info.formats.is_empty() && value.get("url").is_some() {
            if let Ok(f) = serde_json::from_value::<RawFormat>(value.clone()) {
                info.formats.push(f);
            }
        }
        Ok((info, value))
    }

    pub fn is_playlist(&self) -> bool {
        matches!(self.kind.as_deref(), Some("playlist") | Some("multi_video")) || self.entries.is_some()
    }

    pub fn best_thumbnail(&self) -> Option<String> {
        if let Some(t) = self.thumbnail.clone().filter(|t| t.starts_with("http")) {
            return Some(t);
        }
        best_thumb(&self.thumbnails)
    }
}

fn best_thumb(thumbs: &[RawThumb]) -> Option<String> {
    // yt-dlp sorts thumbnails worst -> best; prefer the best one that isn't enormous.
    let usable: Vec<&RawThumb> = thumbs.iter().filter(|t| t.url.as_deref().is_some_and(|u| u.starts_with("http"))).collect();
    usable
        .iter()
        .rev()
        .find(|t| t.width.is_none_or(|w| w <= 1920.0))
        .or_else(|| usable.last())
        .and_then(|t| t.url.clone())
}

// ------------------------------------------------------------ classification

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Video,
    Audio,
    Combined,
}

const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "aac", "opus", "ogg", "oga", "wav", "flac", "weba", "webm_audio", "mka", "alac", "aiff"];

fn kind_of(f: &RawFormat) -> Option<Kind> {
    let ext = f.ext.as_deref().unwrap_or("").to_ascii_lowercase();
    let note = f.format_note.as_deref().unwrap_or("").to_ascii_lowercase();
    if ext == "mhtml" || note.contains("storyboard") || f.protocol.as_deref() == Some("mhtml") {
        return None;
    }
    if f.has_drm == Some(true) {
        return None;
    }
    let vnone = f.vcodec.as_deref() == Some("none");
    let anone = f.acodec.as_deref() == Some("none");
    let has_dims = f.width.is_some() || f.height.is_some();
    let has_v = if f.vcodec.is_some() { !vnone } else { has_dims || !AUDIO_EXTS.contains(&ext.as_str()) };
    let has_a = if f.acodec.is_some() { !anone } else { true };
    match (has_v, has_a) {
        (true, true) => Some(Kind::Combined),
        (true, false) => Some(Kind::Video),
        (false, true) => Some(Kind::Audio),
        (false, false) => None,
    }
}

/// "h264" | "hevc" | "av1" | "vp9" | "vp8" | "other"
pub fn vfamily(vcodec: Option<&str>) -> &'static str {
    let c = vcodec.unwrap_or("").to_ascii_lowercase();
    if c.starts_with("avc") || c.starts_with("h264") || c == "h.264" {
        "h264"
    } else if c.starts_with("hvc") || c.starts_with("hev") || c.starts_with("h265") || c.starts_with("hevc") || c.starts_with("bytevc1") {
        "hevc"
    } else if c.starts_with("av01") || c.starts_with("av1") {
        "av1"
    } else if c.starts_with("vp09") || c.starts_with("vp9") {
        "vp9"
    } else if c.starts_with("vp8") || c.starts_with("vp08") {
        "vp8"
    } else {
        "other"
    }
}

/// Codec badge text. Unknown codec: fall back to the container ("MP4").
fn vdisplay(family: &str, raw: Option<&str>, ext: Option<&str>) -> String {
    match family {
        "h264" => "H.264".into(),
        "hevc" => "HEVC".into(),
        "av1" => "AV1".into(),
        "vp9" => "VP9".into(),
        "vp8" => "VP8".into(),
        _ => raw
            .filter(|r| !r.is_empty() && *r != "none")
            .map(|r| r.split('.').next().unwrap_or(r).to_ascii_uppercase())
            .or_else(|| ext.map(|e| e.to_ascii_uppercase()))
            .unwrap_or_else(|| "VIDEO".into()),
    }
}

/// "aac" | "opus" | "mp3" | "vorbis" | "flac" | "ac3" | "other"
pub fn afamily(acodec: Option<&str>, ext: Option<&str>) -> &'static str {
    let c = acodec.unwrap_or("").to_ascii_lowercase();
    let e = ext.unwrap_or("").to_ascii_lowercase();
    if c.starts_with("mp4a") || c.starts_with("aac") || (c.is_empty() && (e == "m4a" || e == "aac")) {
        "aac"
    } else if c.starts_with("opus") || (c.is_empty() && e == "opus") {
        "opus"
    } else if c.starts_with("mp3") || c == "mp4a.40.34" || (c.is_empty() && e == "mp3") {
        "mp3"
    } else if c.starts_with("vorbis") || (c.is_empty() && e == "ogg") {
        "vorbis"
    } else if c.starts_with("flac") || (c.is_empty() && e == "flac") {
        "flac"
    } else if c.starts_with("ac-3") || c.starts_with("ec-3") || c.starts_with("ac3") || c.starts_with("eac3") {
        "ac3"
    } else {
        "other"
    }
}

/// Audio badge text; None when the site doesn't say.
fn adisplay(family: &str, raw: Option<&str>) -> Option<String> {
    Some(match family {
        "aac" => "AAC".into(),
        "opus" => "Opus".into(),
        "mp3" => "MP3".into(),
        "vorbis" => "Vorbis".into(),
        "flac" => "FLAC".into(),
        "ac3" => "Dolby".into(),
        _ => raw.filter(|r| !r.is_empty() && *r != "none").map(|r| r.split('.').next().unwrap_or(r).to_ascii_uppercase())?,
    })
}

const STANDARD_TIERS: &[u32] = &[144, 240, 360, 480, 720, 1080, 1440, 2160, 2880, 4320];

/// Snap a measured short side to a familiar tier when it's within 7%.
pub fn normalize_tier(side: u32) -> u32 {
    let mut best = side;
    let mut best_diff = f64::MAX;
    for &t in STANDARD_TIERS {
        let diff = (side as f64 - t as f64).abs() / t as f64;
        if diff < best_diff {
            best_diff = diff;
            best = t;
        }
    }
    if best_diff <= 0.07 { best } else { side - side % 2 }
}

fn note_label(note: &str) -> Option<u32> {
    static RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"^\s*(\d{3,4})[pP]").unwrap());
    RE.captures(note).and_then(|c| c[1].parse().ok())
}

fn tier_label(f: &RawFormat) -> Option<u32> {
    let w = f.width.filter(|v| *v > 0.0).map(|v| v.round() as u32);
    let h = f.height.filter(|v| *v > 0.0).map(|v| v.round() as u32);
    let dims = match (w, h) {
        (Some(w), Some(h)) => Some((w.min(h), w.max(h))),
        (None, Some(h)) => Some((h, h)),
        (Some(w), None) => Some((w, w)),
        (None, None) => None,
    };
    let from_note = f.format_note.as_deref().and_then(note_label);
    match (from_note, dims) {
        // Trust the site's own label ("1080p") when it is consistent with the pixels:
        // YouTube calls a 1920x800 film "1080p", and so do people.
        (Some(n), Some((short, long))) if (n as f64) >= short as f64 * 0.95 && (n as f64) <= long as f64 * 1.05 => Some(n),
        (_, Some((short, _))) => Some(normalize_tier(short)),
        (Some(n), None) => Some(n),
        (None, None) => None,
    }
}

// ------------------------------------------------------------ scoring

#[derive(Debug, Clone)]
struct Cand<'a> {
    f: &'a RawFormat,
    kind: Kind,
    label: Option<u32>,
    fps: u32,
    hdr: bool,
    vfam: &'static str,
    afam: &'static str,
    vbr: f64,
    abr: f64,
    proto: u8,
    watermarked: bool,
    drc: bool,
    lang: f64,
}

fn proto_rank(p: Option<&str>) -> u8 {
    match p.unwrap_or("https") {
        "https" | "http" => 3,
        "http_dash_segments" | "http_dash_segments_generator" | "dash" => 2,
        p if p.starts_with("m3u8") => 1,
        _ => 0,
    }
}

fn mp4_vrank(fam: &str) -> u8 {
    match fam {
        "h264" => 5,
        "hevc" => 4,
        "av1" => 3,
        "vp9" => 2,
        "vp8" => 1,
        _ => 0,
    }
}

fn mkv_vrank(fam: &str) -> u8 {
    match fam {
        "av1" => 5,
        "vp9" => 4,
        "hevc" => 3,
        "h264" => 2,
        "vp8" => 1,
        _ => 0,
    }
}

fn mp4_arank(fam: &str) -> u8 {
    match fam {
        "aac" => 5,
        "mp3" => 4,
        "opus" => 3,
        "ac3" => 2,
        "flac" => 1,
        _ => 0,
    }
}

fn mkv_arank(fam: &str) -> u8 {
    match fam {
        "opus" => 5,
        "flac" => 4,
        "aac" => 3,
        "vorbis" => 2,
        "mp3" => 1,
        _ => 0,
    }
}

fn cand(f: &RawFormat) -> Option<Cand<'_>> {
    let kind = kind_of(f)?;
    let note = f.format_note.as_deref().unwrap_or("").to_ascii_lowercase();
    let id = f.format_id.as_deref().unwrap_or("").to_ascii_lowercase();
    let vfam = vfamily(f.vcodec.as_deref());
    let afam = afamily(f.acodec.as_deref(), f.audio_ext.as_deref().or(f.ext.as_deref()));
    let hdr = f.dynamic_range.as_deref().is_some_and(|d| !d.eq_ignore_ascii_case("sdr"))
        || f.vcodec.as_deref().is_some_and(|v| v.starts_with("vp09.02"));
    let abr = f.abr.unwrap_or(match kind {
        Kind::Audio => f.tbr.unwrap_or(0.0),
        _ => 0.0,
    });
    let vbr = f.vbr.unwrap_or(match kind {
        Kind::Video => f.tbr.unwrap_or(0.0),
        Kind::Combined => (f.tbr.unwrap_or(0.0) - abr).max(0.0),
        Kind::Audio => 0.0,
    });
    // Only "original" means the source-language track; YouTube also labels
    // opaque HLS streams "Default", which must not win on that alone.
    let mut lang = f.language_preference.unwrap_or(0.0).max(-10.0);
    if note.contains("original") {
        lang += 1.0;
    }
    if note.contains("dubbed") || note.contains("descriptive") {
        lang -= 1.0;
    }
    Some(Cand {
        f,
        kind,
        label: if kind == Kind::Audio { None } else { tier_label(f) },
        fps: f.fps.map(|v| v.round() as u32).unwrap_or(0),
        hdr,
        vfam,
        afam,
        vbr,
        abr,
        proto: proto_rank(f.protocol.as_deref()),
        watermarked: note.contains("watermark"),
        drc: id.contains("drc") || note.contains("drc"),
        lang,
    })
}

fn size_of(f: &RawFormat, duration: Option<f64>, kbps: f64) -> (Option<u64>, bool) {
    if let Some(s) = f.filesize.filter(|s| *s > 0.0) {
        return (Some(s as u64), true);
    }
    if let Some(s) = f.filesize_approx.filter(|s| *s > 0.0) {
        return (Some(s as u64), false);
    }
    match duration {
        Some(d) if d > 0.0 && kbps > 0.0 => (Some((kbps * 125.0 * d) as u64), false),
        _ => (None, false),
    }
}

fn cmp_f64(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Flavor {
    Mp4,
    Mkv,
}

fn video_key(c: &Cand, flavor: Flavor, audio_only_exists: bool) -> (u8, u8, u32, u8, u8, u8) {
    let effective_audio = c.kind == Kind::Combined || audio_only_exists;
    let vr = match flavor {
        Flavor::Mp4 => mp4_vrank(c.vfam),
        Flavor::Mkv => mkv_vrank(c.vfam),
    };
    (effective_audio as u8, (!c.watermarked) as u8, c.fps, vr, (!c.hdr) as u8, c.proto)
}

fn best_video<'a>(cands: &[&'a Cand<'a>], flavor: Flavor, audio_only_exists: bool) -> Option<&'a Cand<'a>> {
    cands.iter().copied().max_by(|a, b| {
        video_key(a, flavor, audio_only_exists).cmp(&video_key(b, flavor, audio_only_exists)).then_with(|| cmp_f64(a.vbr, b.vbr))
    })
}

/// Perceived quality per kbps: Opus at 96k sounds like AAC at ~130k.
fn codec_efficiency(fam: &str) -> f64 {
    match fam {
        "opus" => 1.35,
        "vorbis" => 1.1,
        "aac" => 1.0,
        "ac3" => 0.9,
        "mp3" => 0.85,
        "flac" => 4.0,
        _ => 0.8,
    }
}

fn audio_order(a: &Cand, b: &Cand, flavor: Flavor) -> std::cmp::Ordering {
    let base = cmp_f64(a.lang, b.lang)
        .then_with(|| (!a.drc).cmp(&!b.drc))
        // A stream that doesn't say what it is loses to one that does.
        .then_with(|| (a.abr > 0.0).cmp(&(b.abr > 0.0)));
    match flavor {
        // MP4: the codec must fit the container first (AAC), then bitrate.
        Flavor::Mp4 => base
            .then_with(|| mp4_arank(a.afam).cmp(&mp4_arank(b.afam)))
            .then_with(|| cmp_f64(a.abr, b.abr))
            .then_with(|| a.proto.cmp(&b.proto)),
        // Best quality: bitrate weighted by codec efficiency.
        Flavor::Mkv => base
            .then_with(|| cmp_f64(a.abr * codec_efficiency(a.afam), b.abr * codec_efficiency(b.afam)))
            .then_with(|| mkv_arank(a.afam).cmp(&mkv_arank(b.afam)))
            .then_with(|| a.proto.cmp(&b.proto)),
    }
}

fn best_audio<'a>(cands: &[&'a Cand<'a>], flavor: Flavor) -> Option<&'a Cand<'a>> {
    cands.iter().copied().max_by(|a, b| audio_order(a, b, flavor))
}

fn track(c: &Cand, duration: Option<f64>) -> AudioTrack {
    let (size, exact) = size_of(c.f, duration, if c.abr > 0.0 { c.abr } else { c.f.tbr.unwrap_or(0.0) });
    AudioTrack {
        format_id: c.f.format_id.clone().unwrap_or_default(),
        codec: adisplay(c.afam, c.f.acodec.as_deref()).unwrap_or_else(|| c.f.ext.as_deref().unwrap_or("audio").to_ascii_uppercase()),
        ext: c.f.ext.clone().unwrap_or_else(|| "m4a".into()),
        abr: if c.abr > 0.0 { Some((c.abr * 10.0).round() / 10.0) } else { None },
        size,
        size_exact: exact,
        language: c.f.language.clone(),
    }
}

fn pick(video: &Cand, audio: Option<&Cand>, duration: Option<f64>, silent: bool) -> TierPick {
    let vkbps = if video.kind == Kind::Combined { video.f.tbr.unwrap_or(video.vbr + video.abr) } else { video.vbr };
    let (vsize, vexact) = size_of(video.f, duration, vkbps);
    let (asize, aexact) = match audio {
        Some(a) => size_of(a.f, duration, a.abr),
        None => (None, true),
    };
    let size = match (vsize, asize, audio.is_some()) {
        (Some(v), Some(a), true) => Some(v + a),
        (Some(v), None, true) => Some(v),
        (Some(v), _, false) => Some(v),
        (None, _, _) => None,
    };
    let w = video.f.width.map(|v| v.round() as u32);
    let h = video.f.height.map(|v| v.round() as u32);
    TierPick {
        video_id: video.f.format_id.clone().unwrap_or_default(),
        audio_id: audio.and_then(|a| a.f.format_id.clone()),
        combined: video.kind == Kind::Combined,
        silent,
        vcodec: vdisplay(video.vfam, video.f.vcodec.as_deref(), video.f.ext.as_deref()),
        acodec: match (video.kind, audio) {
            (_, Some(a)) => adisplay(a.afam, a.f.acodec.as_deref()),
            (Kind::Combined, None) => adisplay(video.afam, video.f.acodec.as_deref()),
            _ => None,
        },
        ext: video.f.ext.clone().unwrap_or_else(|| "mp4".into()),
        fps: if video.fps > 0 { Some(video.fps) } else { None },
        hdr: video.hdr,
        width: w,
        height: h,
        size,
        video_size: vsize,
        audio_size: asize,
        size_exact: vexact && aexact && size.is_some(),
    }
}

struct TierCtx<'a> {
    mp4_audio: Option<&'a Cand<'a>>,
    mkv_audio: Option<&'a Cand<'a>>,
    duration: Option<f64>,
    audio_only_exists: bool,
}

fn make_pick(v: &Cand, a: Option<&Cand>, duration: Option<f64>) -> TierPick {
    if v.kind == Kind::Combined { pick(v, None, duration, false) } else { pick(v, a, duration, a.is_none()) }
}

fn build_tier(group: &[&Cand], label: u32, ctx: &TierCtx) -> Option<VideoTier> {
    let v4 = best_video(group, Flavor::Mp4, ctx.audio_only_exists)?;
    let vk = best_video(group, Flavor::Mkv, ctx.audio_only_exists)?;
    Some(VideoTier {
        label,
        mp4: make_pick(v4, ctx.mp4_audio, ctx.duration),
        mkv: make_pick(vk, ctx.mkv_audio, ctx.duration),
    })
}

// ------------------------------------------------------------ public api

pub struct Analysis {
    pub tiers: Vec<VideoTier>,
    pub audio: AudioInfo,
    pub has_video: bool,
}

pub fn analyze_formats(formats: &[RawFormat], duration: Option<f64>) -> Analysis {
    let cands: Vec<Cand> = formats.iter().filter_map(cand).collect();
    let audio_only: Vec<&Cand> = cands.iter().filter(|c| c.kind == Kind::Audio).collect();
    let visual: Vec<&Cand> = cands.iter().filter(|c| c.kind != Kind::Audio).collect();
    let audio_only_exists = !audio_only.is_empty();

    // ---- tiers
    let mut labels: Vec<u32> = visual.iter().filter_map(|c| c.label).collect();
    labels.sort_unstable_by(|a, b| b.cmp(a));
    labels.dedup();
    let mut tiers = Vec::new();
    let mp4_audio = best_audio(&audio_only, Flavor::Mp4);
    let mkv_audio = best_audio(&audio_only, Flavor::Mkv);
    let ctx = TierCtx { mp4_audio, mkv_audio, duration, audio_only_exists };
    for label in &labels {
        let group: Vec<&Cand> = visual.iter().copied().filter(|c| c.label == Some(*label)).collect();
        if let Some(t) = build_tier(&group, *label, &ctx) {
            tiers.push(t);
        }
    }
    // No resolution info at all: a single "best" card (label 0).
    if tiers.is_empty() && !visual.is_empty() {
        if let Some(t) = build_tier(&visual, 0, &ctx) {
            tiers.push(t);
        }
    }

    // ---- audio tracks
    let mut audio = AudioInfo::default();
    if audio_only_exists {
        let max_lang = audio_only.iter().map(|c| c.lang).fold(f64::MIN, f64::max);
        let any_known = audio_only.iter().any(|c| c.abr > 0.0);
        let mut preferred: Vec<&Cand> =
            audio_only.iter().copied().filter(|c| c.lang >= max_lang - 0.01).filter(|c| !any_known || c.abr > 0.0).collect();
        preferred.sort_by(|a, b| {
            cmp_f64(b.abr, a.abr).then_with(|| (!b.drc).cmp(&!a.drc)).then_with(|| mkv_arank(b.afam).cmp(&mkv_arank(a.afam)))
        });
        let mut seen: Vec<(&str, i64)> = Vec::new();
        for c in preferred {
            // DRC twins sort after their normal copy, so they fall out here.
            let key = (c.afam, (c.abr / 8.0).round() as i64);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            audio.tracks.push(track(c, duration));
        }
        audio.best = mkv_audio.map(|c| track(c, duration));
        audio.available = true;
    } else if let Some(best_combined) =
        visual.iter().copied().filter(|c| c.kind == Kind::Combined).max_by(|a, b| cmp_f64(a.abr, b.abr).then_with(|| cmp_f64(a.vbr, b.vbr)))
    {
        audio.available = true;
        audio.from_combined = true;
        let mut t = track(best_combined, duration);
        t.size = None;
        t.size_exact = false;
        audio.best = Some(t);
    }

    Analysis { tiers, audio, has_video: !visual.is_empty() }
}

pub fn media_info(raw: &RawInfo, input_url: &str) -> MediaInfo {
    let analysis = analyze_formats(&raw.formats, raw.duration);
    let webpage_url = raw.webpage_url.clone().or_else(|| raw.original_url.clone()).unwrap_or_else(|| input_url.to_string());
    let extractor_key = raw.extractor_key.clone().or_else(|| raw.extractor.clone()).unwrap_or_else(|| "Generic".into());
    let live = raw.is_live == Some(true) || matches!(raw.live_status.as_deref(), Some("is_live") | Some("is_upcoming"));
    let mut subtitles: Vec<String> = raw
        .subtitles
        .as_ref()
        .map(|m| m.keys().filter(|k| !k.starts_with("live_chat")).cloned().collect())
        .unwrap_or_default();
    subtitles.sort();
    MediaInfo {
        id: raw.id.clone().unwrap_or_default(),
        title: raw
            .title
            .clone()
            .or_else(|| raw.fulltitle.clone())
            .filter(|t| !t.trim().is_empty())
            .or_else(|| raw.id.clone())
            .unwrap_or_else(|| "Untitled".into()),
        uploader: raw.uploader.clone().or_else(|| raw.channel.clone()).or_else(|| raw.creator.clone()).or_else(|| raw.uploader_id.clone()),
        duration: raw.duration,
        thumbnail: raw.best_thumbnail(),
        platform: platform_for(&extractor_key, &webpage_url),
        extractor: raw.extractor.clone().unwrap_or_else(|| extractor_key.clone()),
        webpage_url,
        view_count: raw.view_count,
        like_count: raw.like_count,
        upload_date: raw.upload_date.clone(),
        live,
        has_video: analysis.has_video,
        tiers: analysis.tiers,
        audio: analysis.audio,
        subtitles,
        format_count: raw.formats.len() as u32,
    }
}

pub fn playlist_info(raw: &RawInfo, input_url: &str) -> PlaylistInfo {
    let entries_raw = raw.entries.clone().unwrap_or_default();
    let entries: Vec<PlaylistEntry> = entries_raw
        .iter()
        .filter(|v| v.is_object())
        .take(200)
        .map(|v| {
            let e: RawInfo = serde_json::from_value(v.clone()).unwrap_or_default();
            PlaylistEntry {
                id: e.id.clone(),
                title: e.title.clone(),
                url: e.webpage_url.clone().or_else(|| e.url.clone()),
                duration: e.duration,
                thumbnail: e.best_thumbnail(),
                uploader: e.uploader.clone().or_else(|| e.channel.clone()),
            }
        })
        .collect();
    let webpage_url = raw.webpage_url.clone().or_else(|| raw.original_url.clone()).unwrap_or_else(|| input_url.to_string());
    let extractor_key = raw.extractor_key.clone().or_else(|| raw.extractor.clone()).unwrap_or_else(|| "Generic".into());
    let count = raw.playlist_count.map(|c| c as u32).unwrap_or(entries_raw.iter().filter(|v| v.is_object()).count() as u32);
    PlaylistInfo {
        id: raw.id.clone(),
        title: raw.title.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Playlist".into()),
        uploader: raw.uploader.clone().or_else(|| raw.channel.clone()),
        platform: platform_for(&extractor_key, &webpage_url),
        webpage_url,
        count,
        thumbnail: raw.best_thumbnail().or_else(|| entries.iter().find_map(|e| e.thumbnail.clone())),
        entries,
    }
}

// ------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    fn f(id: &str, ext: &str, v: &str, a: &str, w: u32, h: u32, fps: u32, tbr: f64) -> RawFormat {
        RawFormat {
            format_id: Some(id.into()),
            ext: Some(ext.into()),
            vcodec: Some(v.into()),
            acodec: Some(a.into()),
            width: if w > 0 { Some(w as f64) } else { None },
            height: if h > 0 { Some(h as f64) } else { None },
            fps: if fps > 0 { Some(fps as f64) } else { None },
            tbr: Some(tbr),
            protocol: Some("https".into()),
            ..Default::default()
        }
    }

    fn audio(id: &str, ext: &str, a: &str, abr: f64) -> RawFormat {
        RawFormat { abr: Some(abr), ..f(id, ext, "none", a, 0, 0, 0, abr) }
    }

    /// A trimmed-down YouTube format list (real ids and codecs).
    fn youtube() -> Vec<RawFormat> {
        vec![
            RawFormat { format_note: Some("storyboard".into()), ..f("sb0", "mhtml", "none", "none", 160, 90, 0, 0.0) },
            audio("139", "m4a", "mp4a.40.5", 48.8),
            audio("140", "m4a", "mp4a.40.2", 129.5),
            RawFormat { format_note: Some("medium, DRC".into()), ..audio("140-drc", "m4a", "mp4a.40.2", 129.5) },
            audio("249", "webm", "opus", 50.0),
            audio("251", "webm", "opus", 135.0),
            f("18", "mp4", "avc1.42001E", "mp4a.40.2", 640, 360, 30, 500.0),
            f("134", "mp4", "avc1.4d401e", "none", 640, 360, 30, 300.0),
            f("243", "webm", "vp9", "none", 640, 360, 30, 260.0),
            f("136", "mp4", "avc1.4d401f", "none", 1280, 720, 30, 1100.0),
            f("247", "webm", "vp9", "none", 1280, 720, 30, 800.0),
            f("398", "mp4", "av01.0.05M.08", "none", 1280, 720, 30, 700.0),
            f("299", "mp4", "avc1.64002a", "none", 1920, 1080, 60, 4200.0),
            f("303", "webm", "vp9", "none", 1920, 1080, 60, 2600.0),
            f("399", "mp4", "av01.0.09M.08", "none", 1920, 1080, 60, 2100.0),
            f("315", "webm", "vp9", "none", 3840, 2160, 60, 18000.0),
            f("401", "mp4", "av01.0.13M.08", "none", 3840, 2160, 60, 14000.0),
        ]
    }

    #[test]
    fn youtube_tiers_and_picks() {
        let a = analyze_formats(&youtube(), Some(212.0));
        let labels: Vec<u32> = a.tiers.iter().map(|t| t.label).collect();
        assert_eq!(labels, vec![2160, 1080, 720, 360]);

        let t1080 = &a.tiers[1];
        assert_eq!(t1080.mp4.video_id, "299");
        assert_eq!(t1080.mp4.audio_id.as_deref(), Some("140"));
        assert_eq!(t1080.mp4.vcodec, "H.264");
        assert_eq!(t1080.mp4.fps, Some(60));
        assert_eq!(t1080.mkv.video_id, "399");
        assert_eq!(t1080.mkv.audio_id.as_deref(), Some("251"));
        assert!(!t1080.mp4.combined);

        // 4K has no H.264: MP4 falls back to the most compatible remaining codec (AV1).
        let t4k = &a.tiers[0];
        assert_eq!(t4k.mp4.video_id, "401");
        assert_eq!(t4k.mp4.vcodec, "AV1");

        // Sizes estimated from bitrate * duration when the site gives none.
        let s = t1080.mp4.size.unwrap();
        let expected = ((4200.0 + 129.5) * 125.0 * 212.0) as u64;
        assert!((s as i64 - expected as i64).abs() < 2000, "{s} vs {expected}");
        assert!(!t1080.mp4.size_exact);
    }

    #[test]
    fn opaque_default_hls_audio_does_not_win() {
        // Real "Me at the zoo" shape: HLS audio labelled "Default" with no codec/bitrate.
        let mut hls = audio("234", "mp4", "none", 0.0);
        hls.acodec = None;
        hls.abr = None;
        hls.tbr = None;
        hls.format_note = Some("Default, high".into());
        hls.protocol = Some("m3u8_native".into());
        let formats = vec![hls, audio("139", "m4a", "mp4a.40.5", 49.0), audio("140", "m4a", "mp4a.40.2", 130.0), audio("250", "webm", "opus", 60.0)];
        let a = analyze_formats(&formats, Some(19.0));
        assert_eq!(a.audio.best.as_ref().unwrap().format_id, "140");
        assert!(a.audio.tracks.iter().all(|t| t.format_id != "234"));
    }

    #[test]
    fn audio_tracks_skip_drc_duplicates() {
        let a = analyze_formats(&youtube(), Some(212.0));
        let ids: Vec<&str> = a.audio.tracks.iter().map(|t| t.format_id.as_str()).collect();
        assert_eq!(ids, vec!["251", "140", "249", "139"]);
        assert_eq!(a.audio.best.unwrap().format_id, "251");
        assert!(!a.audio.from_combined);
    }

    #[test]
    fn vertical_video_uses_short_side() {
        let formats = vec![
            f("h264_1080p", "mp4", "h264", "aac", 1080, 1920, 30, 2500.0),
            f("bytevc1_720p", "mp4", "h265", "aac", 720, 1280, 30, 900.0),
            RawFormat { format_note: Some("Download video, watermarked".into()), ..f("download", "mp4", "h264", "aac", 720, 1280, 30, 1500.0) },
            f("h264_720p", "mp4", "h264", "aac", 720, 1280, 30, 1200.0),
        ];
        let a = analyze_formats(&formats, Some(30.0));
        let labels: Vec<u32> = a.tiers.iter().map(|t| t.label).collect();
        assert_eq!(labels, vec![1080, 720]);
        let t720 = &a.tiers[1];
        assert_eq!(t720.mp4.video_id, "h264_720p", "watermarked copy must lose");
        assert!(t720.mp4.combined);
        assert_eq!(t720.mkv.video_id, "bytevc1_720p");
        // No separate audio: audio mode pulls from a combined file.
        assert!(a.audio.from_combined);
    }

    #[test]
    fn odd_heights_snap_or_stay() {
        assert_eq!(normalize_tier(1072), 1080);
        assert_eq!(normalize_tier(718), 720);
        assert_eq!(normalize_tier(576), 576);
        assert_eq!(normalize_tier(540), 540);
    }

    #[test]
    fn ultrawide_keeps_site_label() {
        let mut fm = f("137", "mp4", "avc1", "none", 1920, 800, 24, 3000.0);
        fm.format_note = Some("1080p".into());
        assert_eq!(tier_label(&fm), Some(1080));
        fm.format_note = Some("DASH video".into());
        assert_eq!(tier_label(&fm), Some(800));
    }

    #[test]
    fn audio_only_site_has_no_tiers() {
        let formats = vec![audio("http_mp3_128", "mp3", "mp3", 128.0), audio("hls_opus_64", "opus", "opus", 64.0)];
        let a = analyze_formats(&formats, Some(180.0));
        assert!(a.tiers.is_empty());
        assert!(!a.has_video);
        assert_eq!(a.audio.tracks.len(), 2);
    }

    #[test]
    fn unknown_resolution_gives_single_best_card() {
        let mut direct = f("0", "mp4", "", "", 0, 0, 0, 0.0);
        direct.vcodec = None;
        direct.acodec = None;
        let a = analyze_formats(&[direct], None);
        assert_eq!(a.tiers.len(), 1);
        assert_eq!(a.tiers[0].label, 0);
        assert!(a.tiers[0].mp4.combined);
    }

    #[test]
    fn video_only_without_any_audio_is_silent() {
        let formats = vec![f("v1", "mp4", "avc1", "none", 1280, 720, 30, 1000.0)];
        let a = analyze_formats(&formats, Some(10.0));
        assert!(a.tiers[0].mp4.silent);
        assert!(!a.audio.available);
    }

    #[test]
    fn parses_lenient_json() {
        let json = r#"{"id": 123, "title": "T", "duration": "12.5", "formats": null, "url": "https://x/y.mp4", "ext": "mp4", "is_live": null}"#;
        let (info, _) = RawInfo::parse(json).unwrap();
        assert_eq!(info.id.as_deref(), Some("123"));
        assert_eq!(info.duration, Some(12.5));
        assert_eq!(info.formats.len(), 1, "inline format becomes the list");
    }
}
