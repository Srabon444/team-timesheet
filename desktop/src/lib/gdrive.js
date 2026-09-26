// Google Drive sync/backup/restore for the desktop & mobile apps. OAuth and the Drive HTTP calls
// run in Rust (src-tauri/src/gdrive.rs) — the flow needs the system browser + a loopback server,
// and Google's API blocks CORS from the app origin. The sync model and every Drive call shape live
// in sync-core.js (TTCore), shared byte-for-byte with the extension; this file supplies the
// transport and the atomic local commit.
import { invoke } from "@tauri-apps/api/core";
import { app, save } from "./store.svelte.js";
import * as timer from "./timer.js";
import { TT, deviceName, logEvents, addRecoveryPoint } from "./activity.js";

export function gdConnected() { return invoke("gdrive_connected"); }
export async function gdConnect() {
  await invoke("gdrive_connect");
  app.gdriveNeedsReconnect = false;
}
export function gdDisconnect() {
  app.gdriveNeedsReconnect = false;
  return invoke("gdrive_disconnect");
}

// Every Drive network call funnels through here, so this is the one place
// that needs to notice a revoked/expired token — the Rust side already
// clears the stored refresh token on invalid_grant (see gdrive.rs), but
// callers up the stack (App.svelte's silent auto-sync included) swallow
// errors, so without this the user never finds out until they happen to
// open Settings and notice the button changed back.
async function api(method, url, body, contentType) {
  try {
    return await invoke("gdrive_api", {
      method, url,
      body: body === undefined ? null : body,
      contentType: contentType === undefined ? null : contentType,
    });
  } catch (e) {
    if (!(await gdConnected())) {
      app.gdriveNeedsReconnect = true;
      throw new Error("Google Drive session expired — reconnect in Settings.");
    }
    throw e;
  }
}
const meta = {
  get: async (k) => app.data["gd_" + k],
  set: async (k, v) => { app.data["gd_" + k] = v; save(); },
};

// Merge what Drive has into the CURRENT local data.
//! Synchronous from the read of app.data to its replacement: JS runs it to completion, so no edit
//! can land in between (the network calls all happened before this point).
function commitRemote(remote, devices) {
  const before = TT.stateOf(app.data);
  const merged = TT.merge([before, remote]);
  const dif = TT.diff(before, merged);
  if (dif.removed.length) {
    addRecoveryPoint(before, `before sync removed ${dif.removed.length} entr${dif.removed.length === 1 ? "y" : "ies"}`);
  }
  const running = app.data.timer && app.data.timer.activeId;
  if (running && dif.removed.some((r) => r.e.id === running)) app.data.timer = { activeId: null, startedAt: null, date: null };
  if (running && dif.changed.some((c) => c.after.id === running)) {
    logEvents([{ type: "timer-conflict", id: running, detail: "entry with a running timer here was changed on another device; the other device's time was kept and this timer keeps adding to it" }]);
  }
  app.data.days = merged.days;
  app.data.deletedEntries = merged.deletedEntries;
  app.data.deletedBy = merged.deletedBy;
  app.data.submittedDays = merged.submittedDays;
  app.data.clock = Math.max(app.data.clock || 0, merged.clock);
  save();
  if (dif.added.length || dif.removed.length || dif.changed.length) {
    const shown = dif.added.length > 20 ? { ...dif, added: [] } : dif;
    logEvents([{ type: "sync-pull", added: dif.added.length, removed: dif.removed.length, changed: dif.changed.length },
      ...TT.diffEvents(shown, "sync", devices)]);
  }
  return { final: merged, diff: dif };
}

function io() {
  TT.ensureMeta(app.data);
  return {
    http: api, deviceId: app.data.deviceId, deviceName: deviceName(), name: app.data.name || "",
    meta, log: logEvents,
    onLegacyClient: () => { app.data.gdLegacyClientAt = Date.now(); save(); },
    commit: async (remote, devices) => commitRemote(remote, devices),
  };
}

// interactive=false → silent (skip if not connected). Returns a status string.
//* One sync at a time: a second call waits for the running one, then runs against fresh data.
let chain = Promise.resolve();
export function gdSync(interactive) {
  const run = chain.then(() => syncOnce(interactive));
  chain = run.catch(() => {});
  return run;
}
async function syncOnce(interactive) {
  if (!(await gdConnected())) { if (interactive) throw new Error("Not connected to Google Drive."); return ""; }
  let r;
  try {
    r = await TT.sync(io());
  } catch (e) {
    logEvents([{ type: "sync-error", error: String((e && e.message) || e) }]);
    throw e;
  }
  if (r.pushed || r.pulled) logEvents([{ type: "sync", status: r.status }]);
  await ingestSubmitted();
  return r.status;
}

// Dashboard ingest for every day marked submitted, from the post-merge data — so a day submitted
// on ANOTHER device (pulled in by this sync) is pushed too.
async function ingestSubmitted() {
  for (const [date, info] of Object.entries(app.data.submittedDays || {})) {
    if (!TT.isMarked(info)) continue;
    const list = (app.data.days || {})[date] || [];
    if (!list.length) continue;
    const entries = list.map((e) => ({
      //! elapsedSec, not raw accSec — a running timer hasn't been folded in yet.
      id: e.id, project: e.project || "", category: e.category || "",
      description: e.description || "", seconds: Math.round(timer.elapsedSec(app.data, e)),
    }));
    await timesheetIngest(app.data.name, date, info.method, entries)
      .catch((e) => console.error("timesheetIngest failed for", date, e));
  }
}

// Dated snapshot of this device's post-sync state. true = written, false = skipped (nothing
// changed since the last one); throws rather than ever writing an empty snapshot.
//* sync=false for callers that already ran a sync of their own (mark submitted).
export async function gdBackupNow(sync = true) {
  if (sync) await gdSync(true);
  const state = TT.stateOf(app.data);
  const wrote = await TT.snapshot(io(), state);
  if (wrote) logEvents([{ type: "backup", entries: TT.counts(state).entries }]);
  return wrote;
}

export function gdListBackups() {
  return TT.listBackups(api);
}
export async function gdDownloadBackup(id) {
  return TT.parseEnvelope(await api("GET", `https://www.googleapis.com/drive/v3/files/${id}?alt=media`));
}

// Debounced push after local edits.
let syncTimer = null;
let syncedAt = 0;
export function gdSyncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { gdSyncNow().catch(() => {}); }, 2500);
}
//* Anything that must not be lost awaits this instead of arming the debounce. Both paths funnel
//* through here so one change can't start two full sweeps — gdSync re-pushes every submitted day.
export async function gdSyncNow() {
  if (Date.now() - syncedAt < 3000) { gdSyncSoon(); return ""; } // too soon — re-arm, never drop
  clearTimeout(syncTimer);
  syncedAt = Date.now();
  try { return await gdSync(false); } finally { syncedAt = Date.now(); }
}

export async function timesheetIngest(name, date, method, entries) {
  return invoke("timesheet_ingest", { name, date, method, entries });
}
