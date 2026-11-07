//! Builds the yt-dlp argument list for a download request. Pure function, so
//! every combination (tier, container, audio format, playlist, cookies...)
//! is covered by unit tests without spawning anything.

use std::path::Path;

use crate::cut;
use crate::model::{AudioFormat, Container, Cut, DownloadRequest, FilenameStyle, Mode, Settings};

/// Every progress line we ask yt-dlp to print starts with this marker.
pub const PROGRESS_PREFIX: &str = "BLDR ";

pub struct ArgsContext<'a> {
    pub settings: &'a Settings,
    /// Final destination folder.
    pub home_dir: &'a Path,
    /// Per-job scratch folder for .part files (deleted on cancel).
    pub temp_dir: &'a Path,
    /// yt-dlp appends final file paths here (one per line).
    pub print_file: &'a Path,
}

/// `download:BLDR {"p":<progress dict>,"i":{format_id,vcodec,...}}`
pub fn progress_template() -> String {
    format!(
        "download:{PROGRESS_PREFIX}{{\"p\":%(progress)j,\"i\":%(info.{{format_id,vcodec,acodec,playlist_index,playlist_count,n_entries}})j}}"
    )
}

pub fn filename_template(style: FilenameStyle) -> &'static str {
    match style {
        FilenameStyle::Title => "%(title).150B.%(ext)s",
        FilenameStyle::TitleId => "%(title).140B [%(id)s].%(ext)s",
        FilenameStyle::UploaderTitle => "%(uploader,channel,creator|Unknown).60B - %(title).120B.%(ext)s",
        FilenameStyle::DateTitle => "%(upload_date>%Y-%m-%d,release_date>%Y-%m-%d|undated)s - %(title).140B.%(ext)s",
    }
}

/// `Title.%(ext)s` → `Title (1m05s-2m30s).%(ext)s`. The tag is literal text.
pub fn tagged_template(template: &str, tag: &str) -> String {
    let tag = tag.replace('%', "%%");
    match template.strip_suffix(".%(ext)s") {
        Some(stem) => format!("{stem}{tag}.%(ext)s"),
        None => format!("{template}{tag}"),
    }
}

/// The part to grab, if any. Cuts never apply to playlists.
pub fn active_cut(req: &DownloadRequest) -> Option<Cut> {
    req.cut.filter(|c| !req.playlist && c.end > c.start)
}

/// Exact cuts re-encode the clip: H.264 that plays everywhere, near
/// transparent (CRF 18), fast preset. The audio is copied untouched.
pub const EXACT_CUT_ARGS: &str = "-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a copy";

/// Does FFmpeg write MP4/MKV (where H.264 can live)? Merged picks use the
/// chosen container; single-file picks keep their own until the remux.
fn h264_friendly_output(req: &DownloadRequest) -> bool {
    let merged = req.video_id.is_some() && !req.combined && !req.silent;
    merged || req.pick_ext.as_deref().is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "mp4" | "m4v" | "mov" | "mkv"))
}

/// yt-dlp hands sections to FFmpeg, which reads only that part from the site.
pub fn cut_args(req: &DownloadRequest) -> Vec<String> {
    let Some(c) = active_cut(req) else { return Vec::new() };
    let mut args = vec!["--download-sections".to_string(), format!("*{:.3}-{:.3}", c.start, c.end)];
    if req.mode == Mode::Video {
        if c.exact {
            // No stream copy: FFmpeg decodes from the keyframe before the
            // start and keeps exactly the requested frames.
            args.push("--force-keyframes-at-cuts".into());
            // Elsewhere (WebM, OGV...) FFmpeg uses the container's own codecs.
            if h264_friendly_output(req) {
                args.push("--downloader-args".into());
                args.push(format!("ffmpeg_o:{EXACT_CUT_ARGS}"));
            }
        } else if req.container == Container::Mp4 && req.pick_vcodec.as_deref() == Some("HEVC") {
            // FFmpeg merges directly (no Merger step), so tag it here.
            args.push("--downloader-args".into());
            args.push("ffmpeg_o:-tag:v hvc1".into());
        }
    }
    args
}

