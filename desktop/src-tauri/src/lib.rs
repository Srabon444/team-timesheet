mod gdrive;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const FILLOUT_ORIGIN: &str = "https://techzu.fillout.com/";

/// One pending auto-fill job for the "fillout" window. Injected on the first
/// page-load `Finished` event. (An earlier version reloaded once and waited
/// for a SECOND Finished before injecting; that second event doesn't fire
/// reliably across webview engines — on some, injection never happened and
/// the window just sat there. The script itself polls for form readiness, so
/// injecting on the first load is both simpler and reliable.)
struct FilloutJob {
    script: String,
    injected: bool,
    gen: u64,
}

struct FilloutState(Mutex<Option<FilloutJob>>);

/// Bumped on every open_fillout() call. start_title_poll() checks this each
/// loop iteration and exits as soon as it's superseded — otherwise repeated
/// Final Submits within the same ~30min window each leave their OWN
/// title-poll thread running concurrently (nothing ever cancelled the
/// previous one), all hammering run_on_main_thread every 400ms. Observed as
/// the app going unresponsive after a long session of normal use (several
/// submits), only clearing on a full restart — restart is what silently
/// killed all the orphaned threads.
struct PollGeneration(AtomicU64);

static LOG_LOCK: Mutex<()> = Mutex::new(());

/// Breadcrumb logger for the Windows 11 Fillout-window hang. It's a real
/// deadlock, not a crash (the panic hook stays silent for it) — a hang never
/// panics, so the only way to find where execution actually stops is to
/// write a line at every stage BEFORE anything that could block. Whichever
/// line is LAST in the file when it's killed via Task Manager is where it
/// got stuck. Fixed, no-AppHandle-needed path so it works from any thread at
/// any point, including before the app is fully up.
fn dbg_log(msg: &str) {
    use std::io::Write;
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("team-timesheet-debug.log"))
    {
        let _ = writeln!(f, "[{}.{:03}] {}", now.as_secs(), now.subsec_millis(), msg);
    }
}

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

/// POST JSON to Fillout's submission API. Used by the mobile headless
/// submit (Android has no in-app auto-fill window): the frontend builds the
/// exact /init and /continue payloads and this relays them. It must run in
/// Rust, not JS — Fillout's API only sends CORS headers for its own
/// techzu.fillout.com origin, so a webview fetch from the app's own origin is
/// blocked; reqwest has no such restriction.
#[tauri::command]
async fn fillout_post(url: String, body: String) -> Result<String, String> {
    if !url.starts_with("https://api.fillout.com/") {
        return Err("refusing to POST to a non-Fillout URL".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .header("origin", "https://techzu.fillout.com")
        .header("referer", "https://techzu.fillout.com/")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Fillout API {}: {}", status.as_u16(), text));
    }
    Ok(text)
}

/// Open (or refocus) the Fillout window and queue the fill script. The
/// actual injection happens in on_page_load below, on the first page load.
#[tauri::command]
fn open_fillout(app: AppHandle, url: String, script: String) -> Result<(), String> {
    dbg_log(&format!("open_fillout: called, url={url}"));
    if !url.starts_with(FILLOUT_ORIGIN) {
        return Err("refusing to open a non-Fillout URL".to_string());
    }
    let parsed: tauri::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let gen = app.state::<PollGeneration>().0.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let state = app.state::<FilloutState>();
        *state.0.lock().unwrap() = Some(FilloutJob { script, injected: false, gen });
    }
    if let Some(win) = app.get_webview_window("fillout") {
        dbg_log("open_fillout: reusing existing window");
        let _ = win.show();
        let _ = win.set_focus();
        // Re-navigating fires on_page_load again → the fresh job is injected.
        win.navigate(parsed).map_err(|e| e.to_string())?;
        dbg_log("open_fillout: navigate() returned");
    } else {
        dbg_log("open_fillout: building a new window");
        WebviewWindowBuilder::new(&app, "fillout", WebviewUrl::External(parsed))
            .title("Fillout — review, then click the form's own Submit")
            .inner_size(1320.0, 880.0)
            .min_inner_size(1000.0, 700.0)
            .resizable(true)
            .build()
            .map_err(|e| e.to_string())?;
        dbg_log("open_fillout: window built");
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
        dbg_log("poll: main thread closure running, getting window");
        let msg = match app2.get_webview_window("fillout") {
            Some(w) => {
                dbg_log("poll: main thread calling w.title()");
                let r = match w.title() {
                    Ok(t) => Poll::Title(t),
                    Err(_) => Poll::Gone,
                };
                dbg_log("poll: main thread w.title() returned");
                r
            }
            None => Poll::Gone,
        };
        let _ = tx.send(msg);
    });
    if dispatched.is_err() {
        dbg_log("poll: run_on_main_thread dispatch FAILED — event loop may be gone");
        return Poll::Gone;
    }
    match rx.recv_timeout(std::time::Duration::from_millis(1500)) {
        Ok(p) => p,
        Err(_) => {
            // Dispatch succeeded but the main thread never ran the closure (or
            // never got past w.title()) within 1.5s — main thread is blocked
            // on something else. This line with no matching "closure running"
            // line right before it is the smoking gun for a main-thread hang.
            dbg_log("poll: main thread did NOT respond within 1.5s — likely blocked elsewhere");
            Poll::Gone
        }
    }
}

