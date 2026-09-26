// Central reactive state (Svelte 5 runes) + persistence via the Rust
// commands. All timer/entry mutations funnel through here so every change
// is saved and the UI stays live.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { submitHeadless } from "./fillout-api.js";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { FORM_URL, SUBFORM_URL, DEFAULT_PROJECTS, DEFAULT_CATEGORIES } from "./constants.js";
import { todayStr, secToHHMM } from "./time.js";
import { dayTotal } from "./stats.js";
import * as timer from "./timer.js";
import { parseNames, parseDropdownOptions } from "./names.js";
import { buildFillScript } from "./fillout-inject.js";
import { gdBackupNow, gdSyncNow, timesheetIngest, gdConnected, gdConnect } from "./gdrive.js";
import { TT, logEvents, addRecoveryPoint } from "./activity.js";
import * as prayer from "./prayer.js";
import { prayerReminderAt } from "./prayer-hadiths.js";

function defaults() {
  return {
    days: {},
    submittedDays: {}, // { date: { at, method: "auto"|"manual"|null, by } } — null method = unmarked
    deletedEntries: {}, // { entryId: deletedAt } — tombstones; an entry stays live only if updated after it
    deletedBy: {}, // { entryId: deviceId } — who deleted it, for the activity log
    clock: 0, // hybrid logical clock for stamps (sync-core.js)
    deviceId: "", // this install's id; names its own file on Drive
    timer: { activeId: null, startedAt: null, date: null },
    name: "",
    names: [],
    projects: [],
    categories: [],
    lastProject: null,
    lastCategory: null,
    dailyLimitHours: 8,
    warnedDate: null,
    confirmBeforeDelete: true,
    theme: "dark",
    prayer: prayer.prayerDefaults(),
  };
}

export const app = $state({
  data: defaults(),
  loaded: false,
  gdriveNeedsReconnect: false, // Drive token revoked/expired mid-session — banner until user reconnects
  loadError: "", // data.json couldn't be read at startup — banner
  saveBlocked: false, // data.json exists but is unreadable (e.g. locked): never save over it
  saveError: "", // the last save failed — banner until one succeeds
  now: Date.now(), // ticked every second; reading it makes timer displays live
  fill: { running: false, added: 0, message: "", error: "" },
  confirm: null, // { message, yesLabel, resolve }
});

// Cross-page navigation (e.g. clicking a Timesheet day jumps to it in Timer).
export const nav = $state({ page: "timer", jumpDate: null });
export function goToDate(date) {
  nav.jumpDate = date;
  nav.page = "timer";
}

//* Saves run immediately and one at a time; changes made while a save is in flight are written by
//* the next pass. The old 150ms debounce lost the last edit whenever the app closed (or Android
//* killed it) inside that window, and swallowed every save error.
let saving = false;
let dirty = false;
export function save() {
  if (app.saveBlocked) return; //! the file on disk couldn't be read — never overwrite it
  dirty = true;
  if (!saving) flushSaves();
}
async function flushSaves() {
  saving = true;
  try {
    while (dirty) {
      await Promise.resolve(); // coalesce changes made in the same tick
      dirty = false;
      try {
        await invoke("save_data", { json: JSON.stringify(app.data) });
        if (app.saveError) app.saveError = "";
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (app.saveError !== msg) logEvents([{ type: "save-error", error: msg }]);
        app.saveError = msg;
      }
    }
  } finally {
    saving = false;
  }
}

