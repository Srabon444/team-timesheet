"use strict";
// Google Drive backup/restore for the extension. Uses chrome.identity
// getAuthToken (OAuth client + scope declared in manifest "oauth2") and the
// Drive v3 REST API with the drive.file scope — so the app only ever sees
// files it created. Backups live in a "Team Timesheet Backups" folder in the
// user's own Drive: a rolling `timesheet-latest.json` (overwritten each
// backup) plus a dated snapshot per backup for history.
//
// Plain-script globals (no modules) to match popup.js/tab.js; loaded before
// tab.js in tab.html.

const GD_FOLDER = "Team Timesheet Backups";

function gdToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "Not signed in"));
      } else {
        resolve(token);
      }
    });
  });
}
function gdRemoveToken(token) {
  return new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
}
async function gdConnected() {
  try { await gdToken(false); return true; } catch { return false; }
}
async function gdDisconnect() {
  try {
    const t = await gdToken(false);
    // Best-effort revoke; then drop the cached token so the next connect is fresh.
    try { await fetch("https://oauth2.googleapis.com/revoke?token=" + t, { method: "POST" }); } catch (e) {}
    await gdRemoveToken(t);
  } catch (e) {}
}

// One Drive REST call. On 401 the cached token is stale — drop it and surface
// a clear error so the caller can re-auth interactively.
async function gdApi(token, url, opts) {
  opts = opts || {};
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    await gdRemoveToken(token);
    throw new Error("Google session expired — click Connect again.");
  }
  if (!res.ok) throw new Error("Drive " + res.status + ": " + (await res.text()).slice(0, 140));
  return res;
}

async function gdEnsureFolder(token) {
  const q = encodeURIComponent(
    `name='${GD_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const r = await gdApi(token, `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`);
  const j = await r.json();
  if (j.files && j.files.length) return j.files[0].id;
  const cr = await gdApi(token, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: GD_FOLDER, mimeType: "application/vnd.google-apps.folder" }),
  });
  return (await cr.json()).id;
}

async function gdCreateFile(token, folderId, name, content) {
  const boundary = "ttb" + Math.random().toString(16).slice(2);
  const meta = { name, parents: [folderId], mimeType: "application/json" };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await gdApi(
    token,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
    { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }
  );
  return res.json();
}
async function gdUpdateFile(token, fileId, content) {
  const res = await gdApi(
    token,
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: content }
  );
  return res.json();
}

// Write the rolling latest file (create or overwrite) + a dated snapshot.
async function gdBackupNow(token, exportText) {
  const folderId = await gdEnsureFolder(token);
  const q = encodeURIComponent(`name='timesheet-latest.json' and '${folderId}' in parents and trashed=false`);
  const r = await gdApi(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  const j = await r.json();
  if (j.files && j.files.length) await gdUpdateFile(token, j.files[0].id, exportText);
  else await gdCreateFile(token, folderId, "timesheet-latest.json", exportText);

  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  await gdCreateFile(token, folderId, `timesheet-${stamp}.json`, exportText);
}

async function gdListBackups(token) {
  const folderId = await gdEnsureFolder(token);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='application/json'`);
  const r = await gdApi(
    token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`
  );
  return (await r.json()).files || [];
}
async function gdDownload(token, id) {
  const r = await gdApi(token, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  return r.text();
}
