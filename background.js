"use strict";
// Keeps the toolbar badge reflecting timer state even when the popup is
// closed. Event-driven (storage.onChanged) for start/stop; chrome.alarms
// (min 1min granularity, survives service-worker suspension) ticks the
// elapsed-time display while a timer runs. Also fires a once-per-day OS
// notification when today's tracked time crosses the configured limit.

const ALARM = "tick";
const pad = (n) => String(n).padStart(2, "0");

function idle() {
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
  chrome.action.setTitle({ title: "Daily Timesheet — no timer running" });
}

async function running() {
  const { timer, entries } = await chrome.storage.local.get(["timer", "entries"]);
  if (!timer || !timer.activeId) return idle();
  const entry = (entries || []).find((e) => e.id === timer.activeId);
  const sec = Math.floor((entry ? entry.accSec || 0 : 0) + (Date.now() - timer.startedAt) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  // ponytail: whole-hour precision once >=1h, exact minutes under an hour — badge is ~4 chars max
  chrome.action.setBadgeText({ text: h >= 1 ? `${h}h` : `${m}m` });
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  const hhmmss = `${pad(h)}:${pad(m)}:${pad(sec % 60)}`;
  chrome.action.setTitle({ title: `Running: ${entry ? entry.project : "?"} — ${hhmmss}` });
}

async function syncBadge() {
  const { timer } = await chrome.storage.local.get("timer");
  if (timer && timer.activeId) {
    chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    await running();
  } else {
    chrome.alarms.clear(ALARM);
    idle();
  }
}

async function checkDailyLimit() {
  const { entries, timer, dailyLimitHours, warnedDate, date } = await chrome.storage.local.get(
    ["entries", "timer", "dailyLimitHours", "warnedDate", "date"]
  );
  if (!dailyLimitHours) return; // not configured yet
  let totalSec = (entries || []).reduce((sum, e) => sum + (e.accSec || 0), 0);
  if (timer && timer.activeId && timer.startedAt) {
    totalSec += (Date.now() - timer.startedAt) / 1000;
  }
  if (totalSec >= dailyLimitHours * 3600 && warnedDate !== date) {
    chrome.notifications.create("daily-limit", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Daily limit reached",
      message: `You've tracked ${dailyLimitHours}+ hour(s) today.`,
    });
    await chrome.storage.local.set({ warnedDate: date });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.timer) syncBadge();
  if (changes.timer || changes.entries) checkDailyLimit();
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) running(); });
chrome.runtime.onInstalled.addListener(() => { syncBadge(); checkDailyLimit(); });
chrome.runtime.onStartup.addListener(() => { syncBadge(); checkDailyLimit(); });
syncBadge(); // service worker (re)start while a timer was already running
