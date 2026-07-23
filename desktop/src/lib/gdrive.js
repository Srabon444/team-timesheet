// Google Drive sync/backup/restore for the desktop & mobile apps. OAuth and
// the Drive HTTP calls run in Rust (see src-tauri/src/gdrive.rs) — the flow
// needs the system browser + a loopback server, and Google's API blocks CORS
// from the app origin. This module builds the same backup envelope + sync
// logic as the extension's gdrive.js and drives it through invoke().
import { invoke } from "@tauri-apps/api/core";
import { app, save } from "./store.svelte.js";

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
    deletedEntries: app.data.deletedEntries || {},
  };
}
function applyEnvelope(obj) {
  app.data.days = obj.days || {};
  app.data.submittedDays = obj.submittedDays || {};
  app.data.deletedEntries = obj.deletedEntries || {};
  app.data.timer = { activeId: null, startedAt: null, date: null }; // never import a running timer
  if (obj.name && !app.data.name) app.data.name = obj.name;
  save();
}

// ---- Cross-device sync ------------------------------------------------------
// The rolling timesheet-latest.json is the sync anchor. Unlike an earlier
// "whichever side changed last wins, whole state replaces the other" design,
// this MERGES: every entry (by its stable id) that exists on either side
// survives, so two devices that each added tasks while offline both keep
// their tasks when they reconnect — neither side's edits get silently
// discarded. An entry only disappears when it's explicitly deleted
// (tombstoned in deletedEntries, unioned across devices so a delete on one
// device still takes effect everywhere once merged in). Because merging can
// only ever union data in, the merged result can never be smaller than
// either side unless something was actually, deliberately deleted — an empty
// side can never silently erase a non-empty one, structurally.

function totalEntries(daysMap) {
  return Object.values(daysMap || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}
// Signature of the full syncable state (order-independent over dates/ids),
// so any real difference — including a tombstone-only or submitted-only
// change — is detected without per-mutation bookkeeping.
function sig(days, submittedDays, deletedEntries) {
  const norm = (m) => Object.keys(m || {}).sort().map((k) => [k, m[k]]);
  const s = JSON.stringify([norm(days), norm(submittedDays), norm(deletedEntries)]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
// Union-merge two days maps by entry id, then drop anything tombstoned by
// either side. On an exact id collision (same entry touched on both sides
// while offline) local wins — a plain, deterministic tie-break; there's no
// per-entry modified-time to do better than that today. Pure/testable.
export function mergeDays(localDays, localDeleted, driveDays, driveDeleted) {
  const deleted = { ...(driveDeleted || {}), ...(localDeleted || {}) };
  const dates = new Set([...Object.keys(localDays || {}), ...Object.keys(driveDays || {})]);
  const days = {};
  for (const date of dates) {
    const byId = new Map();
    for (const e of (driveDays || {})[date] || []) byId.set(e.id, e);
    for (const e of (localDays || {})[date] || []) byId.set(e.id, e);
    const list = [...byId.values()].filter((e) => !(e.id in deleted));
    if (list.length) days[date] = list;
  }
  return { days, deleted };
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

// Snapshot the CURRENT (post-merge) canonical state as a dated backup file.
// Runs gdSync first — never snapshots this device's raw local view, which
// could be missing entries another device added while this one was offline;
// throws rather than ever writing an empty snapshot.
export async function gdBackupNow() {
  await gdSync(true);
  const folderId = await ensureFolder();
  const latest = await findLatest(folderId);
  if (!latest) throw new Error("Nothing to back up yet — add an entry first.");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  await createFile(folderId, `timesheet-${stamp}.json`, latest.content);
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
}

async function writeLatest(folderId, id, text) {
  return id ? updateFile(id, text) : createFile(folderId, "timesheet-latest.json", text);
}

// interactive=false → silent (skip if not connected). Returns a status
// string describing what happened. See the extension's gdrive.js for the
// full model.
export async function gdSync(interactive) {
  if (!(await gdConnected())) { if (interactive) throw new Error("Not connected to Google Drive."); return ""; }
  const folderId = await ensureFolder();
  const latest = await findLatest(folderId);
  const localObj = buildEnvelope();
  const localDeleted = localObj.deletedEntries || {};

  let driveObj = null;
  if (latest) { try { driveObj = JSON.parse(latest.content); } catch { driveObj = null; } }
  const driveDays = (driveObj && typeof driveObj.days === "object") ? driveObj.days : {};
  const driveSubmitted = (driveObj && driveObj.submittedDays) || {};
  const driveDeleted = (driveObj && driveObj.deletedEntries) || {};

  const { days: mergedDays, deleted: mergedDeleted } = mergeDays(localObj.days, localDeleted, driveDays, driveDeleted);
  const mergedSubmitted = { ...driveSubmitted, ...(localObj.submittedDays || {}) };

  // Never write an empty backup, in either direction. Structurally the merge
  // above can't produce an empty result unless both sides genuinely have
  // nothing (or everything present was explicitly deleted) — this is the
  // last line of defense, not the main mechanism.
  if (totalEntries(mergedDays) === 0) {
    return latest ? "Already in sync." : "Nothing to back up yet — add an entry first.";
  }

  const localSig = sig(localObj.days, localObj.submittedDays, localDeleted);
  const driveSig = sig(driveDays, driveSubmitted, driveDeleted);
  const mergedSig = sig(mergedDays, mergedSubmitted, mergedDeleted);

  let pulled = false, pushed = false;
  if (mergedSig !== localSig) {
    applyEnvelope({ days: mergedDays, submittedDays: mergedSubmitted, deletedEntries: mergedDeleted, name: localObj.name });
    pulled = true;
  }
  if (mergedSig !== driveSig) {
    const fresh = JSON.stringify(
      { ...localObj, days: mergedDays, submittedDays: mergedSubmitted, deletedEntries: mergedDeleted, exportedAt: Date.now() },
      null, 2
    );
    await writeLatest(folderId, latest ? latest.id : null, fresh);
    pushed = true;
  }
  if (pulled && pushed) return "Synced (merged this device's and Drive's changes).";
  if (pulled) return "Synced (pulled from Drive).";
  if (pushed) return "Synced (pushed to Drive).";
  return "Already in sync.";
}

// Debounced push after local edits.
let syncTimer = null;
export function gdSyncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { gdSync(false).catch(() => {}); }, 2500);
}
