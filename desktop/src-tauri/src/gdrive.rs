// Google Drive OAuth (loopback + PKCE) and an authenticated Drive REST proxy
// for the desktop/mobile apps. The frontend (gdrive.js) builds the same
// backup envelope and sync logic as the extension; it just can't run the
// OAuth flow or reach Google's API directly (CORS), so both live here.
//
// The client_id/secret identify the APP, not a user — one shared pair for
// everyone. Each person authorizes their OWN Google account at runtime; only
// their refresh token is stored locally. A "Desktop app" client secret is a
// public-client secret (Google states installed-app secrets aren't
// confidential), so shipping it in the binary is expected and safe.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::{AppHandle, Manager};

const CLIENT_ID: &str = "789173524951-06e3vdigiqukinorged6o651vogh1tlm.apps.googleusercontent.com";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

// The client secret is injected at BUILD time from the GD_CLIENT_SECRET env
// var so it never lives in source (CI sets it from a repo secret; for a local
// dev build, export it before `cargo/tauri build`). It's a public-client
// "Desktop app" secret — not confidential — but keeping it out of git stops
// secret-scanning bots. Empty (unset) → Drive sync is simply unavailable.
fn client_secret() -> &'static str {
    option_env!("GD_CLIENT_SECRET").unwrap_or("")
}

fn token_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("gdrive.json"))
}
fn save_refresh(app: &AppHandle, rt: &str) -> Result<(), String> {
    std::fs::write(token_path(app)?, serde_json::json!({ "refresh_token": rt }).to_string())
        .map_err(|e| e.to_string())
}
fn load_refresh(app: &AppHandle) -> Option<String> {
    let s = std::fs::read_to_string(token_path(app).ok()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    v.get("refresh_token")?.as_str().map(|x| x.to_string())
}

fn rand_verifier() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..64).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}
fn challenge(verifier: &str) -> String {
    let mut h = Sha256::new();
    h.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(h.finalize())
}
fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[tauri::command]
pub async fn gdrive_connected(app: AppHandle) -> bool {
    load_refresh(&app).is_some()
}

#[tauri::command]
pub async fn gdrive_disconnect(app: AppHandle) -> Result<(), String> {
    if let Some(rt) = load_refresh(&app) {
        let _ = reqwest::Client::new()
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", rt.as_str())])
            .send()
            .await;
    }
    let _ = std::fs::remove_file(token_path(&app)?);
    Ok(())
}

// Interactive: open the system browser, catch the loopback redirect, exchange
// the code (PKCE) for a refresh token, and store it.
#[tauri::command]
pub async fn gdrive_connect(app: AppHandle) -> Result<(), String> {
    let verifier = rand_verifier();
    let chal = challenge(&verifier);
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{}", port);
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        urlencode(CLIENT_ID), urlencode(&redirect), urlencode(SCOPE), chal
    );
    open::that(&auth_url).map_err(|e| format!("couldn't open browser: {}", e))?;

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let line = req.lines().next().unwrap_or("");
            let code = line
                .split_whitespace()
                .nth(1)
                .and_then(|path| path.split('?').nth(1))
                .and_then(|q| q.split('&').find(|kv| kv.starts_with("code=")))
                .map(|kv| kv["code=".len()..].to_string());
            let body = "<html><body style='font:16px sans-serif;text-align:center;padding:48px'>\
                        Connected. You can close this tab and return to the app.</body></html>";
            let _ = s.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(), body
                )
                .as_bytes(),
            );
            if let Some(c) = code {
                let _ = tx.send(c);
                break;
            }
        }
    });
    let code = rx
        .recv_timeout(std::time::Duration::from_secs(300))
        .map_err(|_| "login timed out or was cancelled".to_string())?;

    let res = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", CLIENT_ID),
            ("client_secret", client_secret()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let rt = v
        .get("refresh_token")
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("no refresh_token in response: {}", text))?;
    save_refresh(&app, rt)
}

async fn access_token(app: &AppHandle) -> Result<String, String> {
    let rt = load_refresh(app).ok_or("Not connected to Google Drive")?;
    let res = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", CLIENT_ID),
            ("client_secret", client_secret()),
            ("refresh_token", rt.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v.get("access_token")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("token refresh failed: {}", text))
}

// Authenticated Drive REST call. The frontend builds the URL/body/verb; this
// attaches a fresh access token and returns the response text.
#[tauri::command]
pub async fn gdrive_api(
    app: AppHandle,
    method: String,
    url: String,
    body: Option<String>,
    content_type: Option<String>,
) -> Result<String, String> {
    if !url.starts_with("https://www.googleapis.com/") {
        return Err("refusing a non-Google URL".to_string());
    }
    let token = access_token(&app).await?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = reqwest::Client::new().request(m, &url).bearer_auth(token);
    if let Some(ct) = content_type {
        req = req.header("content-type", ct);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Drive {}: {}", status.as_u16(), text));
    }
    Ok(text)
}
