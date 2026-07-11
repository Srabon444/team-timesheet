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
            .inner_size(1150.0, 850.0)
            .build()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The injected script cannot use Tauri IPC (remote origin), so it reports
/// progress by writing `TT_STATE:{json}` into document.title. Poll that and
/// relay to the main window as "fill-status" events. Engine-agnostic and
/// zero extra security surface.
fn start_title_poll(app: AppHandle) {
    std::thread::spawn(move || {
        // ~10 min hard cap so an injection that dies silently can't leave
        // this thread spinning forever.
        for _ in 0..1500 {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let Some(win) = app.get_webview_window("fillout") else {
                break; // window closed
            };
            let Ok(title) = win.title() else { break };
            if let Some(rest) = title.strip_prefix("TT_STATE:") {
                let _ = app.emit_to("main", "fill-status", rest.to_string());
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                    let done = v.get("done").and_then(|d| d.as_bool()) == Some(true);
                    if done || v.get("error").is_some() {
                        break;
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
