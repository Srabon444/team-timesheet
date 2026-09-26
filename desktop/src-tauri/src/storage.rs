//! Local persistence for data.json, the activity log and recovery points.
//!
//! data.json is written atomically (temp file + fsync + rename) with the previous good copy kept
//! as data.json.bak, so a crash, a killed Android process or a full disk mid-write can never leave
//! a half-written file behind. A file that can't be parsed is never overwritten: it is copied
//! aside as data.json.corrupt-<ms> and the backup is loaded instead.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static SAVE_LOCK: Mutex<()> = Mutex::new(());
static ACTIVITY_LOCK: Mutex<()> = Mutex::new(());
static RECOVERY_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const LOG_ROTATE_BYTES: u64 = 1_000_000;
const RECOVERY_KEEP: usize = 20;

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn dir_of(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_valid(path: &Path) -> Option<String> {
    let s = fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&s).ok()?;
    Some(s)
}

fn log_event(dir: &Path, kind: &str, detail: &str) {
    let line = serde_json::json!({
        "t": chrono_like_iso(),
        "dev": "storage",
        "type": kind,
        "detail": detail,
    })
    .to_string();
    let _ = append_log_in(dir, &[line]);
}

// Local-time-free ISO-8601 in UTC, enough for ordering log lines.
fn chrono_like_iso() -> String {
    let ms = now_ms();
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days (Howard Hinnant), valid for the whole proleptic Gregorian range we need
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{:03}Z", ms % 1000)
}

/// Ok("{}") when nothing was ever saved. Err("unreadable: …") when the file exists but can't be
/// read (e.g. locked by antivirus) — the caller must not save over it. Err("corrupt: …") when it
/// can't be parsed and no good backup exists — it was copied aside first, so saving is safe.
pub fn load_in(dir: &Path) -> Result<String, String> {
    let path = dir.join("data.json");
    let bak = dir.join("data.json.bak");
    if !path.exists() {
        if let Some(s) = read_valid(&bak) {
            log_event(dir, "load-recovered", "data.json was missing; loaded data.json.bak");
            return Ok(s);
        }
        return Ok("{}".to_string());
    }
    let mut text = None;
    let mut io_err = String::new();
    for attempt in 0..3 {
        match fs::read_to_string(&path) {
            Ok(s) => {
                text = Some(s);
                break;
            }
            Err(e) => {
                io_err = e.to_string();
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            }
        }
    }
    let Some(text) = text else {
        log_event(dir, "load-error", &format!("data.json unreadable: {io_err}"));
        return Err(format!("unreadable: {} ({io_err})", path.display()));
    };
    let parse_err = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(_) => return Ok(text),
        Err(e) => e.to_string(),
    };
    let keep = dir.join(format!("data.json.corrupt-{}", now_ms()));
    let _ = fs::copy(&path, &keep);
    if let Some(s) = read_valid(&bak) {
        log_event(
            dir,
            "load-recovered",
            &format!("data.json was corrupt ({parse_err}); loaded data.json.bak; kept a copy as {}", keep.display()),
        );
        return Ok(s);
    }
    log_event(dir, "load-error", &format!("data.json corrupt ({parse_err}), no usable backup; kept a copy as {}", keep.display()));
    Err(format!("corrupt: data.json could not be read ({parse_err}); a copy was kept as {}", keep.display()))
}