export function resolveTheme(theme) {
  if (theme === "system") {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}
export function applyTheme(theme) {
  app.data.theme = theme;
  document.documentElement.dataset.theme = resolveTheme(theme);
  save();
}

export async function load() {
  let stored = {};
  try {
    stored = JSON.parse((await invoke("load_data")) || "{}");
  } catch (e) {
    //! "unreadable" = the file is there but locked/unreadable: block saving so it's never replaced.
    //! "corrupt" = Rust already copied it aside, so starting fresh (and re-syncing) is safe.
    const msg = String((e && e.message) || e);
    app.loadError = msg;
    app.saveBlocked = !/^corrupt/.test(msg);
    logEvents([{ type: "load-error", error: msg }]);
    stored = {};
  }
  app.data = { ...defaults(), ...stored };
  app.data.timer = { activeId: null, startedAt: null, date: null, ...(stored.timer || {}) };
  TT.ensureMeta(app.data);
  document.documentElement.dataset.theme = resolveTheme(app.data.theme);
  timer.rolloverIfNeeded(app.data);
  app.loaded = true;
  save();
  startTick();
  listenForFillStatus();
  // Keep Names/Project/Category in sync with the live form on every open
  // instead of requiring a manual Settings click — same silent-refresh idea
  // as the gdSync App.svelte already fires after load().
  fetchNames().catch(() => {});
  fetchProjectsAndCategories().catch(() => {});
  ensurePrayerMonth().catch(() => {});
}

// ---------- timer / entry actions (persisting wrappers) ----------
const findEntry = (date, id) => timer.entriesFor(app.data, date).find((e) => e.id === id) || null;
export function startEntryTimer(date, id) {
  timer.startTimer(app.data, date, id);
  save();
}
export function pauseEntryTimer() {
  const { activeId, date } = app.data.timer;
  timer.pauseTimer(app.data);
  save();
  const e = activeId && findEntry(date, activeId);
  if (e) logEvents([{ type: "timer-stop", id: e.id, date, entry: TT.short(e) }]);
}
export function setEntryTime(date, id, hhmm) {
  const e = findEntry(date, id);
  const from = e && TT.short(e);
  timer.editTime(app.data, date, id, hhmm);
  save();
  if (e) logEvents([{ type: "edit-time", id, date, from, to: TT.short(e) }]);
}
export function addEntry(date, fields) {
  const e = timer.addEntry(app.data, date, fields);
  save();
  logEvents([{ type: "add", id: e.id, date, entry: TT.short(e) }]);
  return e;
}
export function updateEntry(date, id, fields) {
  const before = findEntry(date, id);
  const from = before && TT.short(before);
  const e = timer.updateEntry(app.data, date, id, fields);
  save();
  if (e) logEvents([{ type: "edit", id, date, from, to: TT.short(e) }]);
  return e;
}
export function removeEntry(date, id) {
  const gone = findEntry(date, id);
  timer.deleteEntry(app.data, date, id);
  //! Tombstone even when it's already gone here — another device may still hold a copy.
  TT.tombstone(app.data, id);
  save();
  logEvents([{ type: "delete", id, date, entry: gone ? TT.short(gone) : "(not present locally)" }]);
}
export function entryElapsed(entry) {
  void app.now; // subscribe to the tick so displays update every second
  return timer.elapsedSec(app.data, entry);
}
export function activeEntry() {
  void app.now;
  const { activeId, date } = app.data.timer;
  if (!activeId) return null;
  return timer.entriesFor(app.data, date).find((e) => e.id === activeId) || null;
}

// ---------- submission status (Task 7) ----------
export async function markDaySubmitted(date, method = "manual") {
  TT.setSubmitted(app.data, date, method);
  save();
  logEvents([{ type: "mark-submitted", date, method }]);
  //* No direct ingest call here: gdSyncNow() pushes every submitted day it knows about, using the
  //* merged (and correctly folded) entries. Pushing here too just sent the same day twice.
  await gdSyncNow();
  gdBackupNow(false).catch(() => {}); // dated snapshot of the moment this day was marked, best-effort
  if (method === "manual") await nudgeGoogleSignIn();
}
//! Unmark is a stamped {method:null}, never a deleted key — the merge keeps the newest value per
//! day, so an absent key would lose to another device's older mark and the day would come back.
export async function unmarkDaySubmitted(date) {
  TT.setSubmitted(app.data, date, null);
  save();
  logEvents([{ type: "unmark-submitted", date }]);
  if (await gdConnected()) {
    await timesheetIngest(app.data.name, date, "unmark", []).catch((e) =>
      console.error("timesheetIngest unmark failed for", date, e)
    );
  }
  await gdSyncNow();
}
//! Never blocks the mark — the day is already saved. Signing in only gets it off this device.
async function nudgeGoogleSignIn() {
  if (await gdConnected()) return;
  const go = await showConfirm(
    "Marked submitted on this device only.\n\n" +
      "Signing in to Google backs this day up to your Drive and sends it to the team dashboard. " +
      "Sign in now?",
    "Sign in"
  );
  if (!go) return;
  //* Failure lands in the existing reconnect banner rather than a new error surface — the
  //* banner now retries the consent flow directly, so it is the one place to send them.
  try { await gdConnect(); } catch { app.gdriveNeedsReconnect = true; }
}
export function daySubmitted(date) {
  const info = app.data.submittedDays ? app.data.submittedDays[date] : null;
  return TT.isMarked(info) ? info : null;
}

// ---------- restore / reset ----------
//* A restore only ever ADDS the tasks the user ticked; nothing current is removed or overwritten.
export function restoreCandidates(backup) {
  return TT.restoreCandidates(TT.stateOf(app.data), backup);
}
export function restorePicked(picked, source) {
  addRecoveryPoint(TT.stateOf(app.data), `before restoring from ${source}`);
  const added = TT.applyRestore(app.data, app.data.days, picked);
  save();
  logEvents([{ type: "restore", source, added: added.length },
    ...added.map((x) => ({ type: "add", id: x.e.id, date: x.date, entry: TT.short(x.e), via: "restore" }))]);
  return added.length;
}
export function resetEverything() {
  addRecoveryPoint(TT.stateOf(app.data), "before Reset Everything");
  let n = 0;
  //* Tombstones propagate the reset to other devices instead of them pulling everything back.
  for (const list of Object.values(app.data.days)) for (const e of list) { TT.tombstone(app.data, e.id); n++; }
  app.data.days = {};
  app.data.timer = { activeId: null, startedAt: null, date: null };
  app.data.lastProject = null;
  app.data.lastCategory = null;
  app.data.dailyLimitHours = 8;
  app.data.warnedDate = null;
  app.data.confirmBeforeDelete = true;
  applyTheme("dark");
  save();
  logEvents([{ type: "reset", tombstoned: n }]);
}

// ---------- confirm modal (promise-based, per-action labels) ----------
export function showConfirm(message, yesLabel = "Yes") {
  return new Promise((resolve) => {
    app.confirm = { message, yesLabel, resolve: (r) => resolve(r === "yes") };
  });
}
export function answerConfirm(result) {
  if (app.confirm) {
    app.confirm.resolve(result);
    app.confirm = null;
  }
}

// ---------- names ----------
export async function fetchNames() {
  const html = await invoke("fetch_form_html", { url: FORM_URL });
  const names = parseNames(html);
  if (!names.length) throw new Error("could not read names from the form");
  app.data.names = names;
  save();
  return names;
}

// ---------- projects & categories ----------
// Fallback until fetchProjectsAndCategories() has run once; not sorted (kept
// in the form's native order, which ends with a catch-all "Others").
export function currentProjects() {
  return app.data.projects && app.data.projects.length ? app.data.projects : DEFAULT_PROJECTS;
}
export function currentCategories() {
  return app.data.categories && app.data.categories.length ? app.data.categories : DEFAULT_CATEGORIES;
}
export async function fetchProjectsAndCategories() {
  const html = await invoke("fetch_form_html", { url: SUBFORM_URL });
  const projects = parseDropdownOptions(html, "Project");
  const categories = parseDropdownOptions(html, "Work Category");
  if (!projects.length && !categories.length) throw new Error("could not read projects/categories from the form");
  if (projects.length) app.data.projects = projects;
  if (categories.length) app.data.categories = categories;
  save();
  return { projects, categories };
}

// ---------- daily-limit notification + 1s tick ----------
async function maybeNotifyLimit() {
  const d = app.data;
  if (!d.dailyLimitHours) return;
  const today = todayStr();
  if (d.warnedDate === today) return;
  let total = dayTotal(d.days[today]);
  if (d.timer.activeId && d.timer.startedAt && d.timer.date === today) {
    total += (Date.now() - d.timer.startedAt) / 1000;
  }
  if (total >= d.dailyLimitHours * 3600) {
    d.warnedDate = today;
    save();
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) {
        sendNotification({
          title: "Daily limit reached",
          body: `You've tracked ${d.dailyLimitHours}+ hour(s) today.`,
        });
      }
    } catch {}
  }
}

