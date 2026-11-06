//! Errors. Internally we use `CoreError`; anything that crosses to the UI is
//! flattened into an `ErrorPayload` with a stable machine `code`, a human
//! message and an optional hint ("try cookies from your browser"...).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorCode {
    InvalidUrl,
    Unsupported,
    Private,
    Unavailable,
    LoginRequired,
    BotCheck,
    RateLimited,
    GeoBlocked,
    Live,
    Drm,
    Network,
    Timeout,
    EngineMissing,
    EngineBusy,
    Checksum,
    Cancelled,
    NotFound,
    BadRequest,
    Io,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ErrorPayload {
    pub code: ErrorCode,
    pub message: String,
    pub hint: Option<String>,
    /// Raw tool output, for the "details" fold-out and bug reports.
    pub detail: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("{message}")]
    Coded {
        code: ErrorCode,
        message: String,
        hint: Option<String>,
        detail: Option<String>,
    },
    #[error("i/o: {0}")]
    Io(#[from] std::io::Error),
    #[error("network: {0}")]
    Http(#[from] reqwest::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
}

pub type Result<T> = std::result::Result<T, CoreError>;

impl CoreError {
    pub fn coded(code: ErrorCode, message: impl Into<String>) -> Self {
        CoreError::Coded { code, message: message.into(), hint: None, detail: None }
    }

    pub fn with_hint(self, hint: impl Into<String>) -> Self {
        match self {
            CoreError::Coded { code, message, detail, .. } => {
                CoreError::Coded { code, message, hint: Some(hint.into()), detail }
            }
            other => other,
        }
    }

    pub fn with_detail(self, detail: impl Into<String>) -> Self {
        match self {
            CoreError::Coded { code, message, hint, .. } => {
                CoreError::Coded { code, message, hint, detail: Some(detail.into()) }
            }
            other => other,
        }
    }

    pub fn code(&self) -> ErrorCode {
        match self {
            CoreError::Coded { code, .. } => *code,
            CoreError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            CoreError::Io(_) => ErrorCode::Io,
            CoreError::Http(e) if e.is_timeout() => ErrorCode::Timeout,
            CoreError::Http(_) => ErrorCode::Network,
            CoreError::Json(_) | CoreError::Zip(_) => ErrorCode::Unknown,
        }
    }

    pub fn payload(&self) -> ErrorPayload {
        match self {
            CoreError::Coded { code, message, hint, detail } => ErrorPayload {
                code: *code,
                message: message.clone(),
                hint: hint.clone(),
                detail: detail.clone(),
            },
            other => ErrorPayload {
                code: other.code(),
                message: match other.code() {
                    ErrorCode::Network => "Network trouble. Check your connection and try again.".into(),
                    ErrorCode::Timeout => "That took too long. Try again in a moment.".into(),
                    _ => other.to_string(),
                },
                hint: None,
                detail: Some(other.to_string()),
            },
        }
    }
}

impl From<CoreError> for ErrorPayload {
    fn from(e: CoreError) -> Self {
        e.payload()
    }
}

/// Map yt-dlp's stderr into a friendly, coded error. The patterns are the
/// stable English messages yt-dlp has printed for years.
pub fn classify_ytdlp_error(stderr: &str) -> CoreError {
    let last_error = stderr
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with("ERROR:"))
        .map(|l| l.trim().trim_start_matches("ERROR:").trim().to_string())
        .unwrap_or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string());
    let lower = last_error.to_lowercase();
    let all_lower = stderr.to_lowercase();
    let detail = tail(stderr, 4000);
    // YouTube answers a throttled network with 429s in the warnings and then a
    // vague "Video unavailable": that's rate limiting, not a dead video.
    let throttled = all_lower.contains("http error 429") || all_lower.contains("too many requests");

    let (code, message, hint): (ErrorCode, String, Option<&str>) = if lower.contains("unable to obtain file audio codec")
        || lower.contains("does not contain any audio")
        || lower.contains("contains no audio")
    {
        (ErrorCode::Unavailable, "There's no sound in this one.".into(), Some("It's a silent video: grab it as VIDEO instead."))
    } else if lower.contains("unsupported url") {
        (ErrorCode::Unsupported, "No extractor knows this site.".into(), Some("Balader also tried scraping the page for media."))
    } else if lower.contains("is not a valid url") || lower.contains("invalid url") {
        (ErrorCode::InvalidUrl, "That doesn't look like a link.".into(), None)
    } else if lower.contains("sign in to confirm") || lower.contains("not a bot") {
        (
            ErrorCode::BotCheck,
            "The site wants to check you're human.".into(),
            Some("Turn on \"Cookies from browser\" in Settings, using a browser where you're signed in."),
        )
    } else if lower.contains("private video") || lower.contains("this video is private") || lower.contains("is private") {
        (ErrorCode::Private, "This video is private.".into(), Some("If you can watch it while signed in, use \"Cookies from browser\" in Settings."))
    } else if lower.contains("drm") {
        (ErrorCode::Drm, "This video is DRM-protected and can't be saved.".into(), None)
    } else if lower.contains("not available in your country") || lower.contains("geo") && lower.contains("restrict") {
        (ErrorCode::GeoBlocked, "This video is blocked in your region.".into(), None)
    } else if lower.contains("live event will begin")
        || lower.contains("premieres in")
        || lower.contains("is live")
        || lower.contains("this live stream")
    {
        (ErrorCode::Live, "This stream is live or hasn't started yet.".into(), Some("Come back once it has ended."))
    } else if lower.contains("login required")
        || lower.contains("log in")
        || lower.contains("login")
        || lower.contains("cookies")
        || lower.contains("authentication")
        || lower.contains("age-restricted")
        || lower.contains("confirm your age")
    {
        (
            ErrorCode::LoginRequired,
            "This one needs you to be signed in.".into(),
            Some("Turn on \"Cookies from browser\" in Settings, using a browser where you're signed in."),
        )
    } else if throttled || lower.contains("rate limit") || lower.contains("rate-limit") {
        (
            ErrorCode::RateLimited,
            "The site is rate-limiting this network.".into(),
            Some("Wait a few minutes, or turn on \"Cookies from browser\" in Settings."),
        )
    } else if lower.contains("video unavailable")
        || lower.contains("is unavailable")
        || lower.contains("has been removed")
        || lower.contains("does not exist")
        || lower.contains("not found")
        || lower.contains("404")
        || lower.contains("no video formats found")
        || lower.contains("no video could be found")
    {
        (ErrorCode::Unavailable, "That video is unavailable.".into(), None)
    } else if lower.contains("timed out") || lower.contains("timeout") {
        (ErrorCode::Timeout, "The site took too long to answer.".into(), Some("Try again in a moment."))
    } else if lower.contains("unable to download")
        || lower.contains("connection")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
        || lower.contains("getaddrinfo")
        || lower.contains("ssl")
    {
        (ErrorCode::Network, "Couldn't reach the site.".into(), Some("Check your connection."))
    } else {
        let msg = if last_error.is_empty() { "Something went wrong.".to_string() } else { short(&last_error, 220) };
        (ErrorCode::Unknown, msg, None)
    };

    let mut err = CoreError::coded(code, message).with_detail(detail);
    if let Some(h) = hint {
        err = err.with_hint(h);
    }
    err
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_common_failures() {
        let cases = [
            ("ERROR: Unsupported URL: https://example.com/", ErrorCode::Unsupported),
            ("ERROR: [youtube] abc: Private video. Sign in if you've been granted access", ErrorCode::Private),
            ("ERROR: [youtube] abc: Sign in to confirm you're not a bot", ErrorCode::BotCheck),
            ("ERROR: [youtube] abc: Video unavailable", ErrorCode::Unavailable),
            ("ERROR: [instagram] abc: Requested content is not available, rate-limit reached or login required", ErrorCode::LoginRequired),
            ("ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests", ErrorCode::RateLimited),
            ("ERROR: [youtube] abc: This live event will begin in 3 hours.", ErrorCode::Live),
            ("ERROR: 'foo' is not a valid URL.", ErrorCode::InvalidUrl),
            ("ERROR: something odd", ErrorCode::Unknown),
            ("ERROR: [youtube] x: This video is unavailable", ErrorCode::Unavailable),
            ("ERROR: Postprocessing: WARNING: unable to obtain file audio codec with ffprobe", ErrorCode::Unavailable),
            (
                "WARNING: [youtube] x: Unable to download webpage: HTTP Error 429: Too Many Requests\nERROR: [youtube] x: Video unavailable",
                ErrorCode::RateLimited,
            ),
        ];
        for (stderr, code) in cases {
            assert_eq!(classify_ytdlp_error(stderr).code(), code, "{stderr}");
        }
    }

    #[test]
    fn keeps_last_error_line_and_detail() {
        let stderr = "WARNING: meh\nERROR: first\nnoise\nERROR: Video unavailable\n";
        let p = classify_ytdlp_error(stderr).payload();
        assert_eq!(p.code, ErrorCode::Unavailable);
        assert!(p.detail.unwrap().contains("WARNING: meh"));
    }
}