pub fn save_in(dir: &Path, json: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("refusing to save invalid JSON: {e}"))?;
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join("data.json");
    let tmp = dir.join("data.json.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    // Only a parseable file becomes the backup, so one bad write can't also ruin the fallback.
    if read_valid(&path).is_some() {
        let _ = fs::copy(&path, dir.join("data.json.bak"));
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn append_log_in(dir: &Path, lines: &[String]) -> Result<(), String> {
    let _guard = ACTIVITY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join("activity.log");
    if fs::metadata(&path).map(|m| m.len() > LOG_ROTATE_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("activity.log.1"));
    }
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    for l in lines {
        writeln!(f, "{}", l.replace('\n', " ")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn read_log_in(dir: &Path, max: usize) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    for name in ["activity.log.1", "activity.log"] {
        if let Ok(s) = fs::read_to_string(dir.join(name)) {
            all.extend(s.lines().filter(|l| !l.trim().is_empty()).map(String::from));
        }
    }
    let start = all.len().saturating_sub(max);
    all.split_off(start)
}

pub fn save_recovery_in(dir: &Path, json: &str) -> Result<(), String> {
    let rdir = dir.join("recovery");
    fs::create_dir_all(&rdir).map_err(|e| e.to_string())?;
    // Zero-padded so a plain name sort is chronological, and the sequence keeps same-ms points apart.
    let seq = RECOVERY_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = format!("{:016}-{:06}.json", now_ms(), seq);
    fs::write(rdir.join(name), json).map_err(|e| e.to_string())?;
    let mut files = recovery_files(&rdir);
    while files.len() > RECOVERY_KEEP {
        let _ = fs::remove_file(files.remove(0));
    }
    Ok(())
}

fn recovery_files(rdir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(rdir)
        .map(|it| it.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect())
        .unwrap_or_default();
    files.sort();
    files
}

/// Newest first.
pub fn list_recovery_in(dir: &Path) -> Vec<String> {
    let mut files = recovery_files(&dir.join("recovery"));
    files.reverse();
    files.iter().filter_map(|p| fs::read_to_string(p).ok()).collect()
}

#[tauri::command]
pub fn load_data(app: AppHandle) -> Result<String, String> {
    load_in(&dir_of(&app)?)
}

#[tauri::command]
pub fn save_data(app: AppHandle, json: String) -> Result<(), String> {
    save_in(&dir_of(&app)?, &json)
}

#[tauri::command]
pub fn append_log(app: AppHandle, lines: Vec<String>) -> Result<(), String> {
    append_log_in(&dir_of(&app)?, &lines)
}

#[tauri::command]
pub fn read_log(app: AppHandle, max: usize) -> Result<Vec<String>, String> {
    Ok(read_log_in(&dir_of(&app)?, max))
}

#[tauri::command]
pub fn save_recovery(app: AppHandle, json: String) -> Result<(), String> {
    save_recovery_in(&dir_of(&app)?, &json)
}

#[tauri::command]
pub fn list_recovery(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(list_recovery_in(&dir_of(&app)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("tt-storage-test-{}-{}-{n}", std::process::id(), now_ms()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn fresh_dir_loads_empty_object() {
        assert_eq!(load_in(&tmp()).unwrap(), "{}");
    }

    #[test]
    fn save_then_load_round_trips_and_keeps_a_backup() {
        let d = tmp();
        save_in(&d, r#"{"v":1}"#).unwrap();
        save_in(&d, r#"{"v":2}"#).unwrap();
        assert_eq!(load_in(&d).unwrap(), r#"{"v":2}"#);
        assert_eq!(fs::read_to_string(d.join("data.json.bak")).unwrap(), r#"{"v":1}"#);
        assert!(!d.join("data.json.tmp").exists());
    }

    #[test]
    fn corrupt_file_falls_back_to_backup_and_is_kept_aside() {
        let d = tmp();
        save_in(&d, r#"{"v":1}"#).unwrap();
        save_in(&d, r#"{"v":2}"#).unwrap();
        fs::write(d.join("data.json"), "{\"v\":2, trunc").unwrap(); // a torn write
        assert_eq!(load_in(&d).unwrap(), r#"{"v":1}"#);
        let kept = fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with("data.json.corrupt-"));
        assert!(kept, "the corrupt file must be copied aside, never lost");
        assert!(read_log_in(&d, 10).iter().any(|l| l.contains("load-recovered")));
    }

    #[test]
    fn corrupt_without_backup_is_an_error_not_an_empty_load() {
        let d = tmp();
        fs::write(d.join("data.json"), "garbage").unwrap();
        let err = load_in(&d).unwrap_err();
        assert!(err.starts_with("corrupt:"));
        assert_eq!(fs::read_to_string(d.join("data.json")).unwrap(), "garbage", "load never rewrites the file");
    }

    #[test]
    fn invalid_json_is_never_saved_and_a_bad_file_never_becomes_the_backup() {
        let d = tmp();
        save_in(&d, r#"{"good":1}"#).unwrap();
        save_in(&d, r#"{"good":2}"#).unwrap();
        assert!(save_in(&d, "{oops").is_err());
        assert_eq!(fs::read_to_string(d.join("data.json")).unwrap(), r#"{"good":2}"#);
        fs::write(d.join("data.json"), "{torn").unwrap();
        save_in(&d, r#"{"next":1}"#).unwrap();
        assert_eq!(fs::read_to_string(d.join("data.json.bak")).unwrap(), r#"{"good":1}"#);
    }

    #[test]
    fn log_appends_and_reads_tail() {
        let d = tmp();
        append_log_in(&d, &["a".into(), "b".into()]).unwrap();
        append_log_in(&d, &["c".into()]).unwrap();
        assert_eq!(read_log_in(&d, 2), vec!["b".to_string(), "c".to_string()]);
    }

    #[test]
    fn recovery_points_are_pruned_and_listed_newest_first() {
        let d = tmp();
        for i in 0..(RECOVERY_KEEP + 3) {
            save_recovery_in(&d, &format!("{{\"i\":{i}}}")).unwrap();
        }
        let list = list_recovery_in(&d);
        assert_eq!(list.len(), RECOVERY_KEEP);
        assert_eq!(list[0], format!("{{\"i\":{}}}", RECOVERY_KEEP + 2));
    }

    #[test]
    fn iso_timestamp_shape() {
        let s = chrono_like_iso();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z') && &s[4..5] == "-" && &s[10..11] == "T");
    }
}
