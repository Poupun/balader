//! "Deal": ask yt-dlp what a link holds, without downloading anything.

use std::time::Duration;

use crate::engine::Engine;
use crate::error::{CoreError, ErrorCode, Result, classify_ytdlp_error};
use crate::formats::{RawInfo, media_info, playlist_info};
use crate::model::{ProbeResult, Settings};
use crate::{proc, sniff};

/// Accepts what people paste: bare domains, <angle brackets>, quotes, spaces.
pub fn normalize_url(input: &str) -> Result<String> {
    let s = input.trim().trim_matches(|c: char| c == '<' || c == '>' || c == '"' || c == '\'' || c.is_whitespace());
    if s.is_empty() {
        return Err(CoreError::coded(ErrorCode::InvalidUrl, "Paste a link first."));
    }
    let with_scheme = if s.contains("://") { s.to_string() } else { format!("https://{s}") };
    let url = url::Url::parse(&with_scheme).map_err(|_| CoreError::coded(ErrorCode::InvalidUrl, "That doesn't look like a link."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CoreError::coded(ErrorCode::InvalidUrl, "Only web links (http/https) can be grabbed."));
    }
    match url.host_str() {
        Some(h) if h.contains('.') || h == "localhost" => Ok(url.to_string()),
        _ => Err(CoreError::coded(ErrorCode::InvalidUrl, "That doesn't look like a link.")),
    }
}

pub fn probe_args(engine: &Engine, settings: &Settings, url: &str) -> Vec<String> {
    let mut args = engine.base_args();
    args.extend(["-J", "--flat-playlist", "--no-playlist", "--socket-timeout", "20"].map(String::from));
    if let Some(b) = settings.cookies_browser.as_deref().filter(|b| !b.trim().is_empty()) {
        args.push("--cookies-from-browser".into());
        args.push(b.trim().to_ascii_lowercase());
    }
    args.push("--".into());
    args.push(url.to_string());
    args
}

/// Turn yt-dlp's -J output into a probe result.
pub fn interpret(json: &str, url: &str) -> Result<ProbeResult> {
    let (raw, _) = RawInfo::parse(json)?;
    if raw.is_playlist() {
        let entries = raw.entries.as_deref().unwrap_or(&[]);
        // A "playlist" of one fully-extracted video (tweets, carousels) is just a video.
        if entries.len() == 1 && entries[0].get("formats").is_some() {
            let (single, _) = RawInfo::parse(&entries[0].to_string())?;
            return finish_video(&single, url);
        }
        return Ok(ProbeResult::Playlist { playlist: playlist_info(&raw, url) });
    }
    finish_video(&raw, url)
}

fn finish_video(raw: &RawInfo, url: &str) -> Result<ProbeResult> {
    let media = media_info(raw, url);
    if media.live {
        return Err(CoreError::coded(ErrorCode::Live, "This stream is live right now.")
            .with_hint("Live recording isn't supported yet. Come back once it has ended."));
    }
    if media.tiers.is_empty() && !media.audio.available {
        return Err(CoreError::coded(ErrorCode::Unavailable, "No downloadable media in there."));
    }
    Ok(ProbeResult::Video { media })
}

/// Direct file links come without a size: ask the server (HEAD) so the card
/// can show one.
async fn fill_direct_size(http: &reqwest::Client, json: &str, r: &mut ProbeResult) {
    let ProbeResult::Video { media } = r else { return };
    if media.format_count != 1 || media.tiers.iter().all(|t| t.mp4.size.is_some()) {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return };
    let f = &v["formats"][0];
    if !matches!(f["protocol"].as_str().unwrap_or("https"), "http" | "https") {
        return;
    }
    let Some(url) = f["url"].as_str().or(v["url"].as_str()) else { return };
    let Ok(Ok(resp)) = tokio::time::timeout(Duration::from_secs(8), http.head(url).send()).await else { return };
    let len = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0);
    if let Some(len) = len {
        for t in &mut media.tiers {
            for p in [&mut t.mp4, &mut t.mkv] {
                p.size = Some(len);
                p.video_size = Some(len);
                p.size_exact = true;
            }
        }
    }
}