fn start_title_poll(app: AppHandle, my_gen: u64) {
    dbg_log(&format!("title poll gen={my_gen}: thread starting"));
    std::thread::spawn(move || {
        // Last "added" count seen, so a window closed mid-fill can still
        // report an accurate count when it disappears.
        let mut last_added = 0i64;
        let mut last_emitted = String::new();
        // ~30 min cap: long enough for the user to review the filled form and
        // actually click its Submit, so a real submission can be auto-detected
        // (Task 7), without leaving the thread spinning forever.
        for i in 0..4500 {
            std::thread::sleep(std::time::Duration::from_millis(400));
            // A newer Final Submit started its own poll — this one is stale,
            // exit quietly instead of running alongside it (see PollGeneration).
            if app.state::<PollGeneration>().0.load(Ordering::SeqCst) != my_gen {
                dbg_log(&format!("title poll gen={my_gen}: superseded, exiting"));
                break;
            }
            if i % 25 == 0 {
                dbg_log(&format!("title poll gen={my_gen}: heartbeat, iteration {i}"));
            }
            match poll_fillout_title(&app) {
                Poll::Gone => {
                    dbg_log(&format!("title poll gen={my_gen}: window reported gone"));
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
                    dbg_log(&format!("title poll gen={my_gen}: state changed: {rest}"));
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
        dbg_log(&format!("title poll gen={my_gen}: thread ending"));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // No live crash reports exist yet for the Windows 11 blank/unresponsive
    // main-window reports — this at least captures a panic (if that's what's
    // happening) to a fixed, no-AppHandle-needed path so the NEXT occurrence
    // leaves real evidence instead of nothing.
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("{}\n{}\n", info, std::backtrace::Backtrace::force_capture());
        let _ = std::fs::write(std::env::temp_dir().join("team-timesheet-crash.log"), msg);
    }));
    // REVERTED: --disable-gpu via WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS was
    // tried here as an unconfirmed mitigation for a Win11 blank-screen
    // report. It correlated with a NEW, worse regression: the "fillout"
    // window (which navigates to the real, much heavier Fillout React SPA,
    // unlike the local Svelte main window) going blank and hanging hard
    // enough that even its own close button stopped responding — consistent
    // with forced software rendering re-exposing the same class of WebView2
    // UI-thread deadlock the deferred-eval/main-thread-title workarounds
    // below were already written to dodge. The panic hook logged nothing
    // (no Rust panic), so this was a native UI-thread hang, not a crash.
    // Do not re-add a process-wide additionalBrowserArgs flag without a real
    // repro to test it against.

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(FilloutState(Mutex::new(None)))
        .manage(PollGeneration(AtomicU64::new(0)))
        .on_page_load(|webview, payload| {
            dbg_log(&format!(
                "on_page_load: label={} event={:?}",
                webview.label(),
                payload.event()
            ));
            if webview.label() != "fillout" {
                return;
            }
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let app = webview.app_handle().clone();
            let state = app.state::<FilloutState>();
            let mut guard = state.0.lock().unwrap();
            // Inject once, on the first load. `injected` guards against SPA
            // route changes that fire extra page-load events.
            let should_inject = matches!(guard.as_ref(), Some(job) if !job.injected);
            dbg_log(&format!("on_page_load: fillout Finished, should_inject={should_inject}"));
            if should_inject {
                if let Some(job) = guard.as_mut() {
                    job.injected = true;
                }
                let script = guard.as_ref().unwrap().script.clone();
                let gen = guard.as_ref().unwrap().gen;
                drop(guard);
                // Do NOT eval() synchronously inside the page-load callback.
                // On Windows 11's WebView2, calling ExecuteScript re-entrantly
                // from within a navigation/load event deadlocks the UI thread
                // (the whole app + the Fillout window freeze, needing a kill).
                // Win10's older runtime tolerated it. Deferring the injection
                // off this callback stack — a short sleep, then eval (Tauri
                // marshals it to the main thread itself) — breaks the
                // re-entrancy while keeping the same inject-on-first-load flow.
                let wv = webview.clone();
                std::thread::spawn(move || {
                    dbg_log("injection thread: sleeping 80ms");
                    std::thread::sleep(std::time::Duration::from_millis(80));
                    dbg_log("injection thread: calling wv.eval(script)");
                    let eval_result = wv.eval(&script);
                    dbg_log(&format!(
                        "injection thread: eval() returned, ok={}",
                        eval_result.is_ok()
                    ));
                    start_title_poll(app, gen);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            fetch_form_html,
            fillout_post,
            open_fillout,
            gdrive::gdrive_connected,
            gdrive::gdrive_connect,
            gdrive::gdrive_disconnect,
            gdrive::gdrive_api
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