// ---------- prayer reminders ----------
//! Rides the existing 1s tick but only does work once a minute — prayer times have minute
//! resolution, so a per-second check would just re-scan and re-save for nothing.
let lastPrayerMinute = "";
async function maybeNotifyPrayer() {
  const p = app.data.prayer;
  if (!p || !p.enabled) return;
  const now = new Date();
  const stamp = `${now.getHours()}:${now.getMinutes()}`;
  if (stamp === lastPrayerMinute) return;
  lastPrayerMinute = stamp;

  const key = prayer.dayKey(now);
  const times = (p.days || {})[key];
  if (!times) return; // month cache missing or stale — ensurePrayerMonth() refreshes it

  const doneToday = (p.notified || {})[key] || [];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const { due, stale } = prayer.duePrayers(times, nowMin, doneToday);
  const ending = prayer.endingWarnings(times, nowMin, doneToday);
  if (!due.length && !stale.length && !ending.due.length && !ending.stale.length) return;

  let index = p.reminderIndex || 0;
  if (due.length || ending.due.length) {
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) {
        for (const name of due) sendNotification(prayer.notificationText(name, prayerReminderAt(index++)));
        for (const w of ending.due) sendNotification(prayer.endingText(w));
      } else {
        index += due.length; // keep the rotation moving even if the OS refused
      }
    } catch {
      index += due.length;
    }
  }
  //* Stale ones are recorded without a notification, so a machine that was asleep doesn't get a
  //* burst of catch-up alerts the moment it wakes.
  app.data.prayer = {
    ...p,
    notified: {
      ...(p.notified || {}),
      [key]: [...doneToday, ...due, ...stale, ...ending.due.map((w) => w.mark), ...ending.stale],
    },
    reminderIndex: index,
  };
  save();
}

