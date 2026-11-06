//! Display info for the site a link comes from (badge name + accent colour).
//! Plain text labels only: no third-party logos are bundled.

use crate::model::PlatformInfo;

const TABLE: &[(&str, &str, &str, &str)] = &[
    // (match on extractor key prefix, key, display name, colour)
    ("youtube", "youtube", "YouTube", "#ff4e45"),
    ("tiktok", "tiktok", "TikTok", "#2ee6e6"),
    ("instagram", "instagram", "Instagram", "#f2547d"),
    ("twitter", "x", "X", "#d7dde2"),
    ("vimeo", "vimeo", "Vimeo", "#36b8f0"),
    ("twitch", "twitch", "Twitch", "#9b6bff"),
    ("soundcloud", "soundcloud", "SoundCloud", "#ff7a2e"),
    ("reddit", "reddit", "Reddit", "#ff6a33"),
    ("facebook", "facebook", "Facebook", "#4c8dff"),
    ("dailymotion", "dailymotion", "Dailymotion", "#4fb3ff"),
    ("bilibili", "bilibili", "Bilibili", "#43c3f0"),
    ("bandcamp", "bandcamp", "Bandcamp", "#3fb7c9"),
    ("pinterest", "pinterest", "Pinterest", "#f0414e"),
    ("rumble", "rumble", "Rumble", "#8fd14f"),
    ("kick", "kick", "Kick", "#68e24a"),
    ("threads", "threads", "Threads", "#d7dde2"),
    ("bluesky", "bluesky", "Bluesky", "#4fa3ff"),
    ("linkedin", "linkedin", "LinkedIn", "#4a9be0"),
    ("snapchat", "snapchat", "Snapchat", "#f7e94a"),
    ("tumblr", "tumblr", "Tumblr", "#7a8fb3"),
    ("streamable", "streamable", "Streamable", "#4f9bff"),
    ("mixcloud", "mixcloud", "Mixcloud", "#6c7cff"),
    ("archiveorg", "archive", "Archive.org", "#c9b28a"),
    ("niconico", "niconico", "Niconico", "#d9d9d9"),
    ("vk", "vk", "VK", "#5a8fd6"),
    ("ted", "ted", "TED", "#ff4b3e"),
];

pub fn platform_for(extractor_key: &str, url: &str) -> PlatformInfo {
    let key = extractor_key.to_ascii_lowercase();
    for (prefix, k, name, color) in TABLE {
        if key.starts_with(prefix) {
            return PlatformInfo { key: (*k).into(), name: (*name).into(), color: (*color).into() };
        }
    }
    // Generic extractor: show the host so the badge still says something useful.
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_else(|| "web".into());
    PlatformInfo { key: "web".into(), name: host, color: "#9aa9b4".into() }
}

pub fn scraped(url: &str) -> PlatformInfo {
    let mut p = platform_for("", url);
    p.key = "scraped".into();
    p.color = "#f2c14e".into();
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_and_generic() {
        assert_eq!(platform_for("YoutubeTab", "").name, "YouTube");
        assert_eq!(platform_for("TikTok", "").key, "tiktok");
        assert_eq!(platform_for("Twitter", "").name, "X");
        let g = platform_for("Generic", "https://www.example.org/video");
        assert_eq!(g.key, "web");
        assert_eq!(g.name, "example.org");
    }
}
