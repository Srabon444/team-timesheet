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

// Snapshot the CURRENT (post-merge) canonical state as a dated backup file.
// Runs gdSync first — never snapshots this device's raw local view, which
// could be missing entries another device added while this one was offline;
// throws rather than ever writing an empty snapshot.
async function gdBackupNow() {
  await gdSync(true);
  const token = await gdToken(true);
  const folderId = await gdEnsureFolder(token);
  const latest = await gdFindLatest(token, folderId);
  if (!latest) throw new Error("Nothing to back up yet — add an entry first.");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  await gdCreateFile(token, folderId, `timesheet-${stamp}.json`, latest.content);
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

// ---- Cross-device sync ------------------------------------------------------
// The rolling timesheet-latest.json is the sync anchor. Unlike the earlier
// "whichever side changed last wins, whole state replaced" design, this
// MERGES: every entry (by its stable id) that exists on either side survives,
// so two devices that each added tasks while offline both keep their tasks
// when they reconnect — neither side's edits get silently discarded. An
// entry only disappears when it's explicitly deleted (tombstoned in
// `deletedEntries`, unioned across devices so a delete on one device still
// takes effect everywhere once merged in). Because merging can only ever
// UNION data in, the merged result can never be smaller than either side
// UNLESS something was actually, deliberately deleted — an empty side can
// never silently erase a non-empty one, structurally, not just by a guard.

function gdTotalEntries(daysMap) {
  return Object.values(daysMap || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}
// Signature of the full syncable state (order-independent over dates/ids),
// so any real difference — including a tombstone-only or submitted-only
// change — is detected without per-mutation bookkeeping.
function gdSig(days, submittedDays, deletedEntries) {
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
function gdMergeDays(localDays, localDeleted, driveDays, driveDeleted) {
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

async function gdFindLatest(token, folderId) {
  const q = encodeURIComponent(`name='timesheet-latest.json' and '${folderId}' in parents and trashed=false`);
  const r = await gdApi(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  const j = await r.json();
  if (!j.files || !j.files.length) return null;
  const id = j.files[0].id;
  return { id, content: await gdDownload(token, id) };
}
async function gdWriteLatest(token, folderId, id, text) {
  if (id) return gdUpdateFile(token, id, text);
  return gdCreateFile(token, folderId, "timesheet-latest.json", text);
}
// interactive=false → silent (skip if not connected). Returns a short status
// string describing what happened, or "" if nothing/not connected.
async function gdSync(interactive) {
  if (typeof buildExportText !== "function") return ""; // not in a data context
  let token;
  try { token = await gdToken(!!interactive); } catch (e) { return interactive ? "Not connected." : ""; }

  const folderId = await gdEnsureFolder(token);
  const latest = await gdFindLatest(token, folderId);
  const localObj = JSON.parse(buildExportText());
  const localDeleted = localObj.deletedEntries || {};

  let driveObj = null;
  if (latest) { try { driveObj = JSON.parse(latest.content); } catch (e) { driveObj = null; } }
  const driveDays = (driveObj && typeof driveObj.days === "object") ? driveObj.days : {};
  const driveSubmitted = (driveObj && driveObj.submittedDays) || {};
  const driveDeleted = (driveObj && driveObj.deletedEntries) || {};

  const { days: mergedDays, deleted: mergedDeleted } = gdMergeDays(localObj.days, localDeleted, driveDays, driveDeleted);
  const mergedSubmitted = { ...driveSubmitted, ...(localObj.submittedDays || {}) };

  // Never write an empty backup, in either direction. Structurally the merge
  // above can't produce an empty result unless both sides genuinely have
  // nothing (or everything present was explicitly deleted) — this is the
  // last line of defense, not the main mechanism.
  if (gdTotalEntries(mergedDays) === 0) {
    return latest ? "Already in sync." : "Nothing to back up yet — add an entry first.";
  }

  const localSig = gdSig(localObj.days, localObj.submittedDays, localDeleted);
  const driveSig = gdSig(driveDays, driveSubmitted, driveDeleted);
  const mergedSig = gdSig(mergedDays, mergedSubmitted, mergedDeleted);

  let pulled = false, pushed = false;
  if (mergedSig !== localSig) {
    await applyBackupData({ days: mergedDays, submittedDays: mergedSubmitted, deletedEntries: mergedDeleted, name: localObj.name });
    pulled = true;
  }
  if (mergedSig !== driveSig) {
    const fresh = JSON.stringify(
      { ...localObj, days: mergedDays, submittedDays: mergedSubmitted, deletedEntries: mergedDeleted, exportedAt: Date.now() },
      null, 2
    );
    await gdWriteLatest(token, folderId, latest ? latest.id : null, fresh);
    pushed = true;
  }
  if (pulled && pushed) return "Synced (merged this device's and Drive's changes).";
  if (pulled) return "Synced (pulled from Drive).";
  if (pushed) return "Synced (pushed to Drive).";
  return "Already in sync.";
}