// Refresh the cached month when it rolls over. Silent: a failure leaves the old cache in place.
export async function ensurePrayerMonth() {
  const p = app.data.prayer;
  if (!p || !p.enabled || !p.city) return;
  const key = prayer.monthKey(new Date());
  //! A day cached before the boundary timings were stored cannot tell when a waqt ends, so a
  //! missing Sunrise forces a refetch rather than waiting for the month to roll over.
  const cached = (p.days || {})[prayer.dayKey(new Date())];
  if (p.month === key && Object.keys(p.days || {}).length && (!cached || cached.Sunrise)) return;
  try {
    const fresh = await prayer.fetchMonth(p.city, p.country, p.method, p.school);
    app.data.prayer = {
      ...p,
      ...fresh,
      notified: prayer.pruneToMonth(p.notified, prayer.monthPrefix(new Date())),
    };
    save();
  } catch (e) {
    console.warn("prayer: month refresh failed", e);
  }
}

export function savePrayerSettings(patch) {
  app.data.prayer = { ...prayer.prayerDefaults(), ...(app.data.prayer || {}), ...patch };
  lastPrayerMinute = ""; // re-evaluate on the next tick rather than waiting for the minute to turn
  save();
}

let tickHandle = null;
function startTick() {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    app.now = Date.now();
    if (timer.rolloverIfNeeded(app.data)) save();
    maybeNotifyLimit();
    maybeNotifyPrayer();
  }, 1000);
}

