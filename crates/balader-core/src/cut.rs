//! The cut: grabbing only part of a video or track, from a start time to an
//! end time. Parsing what people type, the labels we show, and the checks a
//! request goes through before yt-dlp sees it.

use crate::error::{CoreError, ErrorCode, Result};
use crate::model::Cut;

/// Shortest clip worth cutting, in seconds.
pub const MIN_LEN: f64 = 0.1;

/// What people type → seconds. Accepts `83`, `83.5`, `1:23`, `1:23.5`,
/// `01:02:03.25`, `1h2m3s`, `2m`, `1m30` and a comma as decimal mark.
pub fn parse_timestamp(input: &str) -> Option<f64> {
    let s = input.trim().replace(',', ".").to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    let v = if s.contains(['h', 'm', 's']) { parse_units(&s)? } else { parse_clock(&s)? };
    (v.is_finite() && v >= 0.0).then_some(v)
}

fn parse_number(n: &str) -> Option<f64> {
    if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit() || c == '.') || n.matches('.').count() > 1 || n == "." {
        return None;
    }
    n.parse().ok()
}

/// `1:23.5`, `1:02:03`: minutes and seconds after the first field stay below 60.
fn parse_clock(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').map(str::trim).collect();
    if parts.len() > 3 {
        return None;
    }
    let mut total = 0.0;
    for (i, p) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        if !last && !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let v = parse_number(p)?;
        if i > 0 && v >= 60.0 {
            return None;
        }
        total = total * 60.0 + v;
    }
    Some(total)
}

/// `1h2m3.5s`; a trailing bare number takes the next smaller unit (`1m30` = 90 s).
fn parse_units(s: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut num = String::new();
    let mut last_unit: Option<char> = None;
    for c in s.chars() {
        match c {
            '0'..='9' | '.' => num.push(c),
            'h' | 'm' | 's' => {
                // Units must come in order, once each: h, then m, then s.
                let rank = |u: char| match u {
                    'h' => 0,
                    'm' => 1,
                    _ => 2,
                };
                if last_unit.is_some_and(|l| rank(l) >= rank(c)) {
                    return None;
                }
                let v = parse_number(&num)?;
                total += v * match c {
                    'h' => 3600.0,
                    'm' => 60.0,
                    _ => 1.0,
                };
                num.clear();
                last_unit = Some(c);
            }
            ' ' => {}
            _ => return None,
        }
    }
    if !num.is_empty() {
        let scale = match last_unit {
            Some('h') => 60.0,
            Some('m') => 1.0,
            _ => return None,
        };
        total += parse_number(&num)? * scale;
    }
    Some(total)
}

