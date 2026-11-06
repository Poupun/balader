//! Settings and history persisted as JSON (atomic writes).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use crate::error::Result;
use crate::model::{HistoryEntry, Settings};
use crate::util::{path_str, write_atomic};

const BROWSERS: &[&str] = &["chrome", "chromium", "firefox", "safari", "edge", "brave", "opera", "vivaldi", "whale"];
const HISTORY_CAP: usize = 300;

pub struct SettingsStore {
    path: PathBuf,
    default_output: PathBuf,
    value: RwLock<Settings>,
}

pub fn sanitize(mut s: Settings, default_output: &Path) -> Settings {
    if s.output_dir.trim().is_empty() {
        s.output_dir = path_str(default_output);
    }
    s.max_concurrent = s.max_concurrent.clamp(1, 4);
    s.volume = if s.volume.is_finite() { s.volume.clamp(0.0, 1.0) } else { 0.6 };
    s.cookies_browser = s
        .cookies_browser
        .map(|b| b.trim().to_ascii_lowercase())
        .filter(|b| BROWSERS.contains(&b.as_str()));
    let q = s.audio_quality.trim().to_ascii_lowercase();
    s.audio_quality = if q == "best" || q == "original" || (!q.is_empty() && q.len() <= 4 && q.chars().all(|c| c.is_ascii_digit())) { q } else { "best".into() };
    s.sub_langs = s.sub_langs.trim().chars().take(200).collect();
    if s.sub_langs.is_empty() {
        s.sub_langs = "en.*".into();
    }
    s
}

impl SettingsStore {
    pub fn load(path: PathBuf, default_output: PathBuf) -> Self {
        let value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
            .unwrap_or_default();
        let value = sanitize(value, &default_output);
        SettingsStore { path, default_output, value: RwLock::new(value) }
    }

    pub fn get(&self) -> Settings {
        self.value.read().unwrap().clone()
    }

    pub fn default_output(&self) -> PathBuf {
        self.default_output.clone()
    }

    pub fn save(&self, s: Settings) -> Result<Settings> {
        let s = sanitize(s, &self.default_output);
        write_atomic(&self.path, &serde_json::to_vec_pretty(&s)?)?;
        *self.value.write().unwrap() = s.clone();
        Ok(s)
    }
}

pub struct HistoryStore {
    path: PathBuf,
    items: Mutex<Vec<HistoryEntry>>,
}

impl HistoryStore {
    pub fn load(path: PathBuf) -> Self {
        let items = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        HistoryStore { path, items: Mutex::new(items) }
    }

    pub fn list(&self) -> Vec<HistoryEntry> {
        self.items.lock().unwrap().clone()
    }

    fn persist(&self, items: &[HistoryEntry]) {
        match serde_json::to_vec_pretty(items) {
            Ok(bytes) => {
                if let Err(e) = write_atomic(&self.path, &bytes) {
                    log::warn!("history not saved: {e}");
                }
            }
            Err(e) => log::warn!("history not serialised: {e}"),
        }
    }

    pub fn add(&self, entry: HistoryEntry) {
        let mut items = self.items.lock().unwrap();
        items.retain(|e| e.id != entry.id);
        items.insert(0, entry);
        items.truncate(HISTORY_CAP);
        self.persist(&items);
    }

    pub fn remove(&self, id: &str) {
        let mut items = self.items.lock().unwrap();
        items.retain(|e| e.id != id);
        self.persist(&items);
    }

    pub fn clear(&self) {
        let mut items = self.items.lock().unwrap();
        items.clear();
        self.persist(&items);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Mode;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("balader-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn settings_roundtrip_and_sanitize() {
        let d = tmp("settings");
        let store = SettingsStore::load(d.join("settings.json"), d.join("Downloads"));
        assert!(store.get().output_dir.ends_with("Downloads"));
        let mut s = store.get();
        s.max_concurrent = 99;
        s.cookies_browser = Some("Netscape".into());
        s.audio_quality = "lots".into();
        s.volume = f64::NAN;
        let saved = store.save(s).unwrap();
        assert_eq!(saved.max_concurrent, 4);
        assert_eq!(saved.cookies_browser, None);
        assert_eq!(saved.audio_quality, "best");
        assert_eq!(saved.volume, 0.6);
        let again = SettingsStore::load(d.join("settings.json"), d.join("Downloads"));
        assert_eq!(again.get(), saved);
        // Unknown/missing fields fall back to defaults instead of failing.
        std::fs::write(d.join("settings.json"), r#"{"maxConcurrent":3,"futureThing":true}"#).unwrap();
        let partial = SettingsStore::load(d.join("settings.json"), d.join("Downloads"));
        assert_eq!(partial.get().max_concurrent, 3);
        assert!(partial.get().embed_thumbnail);
    }

    #[test]
    fn history_caps_and_dedupes() {
        let d = tmp("history");
        let h = HistoryStore::load(d.join("history.json"));
        for i in 0..(HISTORY_CAP + 5) {
            h.add(HistoryEntry {
                id: format!("j{i}"),
                url: "u".into(),
                title: "t".into(),
                thumbnail: None,
                platform: None,
                mode: Mode::Video,
                summary: String::new(),
                files: vec![],
                size: 1,
                finished_at: i as u64,
            });
        }
        assert_eq!(h.list().len(), HISTORY_CAP);
        assert_eq!(h.list()[0].id, format!("j{}", HISTORY_CAP + 4));
        h.remove(&format!("j{}", HISTORY_CAP + 4));
        assert_eq!(HistoryStore::load(d.join("history.json")).list().len(), HISTORY_CAP - 1);
        h.clear();
        assert!(h.list().is_empty());
    }
}