// ---------- Final Submit (Fillout auto-fill) ----------
// Always a full resync: the injected script clears whatever is already in
// the Fillout form for the day, then fills every local entry fresh. That
// makes re-running Final Submit (e.g. after closing the Fillout window
// mid-fill) safe and idempotent, instead of relying on partial "pending"
// tracking that could drift from what's actually in the form.
export async function submitToFillout(date) {
  const list = timer.entriesFor(app.data, date);
  if (!list.length) {
    app.fill = { running: false, added: 0, message: "", error: "No entries to submit for this day." };
    return;
  }
  timer.pauseTimer(app.data); // finalize times before building the payload
  save();
  // Checked on raw elapsed seconds, not a minute-rounded hh:mm display —
  // Timer.svelte's confirm-dialog check (finalSubmit) already blocks before
  // this is reached, but re-check here too since this is the actual trust
  // boundary for anything that writes to Fillout.
  const under1min = list.filter((e) => timer.elapsedSec(app.data, e) < 60);
  if (under1min.length) {
    app.fill = { running: false, added: 0, message: "", error: `${under1min.length} entr${under1min.length === 1 ? "y" : "ies"} have under 1 minute tracked — set a real time before submitting.` };
    return;
  }
  const payload = list.map((e) => ({
    id: e.id,
    project: e.project,
    category: e.category,
    description: e.description,
    hhmm: secToHHMM(e.accSec || 0),
  }));
  // Android/mobile is single-window, so the desktop auto-fill window (a second
  // webview) can't run. Instead submit straight to Fillout's HTTP API — no
  // browser needed. Desktop keeps the webview automation (lets the human
  // review before the real Submit); mobile trusts the local data.
  if (isMobile()) {
    app.fill = { running: true, added: 0, message: "Submitting to Fillout…", error: "", date };
    try {
      const n = await submitHeadless(app.data.name, date, payload);
      timer.markSubmitted(app.data, date, payload.map((p) => p.id));
      markDaySubmitted(date, "auto"); //* snapshots and syncs on its own now
      save();
      app.fill = { running: false, added: n, error: "", message: `Submitted ${n} entr${n === 1 ? "y" : "ies"} to Fillout ✓`, date };
    } catch (e) {
      app.fill = { running: false, added: 0, message: "", error: `Submit failed: ${e.message || e}`, date };
    }
    return;
  }
  app.fill = { running: true, added: 0, message: "Opening Fillout…", error: "", date };
  const url = `${FORM_URL}?name=${encodeURIComponent(app.data.name)}`;
  await invoke("open_fillout", { url, script: buildFillScript(payload, app.data.name, date) });
}

function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function listenForFillStatus() {
  listen("fill-status", (event) => {
    let s;
    try {
      s = JSON.parse(event.payload);
    } catch {
      return;
    }
    const date = app.fill.date;
    if (s.addedIds && s.addedIds.length && date) {
      timer.markSubmitted(app.data, date, s.addedIds);
      save();
    }
    if (s.submittedConfirmed) {
      // A real form submission was detected after filling.
      if (date) markDaySubmitted(date, "auto");
      app.fill = { ...app.fill, running: false, error: "", message: "Submission detected — recorded for this day ✓" };
      return;
    }
    if (s.error) {
      app.fill = { ...app.fill, running: false, added: s.added || 0, message: "", error: `Stopped: ${s.error} (${s.added || 0} added)` };
    } else if (s.done) {
      // Dated snapshot right when entries got marked submitted — skip if this
      // run added nothing new (e.g. re-clicking with everything already sent).
      if (s.added > 0) gdBackupNow().catch(() => {});
      const base = `Done — ${s.added} entr${s.added === 1 ? "y" : "ies"} added. Review the Fillout window, then click its Submit yourself.`;
      app.fill = {
        ...app.fill, running: false, added: s.added || 0,
        error: s.warning ? `${s.warning} (${s.added || 0} added)` : "",
        message: s.warning ? "" : base,
      };
    } else if (s.phase === "waiting-for-form") {
      app.fill = { ...app.fill, message: "Form loading…" };
    } else if (s.phase === "name-selected") {
      app.fill = { ...app.fill, message: "Name selected…" };
    } else if (s.phase === "date-selected") {
      app.fill = { ...app.fill, message: "Date set…" };
    } else if (s.phase === "clearing-entries") {
      app.fill = { ...app.fill, message: "Clearing existing entries…" };
    } else if (s.phase === "progress") {
      app.fill = { ...app.fill, added: s.added, message: `Added ${s.added}…` };
    }
  });
}
