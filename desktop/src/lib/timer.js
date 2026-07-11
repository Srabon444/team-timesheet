// Timer engine — ported from the Chrome extension's popup.js. Same rules:
// pure timestamp math (survives app restarts), exactly one active timer,
// starting one folds the running one's elapsed time into its accSec first.
//
// All functions operate on the plain data object:
//   { days: { date: [entry] }, timer: { activeId, startedAt, date }, ... }
// Persistence is the caller's (store's) job.
import { todayStr, hhmmToSec } from "./time.js";

export function entriesFor(data, date) {
  return data.days[date] || [];
}

function findEntry(data, date, id) {
  return entriesFor(data, date).find((e) => e.id === id);
}

export function elapsedSec(data, entry) {
  let s = entry.accSec || 0;
  if (data.timer.activeId === entry.id && data.timer.startedAt) {
    s += (Date.now() - data.timer.startedAt) / 1000;
  }
  return s;
}

// Fold the running timer's live elapsed time into its entry, then stop.
// The entry lives on the day the timer was started (timer.date), so a fold
// that happens after midnight still credits the right day.
export function foldActive(data) {
  const { activeId, startedAt, date } = data.timer;
  if (activeId && startedAt) {
    const e = findEntry(data, date, activeId);
    if (e) e.accSec = (e.accSec || 0) + (Date.now() - startedAt) / 1000;
  }
  data.timer = { activeId: null, startedAt: null, date: null };
}

export function startTimer(data, date, id) {
  foldActive(data); // stops any other running timer
  data.timer = { activeId: id, startedAt: Date.now(), date };
}

export function pauseTimer(data) {
  foldActive(data);
}

export function editTime(data, date, id, hhmm) {
  const e = findEntry(data, date, id);
  if (!e) return;
  e.accSec = hhmmToSec(hhmm);
  if (data.timer.activeId === id) data.timer.startedAt = Date.now(); // rebase running timer
}

// Called periodically: if the running timer was started on a previous day,
// fold it into that day's entry and stop — a timer never silently bleeds
// across midnight into the new day's totals.
export function rolloverIfNeeded(data) {
  if (data.timer.activeId && data.timer.date && data.timer.date !== todayStr()) {
    foldActive(data);
    return true;
  }
  return false;
}

export function addEntry(data, date, { project, category, description }) {
  const entry = {
    id: crypto.randomUUID(),
    project,
    category,
    description,
    accSec: 0,
    submitted: false,
  };
  if (!data.days[date]) data.days[date] = [];
  data.days[date].push(entry);
  data.lastProject = project;
  data.lastCategory = category;
  return entry;
}

export function updateEntry(data, date, id, { project, category, description }) {
  const e = findEntry(data, date, id);
  if (!e) return null;
  e.project = project;
  e.category = category;
  e.description = description; // accSec and submitted are untouched
  data.lastProject = project;
  data.lastCategory = category;
  return e;
}

export function deleteEntry(data, date, id) {
  if (data.timer.activeId === id) data.timer = { activeId: null, startedAt: null, date: null };
  if (data.days[date]) data.days[date] = data.days[date].filter((e) => e.id !== id);
}

// Entries not yet auto-filled into the form — a second Final Submit must
// only send what's new (ported no-duplicate rule from the extension).
export function pendingEntries(data, date) {
  return entriesFor(data, date).filter((e) => !e.submitted);
}

export function markSubmitted(data, date, ids) {
  for (const id of ids) {
    const e = findEntry(data, date, id);
    if (e) e.submitted = true;
  }
}
