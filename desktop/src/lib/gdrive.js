// Google Drive sync/backup/restore for the desktop & mobile apps. OAuth and
// the Drive HTTP calls run in Rust (see src-tauri/src/gdrive.rs) — the flow
// needs the system browser + a loopback server, and Google's API blocks CORS
// from the app origin. This module builds the same backup envelope + sync
// logic as the extension's gdrive.js and drives it through invoke().
import { invoke } from "@tauri-apps/api/core";
import { app, save, showConfirm } from "./store.svelte.js";

const FOLDER = "Team Timesheet Backups";

export function gdConnected() { return invoke("gdrive_connected"); }
export function gdConnect() { return invoke("gdrive_connect"); }
export function gdDisconnect() { return invoke("gdrive_disconnect"); }

function api(method, url, body, contentType) {
  return invoke("gdrive_api", {
    method, url,
    body: body === undefined ? null : body,
    contentType: contentType === undefined ? null : contentType,
  });
}
async function apiJson(method, url, body, contentType) {
  return JSON.parse(await api(method, url, body, contentType));
}

function buildEnvelope() {
  return {
    app: "team-timesheet", v: 1, exportedAt: Date.now(), name: app.data.name || "",
    days: app.data.days || {}, submittedDays: app.data.submittedDays || {},
  };
}
function applyEnvelope(obj) {
  app.data.days = obj.days || {};
  app.data.submittedDays = obj.submittedDays || {};
  app.data.timer = { activeId: null, startedAt: null, date: null }; // never import a running timer
  if (obj.name && !app.data.name) app.data.name = obj.name;
  save();
}

