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
import * as prayer from "./prayer.js";
import { prayerReminderAt } from "./prayer-hadiths.js";

function defaults() {
  return {
    days: {},
    submittedDays: {}, // { date: { at: ts, method: "auto"|"manual" } } — show-only
    deletedEntries: {}, // { entryId: deletedAtMs } — tombstones so sync merge doesn't resurrect a deleted entry
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

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_data", { json: JSON.stringify(app.data) }).catch(() => {});
  }, 150);
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
  try {
    const json = await invoke("load_data");
    const stored = JSON.parse(json || "{}");
    app.data = { ...defaults(), ...stored };
    app.data.timer = { activeId: null, startedAt: null, date: null, ...(stored.timer || {}) };
  } catch {
    app.data = defaults();
  }
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
export function startEntryTimer(date, id) {
  timer.startTimer(app.data, date, id);
  save();
}
export function pauseEntryTimer() {
  timer.pauseTimer(app.data);
  save();
}
export function setEntryTime(date, id, hhmm) {
  timer.editTime(app.data, date, id, hhmm);
  save();
}
export function addEntry(date, fields) {
  const e = timer.addEntry(app.data, date, fields);
  save();
  return e;
}
export function updateEntry(date, id, fields) {
  const e = timer.updateEntry(app.data, date, id, fields);
  save();
  return e;
}
export function removeEntry(date, id) {
  timer.deleteEntry(app.data, date, id);
  // Tombstone it — otherwise a sync merge would resurrect this entry from
  // another device that's still holding an older, pre-delete copy.
  app.data.deletedEntries = app.data.deletedEntries || {};
  app.data.deletedEntries[id] = Date.now();
  save();
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
  if (!app.data.submittedDays) app.data.submittedDays = {};
  app.data.submittedDays[date] = { at: Date.now(), method };
  save();
  //* No direct ingest call here: gdSyncNow() pushes every submitted day it knows about, using the
  //* merged (and correctly folded) entries. Pushing here too just sent the same day twice.
  await gdSyncNow();
  gdBackupNow(false).catch(() => {}); // dated snapshot of the moment this day was marked, best-effort
  if (method === "manual") await nudgeGoogleSignIn();
}
//! Unmark writes an explicit null, never deletes the key. The Drive merge is a spread
//! ({...drive, ...local}), so an absent key lost to Drive's copy and the day came back marked.
export async function unmarkDaySubmitted(date) {
  if (!app.data.submittedDays) app.data.submittedDays = {};
  app.data.submittedDays[date] = null;
  save();
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
  return app.data.submittedDays ? app.data.submittedDays[date] : null;
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
  const { due, stale } = prayer.duePrayers(times, now.getHours() * 60 + now.getMinutes(), doneToday);
  if (!due.length && !stale.length) return;

  let index = p.reminderIndex || 0;
  if (due.length) {
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) {
        for (const name of due) sendNotification(prayer.notificationText(name, prayerReminderAt(index++)));
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
    notified: { ...(p.notified || {}), [key]: [...doneToday, ...due, ...stale] },
    reminderIndex: index,
  };
  save();
}

// Refresh the cached month when it rolls over. Silent: a failure leaves the old cache in place.
export async function ensurePrayerMonth() {
  const p = app.data.prayer;
  if (!p || !p.enabled || !p.city) return;
  const key = prayer.monthKey(new Date());
  if (p.month === key && Object.keys(p.days || {}).length) return;
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
