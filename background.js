"use strict";
// Keeps the toolbar badge reflecting timer state even when the popup is
// closed. Event-driven (storage.onChanged) for start/stop; chrome.alarms
// (min 1min granularity, survives service-worker suspension) ticks the
// elapsed-time display while a timer runs. Also fires a once-per-day OS
// notification when today's tracked time crosses the configured limit.

//* Pure helpers + the reminder texts; prayer.js's networked half is never called from here —
//* the service worker only reads the month cache the popup already fetched.
importScripts("prayer.js", "prayer-hadiths.js");

const ALARM = "tick";
const PRAYER_ALARM = "prayerTick";
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

// ---------- prayer reminders ----------
//! Notifications have to fire with the popup closed, so they live here, not in popup.js. The
//! alarm is the only thing that wakes a suspended MV3 worker on a schedule.
async function syncPrayerAlarm() {
  const { prayer } = await chrome.storage.local.get("prayer");
  if (prayer && prayer.enabled && prayer.city) {
    chrome.alarms.create(PRAYER_ALARM, { periodInMinutes: 1 });
  } else {
    chrome.alarms.clear(PRAYER_ALARM);
  }
}

async function checkPrayerTimes() {
  const { prayer } = await chrome.storage.local.get("prayer");
  if (!prayer || !prayer.enabled) return;
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const key = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const times = (prayer.days || {})[key];
  if (!times) return; // month cache missing or stale — the popup refreshes it, not us

  const notified = { ...(prayer.notified || {}) };
  const doneToday = notified[key] || [];
  const { due, stale } = prayerDue(times, now.getHours() * 60 + now.getMinutes(), doneToday);
  if (!due.length && !stale.length) return;

  let index = prayer.reminderIndex || 0;
  for (const name of due) {
    const { title, message } = prayerNotificationText(name, prayerReminderAt(index++));
    chrome.notifications.create(`prayer-${key}-${name}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  }
  //* Stale ones are recorded without a notification, so a machine that was asleep doesn't get a
  //* burst of catch-up alerts the moment it wakes.
  notified[key] = [...doneToday, ...due, ...stale];
  await chrome.storage.local.set({ prayer: { ...prayer, notified, reminderIndex: index } });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.timer) syncBadge();
  if (changes.timer || changes.entries) checkDailyLimit();
  //! Only react to enabled/city flipping — checkPrayerTimes writes `prayer` itself, and
  //! re-running on its own write would loop.
  if (changes.prayer) {
    const before = changes.prayer.oldValue || {};
    const after = changes.prayer.newValue || {};
    if (before.enabled !== after.enabled || before.city !== after.city) syncPrayerAlarm();
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRAYER_ALARM) return void checkPrayerTimes();
  if (alarm.name !== ALARM) return;
  running();
  // A running timer crosses the limit without any storage write happening
  // at that exact moment — re-check on every 1-minute tick too, so it's
  // caught within a minute of actually crossing, not just next time
  // something else (e.g. pausing) happens to touch storage.
  checkDailyLimit();
});
chrome.runtime.onInstalled.addListener(() => { syncBadge(); checkDailyLimit(); syncPrayerAlarm(); });
chrome.runtime.onStartup.addListener(() => { syncBadge(); checkDailyLimit(); syncPrayerAlarm(); });
syncBadge(); // service worker (re)start while a timer was already running
syncPrayerAlarm();