/// yt-dlp treats `%` in some path arguments as template syntax.
fn escape_template_path(p: &Path) -> String {
    p.to_string_lossy().replace('%', "%%")
}

/// Audio quality as yt-dlp wants it: "0" = best VBR, "320K"...
pub fn audio_quality_arg(q: &str) -> String {
    let q = q.trim().to_ascii_lowercase();
    let digits: String = q.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() && digits.len() <= 4 { format!("{digits}K") } else { "0".into() }
}

pub fn format_args(req: &DownloadRequest) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    match req.mode {
        Mode::Video => {
            let selector = match &req.video_id {
                Some(v) if req.silent => format!("{v}/bv*+ba/b"),
                Some(v) if req.combined => format!("{v}/b"),
                Some(v) => match &req.audio_id {
                    Some(a) => format!("{v}+{a}/{v}+ba/bv*+ba/b"),
                    None => format!("{v}+ba/{v}/bv*+ba/b"),
                },
                None => "bv*+ba/b".into(),
            };
            args.push("-f".into());
            args.push(selector);

            // Sort order only matters for the fallbacks (and playlists).
            let mut sort: Vec<String> = Vec::new();
            if let Some(t) = req.tier.filter(|t| *t > 0) {
                sort.push(format!("res:{t}"));
            }
            if req.container == Container::Mp4 {
                sort.push("vcodec:h264".into());
                sort.push("acodec:aac".into());
            }
            if !sort.is_empty() {
                args.push("-S".into());
                args.push(sort.join(","));
            }
            args.push("--merge-output-format".into());
            args.push(req.container.ext().into());
            // Single-file formats (TikTok, HLS...) get rewrapped into the chosen container.
            // Legacy codecs (Theora, VP8) can't live in MP4: re-encode those instead.
            if req.combined || req.playlist || req.video_id.is_none() {
                let legacy = req.pick_vcodec.as_deref().is_some_and(|c| matches!(c.to_ascii_uppercase().as_str(), "VP8" | "THEORA" | "OGV"))
                    || req.pick_ext.as_deref().is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "ogv" | "ogg"));
                if legacy && req.container == Container::Mp4 {
                    args.push("--recode-video".into());
                } else {
                    args.push("--remux-video".into());
                }
                args.push(req.container.ext().into());
            }
            // QuickTime only plays HEVC tagged `hvc1` (many sites ship `hev1`).
            if req.container == Container::Mp4 && req.pick_vcodec.as_deref() == Some("HEVC") {
                for pp in ["Merger", "VideoRemuxer"] {
                    args.push("--postprocessor-args".into());
                    args.push(format!("{pp}+ffmpeg_o:-tag:v hvc1"));
                }
            }
        }
        Mode::Audio => {
            let selector = match (&req.audio_source_id, req.audio_format) {
                (Some(id), _) => format!("{id}/ba/b"),
                (None, AudioFormat::M4a) => "ba[ext=m4a]/ba/b".into(),
                (None, AudioFormat::Opus) => "ba[acodec=opus]/ba/b".into(),
                _ => "ba/b".into(),
            };
            args.extend(["-f".into(), selector, "-x".into(), "--audio-format".into(), req.audio_format.ext().into()]);
            args.push("--audio-quality".into());
            args.push(audio_quality_arg(&req.audio_quality));
        }
    }
    args
}