fn split_ms(t: f64) -> (u64, u64, u64, u64) {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    (ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

fn frac(ms: u64) -> String {
    if ms == 0 { String::new() } else { format!(".{}", format!("{ms:03}").trim_end_matches('0')) }
}

/// Clock label: `0:05`, `1:23.5`, `1:02:03.25`.
pub fn clock(t: f64) -> String {
    let (h, m, s, ms) = split_ms(t);
    if h > 0 { format!("{h}:{m:02}:{s:02}{}", frac(ms)) } else { format!("{m}:{s:02}{}", frac(ms)) }
}

/// File-name friendly label (no colons): `5s`, `1m05s`, `1h02m03.5s`.
pub fn compact(t: f64) -> String {
    let (h, m, s, ms) = split_ms(t);
    let f = frac(ms);
    if h > 0 {
        format!("{h}h{m:02}m{s:02}{f}s")
    } else if m > 0 {
        format!("{m}m{s:02}{f}s")
    } else {
        format!("{s}{f}s")
    }
}

/// Appended to the file name so a clip never looks like the full video: ` (1m05s-2m30s)`.
pub fn file_tag(c: &Cut) -> String {
    format!(" ({}-{})", compact(c.start), compact(c.end))
}

/// Shown in the pile and the CLI: `0:12 → 0:53`.
pub fn label(c: &Cut) -> String {
    format!("{} → {}", clock(c.start), clock(c.end))
}

fn round_ms(t: f64) -> f64 {
    (t * 1000.0).round() / 1000.0
}

fn bad(msg: impl Into<String>) -> CoreError {
    CoreError::coded(ErrorCode::BadRequest, msg)
}

/// Check a requested cut against the media length. `Ok(None)` means "the
/// whole thing" (no cut needed). The end is clamped to the duration.
pub fn normalize(cut: Option<Cut>, duration: Option<f64>) -> Result<Option<Cut>> {
    let Some(mut c) = cut else { return Ok(None) };
    if !c.start.is_finite() || !c.end.is_finite() || c.start < 0.0 || c.end < 0.0 {
        return Err(bad("The cut times don't make sense."));
    }
    c.start = round_ms(c.start);
    c.end = round_ms(c.end);
    if let Some(d) = duration.filter(|d| d.is_finite() && *d > 0.0) {
        if c.start >= d {
            return Err(bad(format!("The cut starts after the end ({}).", clock(d))));
        }
        c.end = c.end.min(round_ms(d));
        if c.start <= 0.0 && c.end >= round_ms(d) {
            return Ok(None);
        }
    }
    if c.end <= c.start {
        return Err(bad("The cut ends before it starts.").with_hint("Put the end after the start."));
    }
    if c.end - c.start < MIN_LEN - 1e-9 {
        return Err(bad("That cut is too short.").with_hint("Leave at least a tenth of a second between start and end."));
    }
    Ok(Some(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cut(start: f64, end: f64) -> Cut {
        Cut { start, end, exact: true }
    }

    #[test]
    fn parses_what_people_type() {
        assert_eq!(parse_timestamp("83"), Some(83.0));
        assert_eq!(parse_timestamp(" 83.5 "), Some(83.5));
        assert_eq!(parse_timestamp("1:23"), Some(83.0));
        assert_eq!(parse_timestamp("1:23.5"), Some(83.5));
        assert_eq!(parse_timestamp("1:23,25"), Some(83.25));
        assert_eq!(parse_timestamp("01:02:03.25"), Some(3723.25));
        assert_eq!(parse_timestamp("75:00"), Some(4500.0), "the first field may exceed 59");
        assert_eq!(parse_timestamp("1h2m3s"), Some(3723.0));
        assert_eq!(parse_timestamp("2m"), Some(120.0));
        assert_eq!(parse_timestamp("1m30"), Some(90.0));
        assert_eq!(parse_timestamp("1h30"), Some(5400.0));
        assert_eq!(parse_timestamp("4.5s"), Some(4.5));
        assert_eq!(parse_timestamp("0"), Some(0.0));
    }

    #[test]
    fn rejects_nonsense() {
        for bad in ["", " ", "abc", "1:75", "1:2:3:4", "-5", "1..5", "1:-3", "1s2m", "1m1m", "1.2:30", "5x", ".", ":30"] {
            assert_eq!(parse_timestamp(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn labels() {
        assert_eq!(clock(0.0), "0:00");
        assert_eq!(clock(5.0), "0:05");
        assert_eq!(clock(83.5), "1:23.5");
        assert_eq!(clock(3723.25), "1:02:03.25");
        assert_eq!(clock(59.9996), "1:00");
        assert_eq!(compact(5.0), "5s");
        assert_eq!(compact(5.5), "5.5s");
        assert_eq!(compact(65.0), "1m05s");
        assert_eq!(compact(3723.5), "1h02m03.5s");
        assert_eq!(file_tag(&cut(2.0, 5.5)), " (2s-5.5s)");
        assert_eq!(label(&cut(12.0, 53.0)), "0:12 → 0:53");
    }

    #[test]
    fn normalizing() {
        assert_eq!(normalize(None, Some(60.0)).unwrap(), None);
        assert_eq!(normalize(Some(cut(0.0, 60.0)), Some(60.0)).unwrap(), None, "whole thing = no cut");
        assert_eq!(normalize(Some(cut(0.0, 75.0)), Some(60.0)).unwrap(), None, "end past the duration is clamped");
        assert_eq!(normalize(Some(cut(10.0, 75.0)), Some(60.0)).unwrap(), Some(cut(10.0, 60.0)));
        assert_eq!(normalize(Some(cut(1.23456, 2.0)), None).unwrap(), Some(cut(1.235, 2.0)), "rounded to the millisecond");
        assert_eq!(normalize(Some(cut(30.0, 40.0)), None).unwrap(), Some(cut(30.0, 40.0)), "unknown duration: trust the times");
        assert!(normalize(Some(cut(61.0, 70.0)), Some(60.0)).is_err(), "starts after the end");
        assert!(normalize(Some(cut(5.0, 4.0)), None).is_err());
        assert!(normalize(Some(cut(5.0, 5.05)), None).is_err(), "too short");
        assert!(normalize(Some(cut(5.0, 5.1)), None).is_ok(), "a tenth of a second is fine");
        assert!(normalize(Some(cut(-1.0, 4.0)), None).is_err());
        assert!(normalize(Some(cut(f64::NAN, 4.0)), None).is_err());
    }
}
