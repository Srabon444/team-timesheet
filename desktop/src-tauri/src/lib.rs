use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const FILLOUT_ORIGIN: &str = "https://techzu.fillout.com/";

/// One pending auto-fill job for the "fillout" window. `reloaded` tracks the
/// mandated reload-first flow: the page must fully load once, visibly reload,
/// and only then receive the injected fill script (mirrors the Chrome
/// extension's ensureFormTab, where skipping this caused half-hydrated pages
/// to silently drop the Name selection).
struct FilloutJob {
    script: String,
    reloaded: bool,
}

struct FilloutState(Mutex<Option<FilloutJob>>);

#[tauri::command]
fn load_data(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("data.json");
    if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

#[tauri::command]
fn save_data(app: AppHandle, json: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("data.json"), json).map_err(|e| e.to_string())
}

/// Fetch the Fillout form's HTML so the frontend can parse the Name
/// dropdown's static options out of __NEXT_DATA__ (same trick as the
/// extension — no DOM scraping, no browser needed).
#[tauri::command]
async fn fetch_form_html(url: String) -> Result<String, String> {
    if !url.starts_with(FILLOUT_ORIGIN) {
        return Err("refusing to fetch a non-Fillout URL".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;
    client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())
}

/// Open (or refocus) the Fillout window and queue the fill script. The
/// actual injection happens in on_page_load below, after the reload-first
/// sequence completes.
#[tauri::command]
fn open_fillout(app: AppHandle, url: String, script: String) -> Result<(), String> {
    if !url.starts_with(FILLOUT_ORIGIN) {
        return Err("refusing to open a non-Fillout URL".to_string());
    }
    let parsed: tauri::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    {
        let state = app.state::<FilloutState>();
        *state.0.lock().unwrap() = Some(FilloutJob { script, reloaded: false });
    }
    if let Some(win) = app.get_webview_window("fillout") {
        let _ = win.show();
        let _ = win.set_focus();
        // Re-navigating fires on_page_load again, which runs the same
        // load -> visible reload -> inject sequence as a fresh window.
        win.navigate(parsed).map_err(|e| e.to_string())?;
    } else {
        WebviewWindowBuilder::new(&app, "fillout", WebviewUrl::External(parsed))
            .title("Fillout — review, then click the form's own Submit")
            .inner_size(1320.0, 880.0)
            .min_inner_size(1000.0, 700.0)
            .resizable(true)
            .build()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The injected script cannot use Tauri IPC (remote origin), so it reports
/// progress by writing `TT_STATE:{json}` into document.title. Poll that and
/// relay to the main window as "fill-status" events. Engine-agnostic and
/// zero extra security surface.
enum Poll {
    Gone,
    Title(String),
}

/// Read the fillout window's title on the MAIN thread. On Windows, WebView2
/// has UI-thread affinity — calling `.title()` from a background thread can
/// hang the whole app (observed as a freeze on Win11 right after Final
/// Submit, while Win10 tolerated it). Marshaling every read through the main
/// thread avoids that; it's harmless on Linux/macOS.
fn poll_fillout_title(app: &AppHandle) -> Poll {
    let (tx, rx) = std::sync::mpsc::channel();
    let app2 = app.clone();
    let dispatched = app.run_on_main_thread(move || {
        let msg = match app2.get_webview_window("fillout") {
            Some(w) => match w.title() {
                Ok(t) => Poll::Title(t),
                Err(_) => Poll::Gone,
            },
            None => Poll::Gone,
        };
        let _ = tx.send(msg);
    });
    if dispatched.is_err() {
        return Poll::Gone;
    }
    rx.recv_timeout(std::time::Duration::from_millis(1500))
        .unwrap_or(Poll::Gone)
}

fn start_title_poll(app: AppHandle) {
    std::thread::spawn(move || {
        // Last "added" count seen, so a window closed mid-fill can still
        // report an accurate count when it disappears.
        let mut last_added = 0i64;
        let mut last_emitted = String::new();
        // ~30 min cap: long enough for the user to review the filled form and
        // actually click its Submit, so a real submission can be auto-detected
        // (Task 7), without leaving the thread spinning forever.
        for _ in 0..4500 {
            std::thread::sleep(std::time::Duration::from_millis(400));
            match poll_fillout_title(&app) {
                Poll::Gone => {
                    // Window closed (mid-fill or intentionally). Tell the main
                    // window so it drops out of "Filling…" and lets Final
                    // Submit run again, instead of hanging forever.
                    let payload = serde_json::json!({
                        "error": "Fillout window was closed",
                        "added": last_added
                    })
                    .to_string();
                    let _ = app.emit_to("main", "fill-status", payload);
                    break;
                }
                Poll::Title(title) => {
                    let Some(rest) = title.strip_prefix("TT_STATE:") else {
                        continue;
                    };
                    if rest == last_emitted {
                        continue; // keep-alive re-write of an unchanged state
                    }
                    last_emitted = rest.to_string();
                    let _ = app.emit_to("main", "fill-status", rest.to_string());
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                        if let Some(a) = v.get("added").and_then(|a| a.as_i64()) {
                            last_added = a;
                        }
                        // Stop only on a hard error or a CONFIRMED real
                        // submission. A plain "done" (auto-fill finished) is
                        // not a stop — keep watching so the later real Submit
                        // is caught.
                        let confirmed =
                            v.get("submittedConfirmed").and_then(|d| d.as_bool()) == Some(true);
                        if confirmed || v.get("error").is_some() {
                            break;
                        }
                    }
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(FilloutState(Mutex::new(None)))
        .on_page_load(|webview, payload| {
            if webview.label() != "fillout" {
                return;
            }
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let app = webview.app_handle().clone();
            let state = app.state::<FilloutState>();
            let mut guard = state.0.lock().unwrap();
            let inject_now = match guard.as_mut() {
                Some(job) if !job.reloaded => {
                    job.reloaded = true;
                    // First full load done -> the mandated visible reload.
                    let _ = webview.eval("location.reload()");
                    false
                }
                Some(_) => true,
                None => false,
            };
            if inject_now {
                if let Some(job) = guard.take() {
                    drop(guard);
                    let _ = webview.eval(&job.script);
                    start_title_poll(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            fetch_form_html,
            open_fillout
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