pub fn download_args(req: &DownloadRequest, ctx: &ArgsContext) -> Vec<String> {
    let s = ctx.settings;
    let mut args = format_args(req);
    let clip = active_cut(req);
    args.extend(cut_args(req));

    // Embeds.
    let wav = req.mode == Mode::Audio && req.audio_format == AudioFormat::Wav;
    if s.embed_thumbnail && !wav {
        args.push("--embed-thumbnail".into());
        args.push("--convert-thumbnails".into());
        args.push("jpg".into());
    }
    if s.embed_metadata {
        args.push("--embed-metadata".into());
        if clip.is_some() {
            // The video's chapter times would be wrong inside a clip.
            args.push("--no-embed-chapters".into());
        }
    }
    // Subtitles come whole, with the full video's timings: not for clips.
    if s.embed_subs && req.mode == Mode::Video && clip.is_none() && !s.sub_langs.trim().is_empty() {
        args.push("--embed-subs".into());
        args.push("--sub-langs".into());
        args.push(format!("{},-live_chat", s.sub_langs.trim()));
    }

    // Access.
    if let Some(b) = s.cookies_browser.as_deref().filter(|b| !b.trim().is_empty()) {
        args.push("--cookies-from-browser".into());
        args.push(b.trim().to_ascii_lowercase());
    }
    if let Some(r) = req.referer.as_deref() {
        args.push("--add-headers".into());
        args.push(format!("Referer:{r}"));
    }

    // Playlist handling.
    let template = filename_template(s.filename);
    let output = if req.playlist {
        args.push("--yes-playlist".into());
        if let Some(n) = req.playlist_limit.filter(|n| *n > 0) {
            args.push("--playlist-items".into());
            args.push(format!("1:{n}"));
        }
        format!("%(playlist_title,playlist,playlist_id|Playlist).80B/%(playlist_index)03d - {template}")
    } else {
        args.push("--no-playlist".into());
        match &clip {
            Some(c) => tagged_template(template, &cut::file_tag(c)),
            None => template.to_string(),
        }
    };

    // Where things go.
    args.push("-P".into());
    args.push(format!("home:{}", ctx.home_dir.to_string_lossy()));
    args.push("-P".into());
    args.push(format!("temp:{}", ctx.temp_dir.to_string_lossy()));
    args.push("-o".into());
    args.push(output);

    // Progress reporting we can parse.
    args.extend([
        "--newline".into(),
        "--progress".into(),
        "--progress-delta".into(),
        "0.25".into(),
        "--progress-template".into(),
        progress_template(),
        "--print-to-file".into(),
        "after_move:%(filepath)s".into(),
        escape_template_path(ctx.print_file),
    ]);

    // Quality of life.
    args.extend(["--no-mtime".into(), "--concurrent-fragments".into(), "4".into()]);

    args.push("--".into());
    args.push(req.url.clone());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ctx_parts() -> (Settings, PathBuf, PathBuf, PathBuf) {
        let s = Settings { output_dir: "/out".into(), ..Default::default() };
        (s, PathBuf::from("/out"), PathBuf::from("/tmp/job1"), PathBuf::from("/tmp/job1/files.txt"))
    }

    fn has_pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    fn video_req() -> DownloadRequest {
        DownloadRequest {
            url: "https://www.youtube.com/watch?v=BaW_jenozKc".into(),
            mode: Mode::Video,
            tier: Some(1080),
            container: Container::Mp4,
            video_id: Some("299".into()),
            audio_id: Some("140".into()),
            ..Default::default()
        }
    }

    #[test]
    fn video_exact_pick_with_fallbacks() {
        let args = format_args(&video_req());
        assert!(has_pair(&args, "-f", "299+140/299+ba/bv*+ba/b"));
        assert!(has_pair(&args, "-S", "res:1080,vcodec:h264,acodec:aac"));
        assert!(has_pair(&args, "--merge-output-format", "mp4"));
        assert!(!args.contains(&"--remux-video".to_string()), "merged picks need no remux");
    }

    #[test]
    fn mkv_has_no_codec_bias() {
        let req = DownloadRequest { container: Container::Mkv, video_id: Some("399".into()), audio_id: Some("251".into()), ..video_req() };
        let args = format_args(&req);
        assert!(has_pair(&args, "-S", "res:1080"));
        assert!(has_pair(&args, "--merge-output-format", "mkv"));
    }

    #[test]
    fn combined_pick_is_remuxed() {
        let req = DownloadRequest { video_id: Some("h264_720p".into()), audio_id: None, combined: true, tier: Some(720), ..video_req() };
        let args = format_args(&req);
        assert!(has_pair(&args, "-f", "h264_720p/b"));
        assert!(has_pair(&args, "--remux-video", "mp4"));
    }

    #[test]
    fn legacy_codecs_are_reencoded_for_mp4() {
        let req = DownloadRequest { video_id: Some("0".into()), combined: true, pick_ext: Some("ogv".into()), ..video_req() };
        assert!(has_pair(&format_args(&req), "--recode-video", "mp4"));
        let mkv = DownloadRequest { container: Container::Mkv, ..req };
        assert!(has_pair(&format_args(&mkv), "--remux-video", "mkv"));
    }

    #[test]
    fn hevc_in_mp4_is_tagged_for_quicktime() {
        let req = DownloadRequest { video_id: Some("bytevc1_1080p".into()), combined: true, pick_vcodec: Some("HEVC".into()), ..video_req() };
        let args = format_args(&req);
        assert!(has_pair(&args, "--postprocessor-args", "Merger+ffmpeg_o:-tag:v hvc1"));
        assert!(has_pair(&args, "--postprocessor-args", "VideoRemuxer+ffmpeg_o:-tag:v hvc1"));
        let h264 = format_args(&video_req());
        assert!(!h264.contains(&"--postprocessor-args".to_string()));
    }

    #[test]
    fn audio_modes() {
        let mut req = DownloadRequest { mode: Mode::Audio, audio_format: AudioFormat::Mp3, audio_quality: "320".into(), ..video_req() };
        let args = format_args(&req);
        assert!(has_pair(&args, "-f", "ba/b"));
        assert!(args.contains(&"-x".to_string()));
        assert!(has_pair(&args, "--audio-format", "mp3"));
        assert!(has_pair(&args, "--audio-quality", "320K"));

        req.audio_format = AudioFormat::M4a;
        req.audio_quality = "original".into();
        req.audio_source_id = Some("140".into());
        let args = format_args(&req);
        assert!(has_pair(&args, "-f", "140/ba/b"));
        assert!(has_pair(&args, "--audio-quality", "0"));
    }

    #[test]
    fn full_args_shape() {
        let (s, home, temp, print) = ctx_parts();
        let ctx = ArgsContext { settings: &s, home_dir: &home, temp_dir: &temp, print_file: &print };
        let args = download_args(&video_req(), &ctx);
        assert!(has_pair(&args, "-P", "home:/out"));
        assert!(has_pair(&args, "-P", "temp:/tmp/job1"));
        assert!(has_pair(&args, "-o", "%(title).150B.%(ext)s"));
        assert!(args.contains(&"--embed-thumbnail".to_string()));
        assert!(args.contains(&"--no-playlist".to_string()));
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), "https://www.youtube.com/watch?v=BaW_jenozKc");
        let t = progress_template();
        assert!(t.starts_with("download:BLDR {\"p\":%(progress)j"));
        assert!(t.contains("%(info.{format_id,vcodec,acodec,playlist_index,playlist_count,n_entries})j"));
    }

    #[test]
    fn playlist_and_cookies() {
        let (mut s, home, temp, print) = ctx_parts();
        s.cookies_browser = Some("Firefox".into());
        let ctx = ArgsContext { settings: &s, home_dir: &home, temp_dir: &temp, print_file: &print };
        let req = DownloadRequest { playlist: true, playlist_limit: Some(10), video_id: None, audio_id: None, ..video_req() };
        let args = download_args(&req, &ctx);
        assert!(args.contains(&"--yes-playlist".to_string()));
        assert!(has_pair(&args, "--playlist-items", "1:10"));
        assert!(has_pair(&args, "--cookies-from-browser", "firefox"));
        let out = args.windows(2).find(|w| w[0] == "-o").unwrap()[1].clone();
        assert!(out.contains("%(playlist_index)03d - "));
    }

    #[test]
    fn wav_skips_cover_and_percent_is_escaped() {
        let (s, home, temp, _) = ctx_parts();
        let print = PathBuf::from("/tmp/100%/files.txt");
        let ctx = ArgsContext { settings: &s, home_dir: &home, temp_dir: &temp, print_file: &print };
        let req = DownloadRequest { mode: Mode::Audio, audio_format: AudioFormat::Wav, ..video_req() };
        let args = download_args(&req, &ctx);
        assert!(!args.contains(&"--embed-thumbnail".to_string()));
        assert!(args.contains(&"/tmp/100%%/files.txt".to_string()));
    }

    fn cut_req(exact: bool) -> DownloadRequest {
        DownloadRequest { cut: Some(Cut { start: 12.0, end: 53.5, exact }), ..video_req() }
    }

    #[test]
    fn exact_cut_reencodes_only_the_clip() {
        let (mut s, home, temp, print) = ctx_parts();
        s.embed_subs = true;
        let ctx = ArgsContext { settings: &s, home_dir: &home, temp_dir: &temp, print_file: &print };
        let args = download_args(&cut_req(true), &ctx);
        assert!(has_pair(&args, "--download-sections", "*12.000-53.500"));
        assert!(args.contains(&"--force-keyframes-at-cuts".to_string()));
        assert!(has_pair(&args, "--downloader-args", &format!("ffmpeg_o:{EXACT_CUT_ARGS}")));
        assert!(has_pair(&args, "-o", "%(title).150B (12s-53.5s).%(ext)s"));
        assert!(args.contains(&"--no-embed-chapters".to_string()), "chapter times would be off");
        assert!(!args.contains(&"--embed-subs".to_string()), "subtitle times would be off");
        // The whole video still gets subtitles.
        let full = download_args(&video_req(), &ctx);
        assert!(full.contains(&"--embed-subs".to_string()));
        assert!(!full.contains(&"--no-embed-chapters".to_string()));
        assert!(!full.contains(&"--download-sections".to_string()));
    }

    #[test]
    fn fast_cut_keeps_the_streams() {
        assert_eq!(cut_args(&cut_req(false)), vec!["--download-sections", "*12.000-53.500"]);
        // HEVC in MP4 still gets its QuickTime tag (FFmpeg merges directly, no Merger step).
        let hevc = DownloadRequest { pick_vcodec: Some("HEVC".into()), combined: true, pick_ext: Some("mp4".into()), audio_id: None, ..cut_req(false) };
        assert!(has_pair(&cut_args(&hevc), "--downloader-args", "ffmpeg_o:-tag:v hvc1"));
        // Re-encoded to H.264: no HEVC tag.
        let exact = DownloadRequest { cut: Some(Cut { start: 1.0, end: 2.0, exact: true }), ..hevc };
        assert!(!cut_args(&exact).iter().any(|a| a.contains("hvc1")));
    }

    #[test]
    fn exact_cut_codecs_follow_the_output_container() {
        // A single WebM file can't hold H.264: FFmpeg uses WebM's own codecs.
        let webm = DownloadRequest { combined: true, pick_ext: Some("webm".into()), audio_id: None, ..cut_req(true) };
        let args = cut_args(&webm);
        assert!(args.contains(&"--force-keyframes-at-cuts".to_string()));
        assert!(!args.contains(&"--downloader-args".to_string()));
        let mp4 = DownloadRequest { combined: true, pick_ext: Some("mp4".into()), audio_id: None, ..cut_req(true) };
        assert!(cut_args(&mp4).contains(&"--downloader-args".to_string()));
    }

    #[test]
    fn audio_cuts_are_plain_sections() {
        let req = DownloadRequest { mode: Mode::Audio, ..cut_req(true) };
        assert_eq!(cut_args(&req), vec!["--download-sections", "*12.000-53.500"]);
    }

    #[test]
    fn playlists_ignore_cuts() {
        let (s, home, temp, print) = ctx_parts();
        let ctx = ArgsContext { settings: &s, home_dir: &home, temp_dir: &temp, print_file: &print };
        let req = DownloadRequest { playlist: true, video_id: None, ..cut_req(true) };
        let args = download_args(&req, &ctx);
        assert!(!args.contains(&"--download-sections".to_string()));
        assert!(!args.iter().any(|a| a.contains("12s-53.5s")));
    }

    #[test]
    fn template_tags() {
        assert_eq!(tagged_template("%(title).150B.%(ext)s", " (1s-2s)"), "%(title).150B (1s-2s).%(ext)s");
        assert_eq!(tagged_template("raw", " 100%"), "raw 100%%");
    }

    #[test]
    fn quality_parsing() {
        assert_eq!(audio_quality_arg("best"), "0");
        assert_eq!(audio_quality_arg("original"), "0");
        assert_eq!(audio_quality_arg("192"), "192K");
        assert_eq!(audio_quality_arg("128k"), "128K");
    }
}