// Stable, order-independent signature of days + submittedDays (djb2). Lets us
// detect "local changed since last sync" without instrumenting every
// mutation. Both maps are hashed so a submitted-mark-only change (no entry
// edits) still registers as a change and gets pushed.
function sig(days, submittedDays) {
  const norm = (m) => Object.keys(m || {}).sort().map((k) => [k, m[k]]);
  const s = JSON.stringify([norm(days), norm(submittedDays)]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
function totalEntries(daysMap) {
  return Object.values(daysMap || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}
// True when the side about to be adopted (push→Drive, pull→local) is
// completely empty while the side it would replace has data — the actual
// data-loss failure mode (Reset Everything, or a bad Restore, silently
// wiping Drive + every other synced device). Pure/testable on purpose.
export function shouldGuardWipe(wantPush, localTotal, driveTotal) {
  return wantPush ? (localTotal === 0 && driveTotal > 0) : (driveTotal === 0 && localTotal > 0);
}

async function ensureFolder() {
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const r = await apiJson("GET", `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`);
  if (r.files && r.files.length) return r.files[0].id;
  const cr = await apiJson("POST", "https://www.googleapis.com/drive/v3/files?fields=id",
    JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" }), "application/json");
  return cr.id;
}
async function createFile(folderId, name, content) {
  const boundary = "ttb" + Math.random().toString(16).slice(2);
  const meta = { name, parents: [folderId], mimeType: "application/json" };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  return apiJson("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
    body, `multipart/related; boundary=${boundary}`);
}
async function updateFile(fileId, content) {
  return apiJson("PATCH", `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name`,
    content, "application/json");
}
async function findLatest(folderId) {
  const q = encodeURIComponent(`name='timesheet-latest.json' and '${folderId}' in parents and trashed=false`);
  const j = await apiJson("GET", `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  if (!j.files || !j.files.length) return null;
  const id = j.files[0].id;
  return { id, content: await gdDownload(id) };
}

export async function gdBackupNow() {
  const folderId = await ensureFolder();
  const text = JSON.stringify(buildEnvelope(), null, 2);
  const latest = await findLatest(folderId);
  if (latest) await updateFile(latest.id, text);
  else await createFile(folderId, "timesheet-latest.json", text);
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  await createFile(folderId, `timesheet-${stamp}.json`, text);
}
export async function gdListBackups() {
  const folderId = await ensureFolder();
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='application/json'`);
  const j = await apiJson("GET",
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`);
  return j.files || [];
}
export function gdDownload(id) {
  return api("GET", `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
}
export async function gdRestoreFile(id) {
  const text = await gdDownload(id);
  const obj = JSON.parse(text);
  if (!obj || typeof obj.days !== "object") throw new Error("That file isn't a valid backup.");
  applyEnvelope(obj);
  await markSynced(obj.exportedAt || Date.now(), sig(obj.days, obj.submittedDays));
}

async function writeLatest(folderId, id, text) {
  return id ? updateFile(id, text) : createFile(folderId, "timesheet-latest.json", text);
}
function markSynced(at, s) {
  app.data.gdSyncedAt = at;
  app.data.gdSyncedSig = s;
  save();
}

// interactive=false → silent (skip if not connected). Returns a status
// string describing what happened. See the extension's gdrive.js for the
// full model.
export async function gdSync(interactive) {
  if (!(await gdConnected())) { if (interactive) throw new Error("Not connected to Google Drive."); return ""; }
  const folderId = await ensureFolder();
  const latest = await findLatest(folderId);
  const localObj = buildEnvelope();
  const localSig = sig(localObj.days, localObj.submittedDays);
  const localChanged = localSig !== (app.data.gdSyncedSig || "");

  if (!latest) { await writeLatest(folderId, null, JSON.stringify(localObj, null, 2)); markSynced(localObj.exportedAt, localSig); return "Synced (pushed to Drive)."; }
  let driveObj;
  try { driveObj = JSON.parse(latest.content); } catch { driveObj = null; }
  if (!driveObj || typeof driveObj.days !== "object") {
    await writeLatest(folderId, latest.id, JSON.stringify(localObj, null, 2)); markSynced(localObj.exportedAt, localSig); return "Synced (pushed to Drive).";
  }
  const driveAt = driveObj.exportedAt || 0;
  const driveChanged = driveAt !== (app.data.gdSyncedAt || 0);

  const pull = async () => { applyEnvelope(driveObj); markSynced(driveAt, sig(driveObj.days, driveObj.submittedDays)); return "Synced (pulled from Drive)."; };
  const push = async () => { const fresh = buildEnvelope(); await writeLatest(folderId, latest.id, JSON.stringify(fresh, null, 2)); markSynced(fresh.exportedAt, sig(fresh.days, fresh.submittedDays)); return "Synced (pushed to Drive)."; };

  if (!driveChanged && !localChanged) return "Already in sync.";

  // Decide direction first; a genuine two-sided conflict is broken by recency.
  const wantPush = localChanged && (!driveChanged || (app.data.lastEditAt || 0) > driveAt);

  // Only an exact wipe-to-zero is guarded, not a large-but-partial reduction
  // — widen shouldGuardWipe if partial loss becomes a real incident too.
  const localTotal = totalEntries(localObj.days);
  const driveTotal = totalEntries(driveObj.days);
  if (shouldGuardWipe(wantPush, localTotal, driveTotal)) {
    if (!interactive) return "Skipped auto-sync: one side is empty, the other isn't. Open Settings → Sync now to confirm.";
    const label = wantPush
      ? `erase Drive's ${driveTotal} entr${driveTotal === 1 ? "y" : "ies"} (and every other synced device)`
      : `erase this device's ${localTotal} entr${localTotal === 1 ? "y" : "ies"}`;
    const ok = await showConfirm(`One side is empty and the other isn't. Really ${label}?`, "Yes, erase");
    if (!ok) return "Sync cancelled — nothing changed.";
  }
  return wantPush ? push() : pull();
}

// Debounced push after local edits.
let syncTimer = null;
export function gdSyncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { gdSync(false).catch(() => {}); }, 2500);
}