/// Direct file links come without a duration either: ffprobe reads it from
/// the file's header (a fraction of a second), so the timeline can offer a cut.
async fn fill_direct_duration(engine: &Engine, json: &str, r: &mut ProbeResult) {
    let ProbeResult::Video { media } = r else { return };
    if media.duration.is_some() || media.format_count != 1 || !media.has_video && !media.audio.available {
        return;
    }
    let Some(ffprobe) = engine.ffprobe_path() else { return };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return };
    let f = &v["formats"][0];
    if !matches!(f["protocol"].as_str().unwrap_or("https"), "http" | "https") {
        return;
    }
    let Some(url) = f["url"].as_str().or(v["url"].as_str()) else { return };
    let args: Vec<String> = ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", "--", url].map(String::from).to_vec();
    let ca = engine.ca_bundle();
    let envs: Vec<(&str, &std::path::Path)> = ca.as_deref().map(|p| ("SSL_CERT_FILE", p)).into_iter().collect();
    let Ok(out) = proc::run_with_env(&ffprobe, &args, &envs, Duration::from_secs(10)).await else { return };
    let duration = out.stdout.trim().parse::<f64>().ok().filter(|d| d.is_finite() && *d > 0.0);
    if let Some(d) = duration {
        media.duration = Some((d * 1000.0).round() / 1000.0);
    }
}

pub async fn probe(engine: &Engine, settings: &Settings, http: &reqwest::Client, input: &str) -> Result<ProbeResult> {
    let url = normalize_url(input)?;
    let ytdlp = engine.ytdlp_path()?;
    let args = probe_args(engine, settings, &url);
    log::info!("probe {url}");
    let out = proc::run(&ytdlp, &args, Duration::from_secs(120)).await?;
    if out.timed_out {
        return Err(CoreError::coded(ErrorCode::Timeout, "The site took too long to answer.").with_hint("Try again in a moment."));
    }
    // yt-dlp can exit non-zero yet still print usable JSON (e.g. a playlist with a broken entry).
    let json = out.stdout.trim();
    if json.starts_with('{') {
        match interpret(json, &url) {
            Ok(mut r) => {
                fill_direct_size(http, json, &mut r).await;
                fill_direct_duration(engine, json, &mut r).await;
                return Ok(r);
            }
            Err(e) if out.success => return Err(e),
            Err(_) => {}
        }
    }
    let err = classify_ytdlp_error(&out.stderr);
    if err.code() == ErrorCode::Unsupported {
        if let Ok(candidates) = sniff::sniff(http, &url).await {
            if !candidates.is_empty() {
                return Ok(ProbeResult::Sniffed { page: url, candidates });
            }
        }
        return Err(CoreError::coded(ErrorCode::Unsupported, "No video found on that page.")
            .with_hint("Balader asked yt-dlp and scraped the page itself: nothing playable there.")
            .with_detail(out.stderr.chars().take(4000).collect::<String>()));
    }
    Err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_forgiving() {
        assert_eq!(normalize_url("  youtube.com/watch?v=abc ").unwrap(), "https://youtube.com/watch?v=abc");
        assert_eq!(normalize_url("<https://vimeo.com/1>").unwrap(), "https://vimeo.com/1");
        assert!(normalize_url("").is_err());
        assert!(normalize_url("hello").is_err());
        assert!(normalize_url("ftp://x.com/a").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn interprets_flat_playlist() {
        let json = r#"{"_type":"playlist","id":"PL1","title":"Mix","extractor_key":"YoutubeTab","webpage_url":"https://www.youtube.com/playlist?list=PL1",
            "playlist_count":2,"entries":[{"_type":"url","id":"a","title":"One","url":"https://www.youtube.com/watch?v=a","duration":61},
            {"_type":"url","id":"b","title":"Two","url":"https://www.youtube.com/watch?v=b","thumbnails":[{"url":"https://i.ytimg.com/vi/b/hq.jpg","width":480}]}]}"#;
        let ProbeResult::Playlist { playlist } = interpret(json, "https://www.youtube.com/playlist?list=PL1").unwrap() else { panic!() };
        assert_eq!(playlist.count, 2);
        assert_eq!(playlist.platform.name, "YouTube");
        assert_eq!(playlist.entries[0].title.as_deref(), Some("One"));
        assert_eq!(playlist.thumbnail.as_deref(), Some("https://i.ytimg.com/vi/b/hq.jpg"));
    }

    #[test]
    fn single_entry_playlist_is_a_video() {
        let json = r#"{"_type":"playlist","entries":[{"id":"t1","title":"Tweet","extractor_key":"Twitter","formats":[
            {"format_id":"http-720","ext":"mp4","vcodec":"avc1","acodec":"mp4a","width":720,"height":1280,"tbr":2000}]}]}"#;
        let ProbeResult::Video { media } = interpret(json, "https://x.com/a/status/1").unwrap() else { panic!() };
        assert_eq!(media.platform.name, "X");
        assert_eq!(media.tiers[0].label, 720);
    }

    #[test]
    fn live_is_refused_politely() {
        let json = r#"{"id":"l","title":"Live","is_live":true,"formats":[{"format_id":"hls","ext":"mp4","vcodec":"avc1","acodec":"mp4a","height":720,"width":1280}]}"#;
        let e = interpret(json, "https://www.youtube.com/watch?v=l").unwrap_err();
        assert_eq!(e.code(), ErrorCode::Live);
    }
}
