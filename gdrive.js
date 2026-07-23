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

// ---- Cross-device sync ------------------------------------------------------
// The rolling timesheet-latest.json IS the sync anchor. Each device compares a
// content SIGNATURE of its own data (so no per-mutation bookkeeping is needed)
// against the last-synced signature, and the Drive file's version (its
// envelope's exportedAt) against the last-synced version:
//   drive changed only  -> pull        local changed only -> push
//   both changed        -> keep whichever was edited more recently
//   neither             -> already in sync
// Whichever side is about to be REPLACED, if it's non-empty and the
// incoming side is completely empty, that's a wipe (e.g. Reset Everything,
// or a bad Restore) — refuse it silently and ask first. See gdSync.

// Stable signature of the days map + submittedDays (order-independent over
// dates), so a submitted-mark-only change is detected as a local change too
// (previously only `days` was hashed, so marking a day submitted without
// touching entries never triggered a push and silently didn't sync).
function gdSig(days, submittedDays) {
  const norm = (m) => Object.keys(m || {}).sort().map((k) => [k, m[k]]);
  const s = JSON.stringify([norm(days), norm(submittedDays)]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
function gdTotalEntries(daysMap) {
  return Object.values(daysMap || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}
// True when the side about to be adopted (push→Drive, pull→local) is
// completely empty while the side it would replace has data — the actual
// data-loss failure mode (Reset Everything, or a bad Restore, silently
// wiping Drive + every other synced device). Pure/testable on purpose.
function gdShouldGuardWipe(wantPush, localTotal, driveTotal) {
  return wantPush ? (localTotal === 0 && driveTotal > 0) : (driveTotal === 0 && localTotal > 0);
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
async function gdMarkSynced(at, sig) {
  S.gdSyncedAt = at;
  S.gdSyncedSig = sig;
  await chrome.storage.local.set({ gdSyncedAt: at, gdSyncedSig: sig });
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
  const localSig = gdSig(localObj.days, localObj.submittedDays);
  const syncedAt = S.gdSyncedAt || 0;
  const syncedSig = S.gdSyncedSig || "";
  const localChanged = localSig !== syncedSig;

  if (!latest) {
    await gdWriteLatest(token, folderId, null, JSON.stringify(localObj, null, 2));
    await gdMarkSynced(localObj.exportedAt, localSig);
    return "Synced (pushed to Drive).";
  }

  let driveObj;
  try { driveObj = JSON.parse(latest.content); } catch (e) { driveObj = null; }
  if (!driveObj || typeof driveObj.days !== "object") {
    await gdWriteLatest(token, folderId, latest.id, JSON.stringify(localObj, null, 2));
    await gdMarkSynced(localObj.exportedAt, localSig);
    return "Synced (pushed to Drive).";
  }
  const driveAt = driveObj.exportedAt || 0;
  const driveChanged = driveAt !== syncedAt;

  const pull = async () => {
    await applyBackupData(driveObj);
    await gdMarkSynced(driveAt, gdSig(driveObj.days, driveObj.submittedDays));
    return "Synced (pulled from Drive).";
  };
  const push = async () => {
    const fresh = JSON.parse(buildExportText());
    await gdWriteLatest(token, folderId, latest.id, JSON.stringify(fresh, null, 2));
    await gdMarkSynced(fresh.exportedAt, gdSig(fresh.days, fresh.submittedDays));
    return "Synced (pushed to Drive).";
  };

  if (!driveChanged && !localChanged) return "Already in sync.";

  // Decide direction first; a genuine two-sided conflict is broken by recency.
  const wantPush = localChanged && (!driveChanged || (S.lastEditAt || 0) > driveAt);

  // Only an exact wipe-to-zero is guarded, not a large-but-partial reduction
  // — widen gdShouldGuardWipe if partial loss becomes a real incident too.
  const localTotal = gdTotalEntries(localObj.days);
  const driveTotal = gdTotalEntries(driveObj.days);
  if (gdShouldGuardWipe(wantPush, localTotal, driveTotal)) {
    if (!interactive) return "Skipped auto-sync: one side is empty, the other isn't. Open Settings → Sync now to confirm.";
    const label = wantPush
      ? `erase Drive's ${driveTotal} entr${driveTotal === 1 ? "y" : "ies"} (and every other synced device)`
      : `erase this device's ${localTotal} entr${localTotal === 1 ? "y" : "ies"}`;
    const ok = await showConfirm(`One side is empty and the other isn't. Really ${label}?`, "Yes, erase");
    if (!ok) return "Sync cancelled — nothing changed.";
  }
  return wantPush ? push() : pull();
}
