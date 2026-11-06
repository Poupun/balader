//! Thumbnails are fetched by Rust and handed to the UI as data URLs, so the
//! webview never talks to third-party CDNs directly (strict CSP, no referrer
//! games, works for CDNs that want a Referer).

use std::collections::VecDeque;
use std::sync::Mutex;

use base64::Engine as _;

use crate::error::{CoreError, ErrorCode, Result};
use crate::sniff::BROWSER_UA;

const MAX_BYTES: usize = 8 * 1024 * 1024;
const CACHE: usize = 48;

pub struct Thumbs {
    http: reqwest::Client,
    cache: Mutex<VecDeque<(String, String)>>,
}

impl Thumbs {
    pub fn new(http: reqwest::Client) -> Self {
        Thumbs { http, cache: Mutex::new(VecDeque::new()) }
    }

    pub async fn get(&self, url: &str, referer: Option<&str>) -> Result<String> {
        if let Some((_, data)) = self.cache.lock().unwrap().iter().find(|(u, _)| u == url) {
            return Ok(data.clone());
        }
        let parsed = url::Url::parse(url).map_err(|_| CoreError::coded(ErrorCode::InvalidUrl, "bad thumbnail url"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(CoreError::coded(ErrorCode::InvalidUrl, "bad thumbnail url"));
        }
        let mut req = self.http.get(url).header(reqwest::header::USER_AGENT, BROWSER_UA);
        if let Some(r) = referer {
            req = req.header(reqwest::header::REFERER, r);
        }
        let resp = req.send().await?.error_for_status()?;
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
            .unwrap_or_default();
        let bytes = resp.bytes().await?;
        if bytes.len() > MAX_BYTES {
            return Err(CoreError::coded(ErrorCode::Unknown, "thumbnail too large"));
        }
        let mime = if ctype.starts_with("image/") { ctype } else { sniff_mime(&bytes).to_string() };
        if !mime.starts_with("image/") {
            return Err(CoreError::coded(ErrorCode::Unknown, "not an image"));
        }
        let data = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
        let mut cache = self.cache.lock().unwrap();
        cache.push_front((url.to_string(), data.clone()));
        cache.truncate(CACHE);
        Ok(data)
    }
}

fn sniff_mime(b: &[u8]) -> &'static str {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if b.starts_with(b"\x89PNG") {
        "image/png"
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn mime_sniffing() {
        assert_eq!(super::sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(super::sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
        assert_eq!(super::sniff_mime(b"<html>"), "application/octet-stream");
    }
}
