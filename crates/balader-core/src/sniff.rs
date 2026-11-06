//! Balader's own little scraper. When yt-dlp has no extractor for a site, we
//! fetch the page and look for media the way a person with devtools would:
//! Open Graph tags, <video>/<audio>/<source> elements, JSON-LD `contentUrl`,
//! and raw media URLs (including JSON-escaped ones) in the page source.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::SniffCandidate;

pub const BROWSER_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CANDIDATES: usize = 12;

static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<meta\b[^>]*>").unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)([a-z:_\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap());
static MEDIA_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<(video|audio|source)\b[^>]*>").unwrap());
static JSONLD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)"contentUrl"\s*:\s*"([^"]+)""#).unwrap());
static RAW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)https?:(?://|\\/\\/)[^\s"'<>()]+?\.(?:mp4|m4v|webm|mov|m3u8|mpd|mp3|m4a|ogg|oga|wav|flac)(?:\?[^\s"'<>()]*)?"#).unwrap()
});

fn attrs(tag: &str) -> Vec<(String, String)> {
    ATTR.captures_iter(tag)
        .map(|c| (c[1].to_ascii_lowercase(), c.get(2).or(c.get(3)).map(|m| m.as_str().to_string()).unwrap_or_default()))
        .collect()
}

fn decode(s: &str) -> String {
    s.replace("\\/", "/").replace("\\u002F", "/").replace("\\u0026", "&").replace("&amp;", "&").replace("&#38;", "&").trim().to_string()
}

fn ext_of(u: &Url) -> Option<String> {
    let path = u.path();
    let last = path.rsplit('/').next()?;
    let (_, ext) = last.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    (ext.len() <= 4 && ext.chars().all(|c| c.is_ascii_alphanumeric())).then_some(ext)
}

fn kind_for(ext: Option<&str>, hint: &str) -> &'static str {
    match ext {
        Some("m3u8") | Some("mpd") => "stream",
        Some("mp3") | Some("m4a") | Some("ogg") | Some("oga") | Some("wav") | Some("flac") => "audio",
        Some(_) => "video",
        None if hint.contains("audio") => "audio",
        None => "video",
    }
}

pub fn extract_candidates(html: &str, base: &str) -> Vec<SniffCandidate> {
    let Ok(base_url) = Url::parse(base) else { return Vec::new() };
    let mut found: Vec<SniffCandidate> = Vec::new();
    let mut push = |raw: &str, source: &str, hint: &str| {
        if found.len() >= MAX_CANDIDATES {
            return;
        }
        let decoded = decode(raw);
        if decoded.is_empty() || decoded.starts_with("data:") || decoded.starts_with("blob:") {
            return;
        }
        let Ok(u) = base_url.join(&decoded) else { return };
        if !matches!(u.scheme(), "http" | "https") {
            return;
        }
        let s = u.to_string();
        if found.iter().any(|c| c.url == s) {
            return;
        }
        let ext = ext_of(&u);
        let kind = kind_for(ext.as_deref(), hint);
        let label = match (&ext, kind) {
            (Some(e), "stream") => format!("{} stream", e.to_ascii_uppercase()),
            (Some(e), _) => format!("{} {kind}", e.to_ascii_uppercase()),
            (None, _) => format!("{kind} file"),
        };
        found.push(SniffCandidate { url: s, kind: kind.into(), ext, label, source: source.into() });
    };

    for m in META.find_iter(html) {
        let a = attrs(m.as_str());
        let key = a.iter().find(|(k, _)| k == "property" || k == "name").map(|(_, v)| v.to_ascii_lowercase()).unwrap_or_default();
        let content = a.iter().find(|(k, _)| k == "content").map(|(_, v)| v.as_str()).unwrap_or("");
        if matches!(
            key.as_str(),
            "og:video" | "og:video:url" | "og:video:secure_url" | "twitter:player:stream" | "og:audio" | "og:audio:url" | "og:audio:secure_url"
        ) {
            push(content, "og tags", &key);
        }
    }
    for m in MEDIA_TAG.find_iter(html) {
        let a = attrs(m.as_str());
        let tag = m.as_str().get(1..6).unwrap_or("").to_ascii_lowercase();
        let ty = a.iter().find(|(k, _)| k == "type").map(|(_, v)| v.to_ascii_lowercase()).unwrap_or_default();
        for (k, v) in &a {
            if k == "src" || k == "data-src" {
                push(v, "<video> tag", &format!("{tag} {ty}"));
            }
        }
    }
    for c in JSONLD.captures_iter(html) {
        push(&c[1], "json-ld", "");
    }
    for m in RAW.find_iter(html) {
        push(m.as_str(), "page source", "");
    }
    found
}

pub async fn sniff(http: &reqwest::Client, page_url: &str) -> Result<Vec<SniffCandidate>> {
    let resp = http
        .get(page_url)
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,*/*;q=0.8")
        .send()
        .await?
        .error_for_status()?;
    let final_url = resp.url().to_string();
    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    // A direct media link: nothing to scrape, it *is* the media.
    if ctype.starts_with("video/") || ctype.starts_with("audio/") || ctype.contains("mpegurl") || ctype.contains("dash+xml") {
        let u = Url::parse(&final_url).map_err(|_| CoreError::coded(ErrorCode::InvalidUrl, "Bad link"))?;
        let ext = ext_of(&u);
        let kind = if ctype.starts_with("audio/") { "audio" } else if ctype.contains("mpegurl") || ctype.contains("dash") { "stream" } else { "video" };
        return Ok(vec![SniffCandidate {
            url: final_url,
            kind: kind.into(),
            label: format!("{} {kind}", ext.clone().unwrap_or_else(|| "media".into()).to_ascii_uppercase()),
            ext,
            source: "direct link".into(),
        }]);
    }
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_PAGE_BYTES {
            break;
        }
    }
    let html = String::from_utf8_lossy(&body);
    Ok(extract_candidates(&html, &final_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_media_everywhere() {
        let html = r#"
        <html><head>
          <meta content="https://cdn.example.com/og.mp4?sig=1&amp;t=2" property="og:video">
          <meta property="og:image" content="https://cdn.example.com/poster.jpg">
          <script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn.example.com/ld.webm"}</script>
        </head><body>
          <video controls><source src="/media/clip.mp4" type="video/mp4"></video>
          <audio src='podcast.mp3'></audio>
          <script>var cfg = {"hls":"https:\/\/stream.example.com\/master.m3u8?x=1"};</script>
          <a href="https://cdn.example.com/og.mp4?sig=1&t=2">dupe</a>
        </body></html>"#;
        let c = extract_candidates(html, "https://example.com/watch/42");
        let urls: Vec<&str> = c.iter().map(|c| c.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://cdn.example.com/og.mp4?sig=1&t=2",
                "https://example.com/media/clip.mp4",
                "https://example.com/watch/podcast.mp3",
                "https://cdn.example.com/ld.webm",
                "https://stream.example.com/master.m3u8?x=1",
            ]
        );
        assert_eq!(c[0].source, "og tags");
        assert_eq!(c[2].kind, "audio");
        assert_eq!(c[4].kind, "stream");
        assert_eq!(c[4].label, "M3U8 stream");
    }

    #[test]
    fn ignores_junk() {
        let html = r#"<video src="blob:https://x/123"></video><meta property="og:video" content="">"#;
        assert!(extract_candidates(html, "https://example.com/").is_empty());
    }
}
