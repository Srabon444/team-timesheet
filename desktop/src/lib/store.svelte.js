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
import { FORM_URL } from "./constants.js";
import { todayStr, secToHHMM } from "./time.js";
import { dayTotal } from "./stats.js";
import * as timer from "./timer.js";
import { parseNames } from "./names.js";
import { buildFillScript } from "./fillout-inject.js";

function defaults() {
  return {
    days: {},
    submittedDays: {}, // { date: { at: ts, method: "auto"|"manual" } } — show-only
    timer: { activeId: null, startedAt: null, date: null },
    name: "",
    names: [],
    lastProject: null,
    lastCategory: null,
    dailyLimitHours: 8,
    warnedDate: null,
    confirmBeforeDelete: true,
    theme: "dark",
  };
}

export const app = $state({
  data: defaults(),
  loaded: false,
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

// ---------- submission status (Task 7: show-only, disables nothing) ----------
export function markDaySubmitted(date, method = "manual") {
  if (!app.data.submittedDays) app.data.submittedDays = {};
  app.data.submittedDays[date] = { at: Date.now(), method };
  save();
}
export function unmarkDaySubmitted(date) {
  if (app.data.submittedDays) delete app.data.submittedDays[date];
  save();
}
export function daySubmitted(date) {
  return app.data.submittedDays ? app.data.submittedDays[date] : null;
}

// ---------- confirm modal (promise-based, per-action labels) ----------
// showConfirm: yes/cancel, resolves boolean. showChoice: adds a middle "alt"
// button, resolves "yes" | "alt" | "cancel" (e.g. sync conflict: keep this
// device / pull from Drive / cancel).
export function showConfirm(message, yesLabel = "Yes") {
  return new Promise((resolve) => {
    app.confirm = { message, yesLabel, resolve: (r) => resolve(r === "yes") };
  });
}
export function showChoice(message, yesLabel, altLabel) {
  return new Promise((resolve) => {
    app.confirm = { message, yesLabel, altLabel, resolve };
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

let tickHandle = null;
function startTick() {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    app.now = Date.now();
    if (timer.rolloverIfNeeded(app.data)) save();
    maybeNotifyLimit();
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
      markDaySubmitted(date, "auto");
      save();
      app.fill = { running: false, added: n, error: "", message: `Submitted ${n} entr${n === 1 ? "y" : "ies"} to Fillout ✓`, date };
    } catch (e) {
      app.fill = { running: false, added: 0, message: "", error: `Submit failed: ${e.message || e}`, date };
    }
    return;
  }
  app.fill = { running: true, added: 0, message: "Opening Fillout…", error: "", date };
  const url = `${FORM_URL}?name=${encodeURIComponent(app.data.name)}`;
  await invoke("open_fillout", { url, script: buildFillScript(payload, app.data.name) });
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
    } else if (s.phase === "clearing-entries") {
      app.fill = { ...app.fill, message: "Clearing existing entries…" };
    } else if (s.phase === "progress") {
      app.fill = { ...app.fill, added: s.added, message: `Added ${s.added}…` };
    }
  });
}
