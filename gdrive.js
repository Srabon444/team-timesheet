"use strict";
// Google Drive backup/restore/sync for the extension. Auth is chrome.identity getAuthToken (OAuth
// client + drive.file scope declared in manifest "oauth2"); the sync model and every Drive call
// shape live in sync-core.js (TTCore), shared with the desktop apps. This file only supplies the
// token, the HTTP transport and the atomic local commit (TTData, data.js).
//
// Plain-script globals (no modules) to match popup.js/tab.js.

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
function gdHttp(token) {
  return async (method, url, body, contentType) => {
    const res = await gdApi(token, url, {
      method,
      body: body === undefined || body === null ? undefined : body,
      headers: contentType ? { "Content-Type": contentType } : {},
    });
    return res.text();
  };
}
const gdMeta = {
  get: async (k) => (await chrome.storage.local.get("gd_" + k))["gd_" + k],
  set: (k, v) => chrome.storage.local.set({ ["gd_" + k]: v }),
};

// Merge what Drive has into the CURRENT local data. Runs inside TTData.withData, i.e. under the
// data lock against a fresh storage read, so an edit made while the network calls were in flight
// is part of `d` here and survives.
function gdCommitRemote(d, remote, devices) {
  const before = TTCore.stateOf(d);
  const merged = TTCore.merge([before, remote]);
  const dif = TTCore.diff(before, merged);
  //! Anything a sync removes gets a local recovery point first, so it can be picked back.
  if (dif.removed.length) TTData.addRecoveryPoint(d, `before sync removed ${dif.removed.length} entr${dif.removed.length === 1 ? "y" : "ies"}`);
  const running = d.timer && d.timer.activeId;
  if (running && dif.removed.some((r) => r.e.id === running)) d.timer = { activeId: null, startedAt: null };
  if (running && dif.changed.some((c) => c.after.id === running)) {
    TTData.log(d, [{ type: "timer-conflict", id: running, detail: "entry with a running timer here was changed on another device; the other device's time was kept and this timer keeps adding to it" }]);
  }
  d.days = merged.days;
  d.deletedEntries = merged.deletedEntries;
  d.deletedBy = merged.deletedBy;
  d.submittedDays = merged.submittedDays;
  d.clock = Math.max(d.clock || 0, merged.clock);
  if (dif.added.length || dif.removed.length || dif.changed.length) {
    const added = dif.added.length > 20 ? { ...dif, added: [] } : dif;
    TTData.log(d, [{ type: "sync-pull", added: dif.added.length, removed: dif.removed.length, changed: dif.changed.length },
      ...TTCore.diffEvents(added, "sync", devices)]);
  }
  return { final: merged, diff: dif };
}

async function gdIo(token) {
  let st = await chrome.storage.local.get(["deviceId", "name"]);
  if (!st.deviceId) st = { ...st, deviceId: (await TTData.withData(() => {})).doc.deviceId };
  return {
    http: gdHttp(token), deviceId: st.deviceId, deviceName: TTData.DEVICE_NAME, name: st.name || "",
    meta: gdMeta,
    log: (evs) => TTData.withData((d) => TTData.log(d, evs)),
    onLegacyClient: () => chrome.storage.local.set({ gdLegacyClientAt: Date.now() }),
    commit: async (remote, devices) => (await TTData.withData((d) => gdCommitRemote(d, remote, devices))).result,
  };
}

// interactive=false → silent (skip if not connected). Returns a short status string, or "".
//* "tt-sync" serializes whole syncs across this device's windows (they share one device file on
//* Drive); it is a separate lock from the data lock, so edits never wait on the network.
async function gdSync(interactive) {
  let token;
  try { token = await gdToken(!!interactive); } catch (e) { return interactive ? "Not connected." : ""; }
  return TTData.lock("tt-sync", async () => {
    const io = await gdIo(token);
    let r;
    try {
      r = await TTCore.sync(io);
    } catch (e) {
      await io.log([{ type: "sync-error", error: String(e && e.message || e) }]);
      throw e;
    }
    if (r.pushed || r.pulled) await io.log([{ type: "sync", status: r.status }]);
    await gdIngestSubmitted();
    return r.status;
  });
}

// Dashboard ingest for every day marked submitted, from the post-merge data — so a day submitted
// on ANOTHER device (pulled in by this sync) is pushed too.
async function gdIngestSubmitted() {
  if (typeof pushIngest !== "function") return;
  const st = await chrome.storage.local.get(["entries", "history", "date", "submittedDays"]);
  const days = { ...(st.history || {}), [st.date]: st.entries || [] };
  for (const [date, info] of Object.entries(st.submittedDays || {})) {
    if (!TTCore.isMarked(info)) continue;
    const list = days[date] || [];
    if (!list.length) continue;
    const entries = list.map((e) => ({
      id: e.id, project: e.project, category: e.category, description: e.description, seconds: Math.round(e.accSec || 0),
    }));
    await pushIngest(date, info.method, entries).catch((e) => console.error("pushIngest failed for", date, e));
  }
}

// Dated snapshot of this device's post-sync state. Returns true if written, false if skipped
// (nothing changed since the last one); throws rather than ever writing an empty snapshot.
//! interactive=false for anything fired off a plain click — the consent window takes focus and
//! destroys the popup mid-call. Only the full view's explicit "Back up now" should prompt.
async function gdBackupNow(interactive) {
  if (interactive === undefined) interactive = true;
  await gdSync(interactive);
  const token = await gdToken(interactive);
  const io = await gdIo(token);
  const st = await chrome.storage.local.get(null);
  const state = TTCore.stateOf(TTData.toDoc(st));
  const wrote = await TTCore.snapshot(io, state);
  if (wrote) await io.log([{ type: "backup", entries: TTCore.counts(state).entries }]);
  return wrote;
}

async function gdListBackups(token) {
  return TTCore.listBackups(gdHttp(token));
}
async function gdDownload(token, id) {
  return gdHttp(token)("GET", `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
}
