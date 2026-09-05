"use strict";
// Prayer-time reminders. Times come from the Aladhan API a whole month at a time and are cached,
// so the notification path never touches the network — it works offline and can't be broken by a
// flaky connection mid-day.
//
// Plain-script globals to match popup.js/gdrive.js; the pure helpers are also importScripts()'d
// by background.js, which is what actually fires the notifications.

const PRAYER_API = "https://api.aladhan.com/v1";
//* The five obligatory prayers only. The API also returns Sunrise/Imsak/Midnight/Firstthird —
//* none of those are prayers and none should raise a notification.
const PRAYER_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

function prayerDefaults() {
  return {
    enabled: false,
    city: "",
    country: "",
    method: 1, //* University of Islamic Sciences, Karachi
    school: 1, //! 1 = Hanafi Asr. 0 shifts Asr roughly an hour earlier — not a cosmetic setting.
    tz: "",
    month: "", // "YYYY-M" of the cached calendar
    days: {}, // "YYYY-MM-DD" -> { Fajr: "04:23", ... }
    notified: {}, // "YYYY-MM-DD" -> ["Fajr", ...]
    reminderIndex: 0,
  };
}

// ---------- pure helpers (no chrome, no fetch — background.js and the tests both use these) ----

//! Aladhan returns "04:23 (+06)", not "04:23".
function prayerStripOffset(t) {
  return String(t || "").trim().split(" ")[0];
}

function prayerToMinutes(hhmm) {
  const [h, m] = prayerStripOffset(hhmm).split(":").map((n) => parseInt(n, 10));
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

// Keep only the five prayers, offsets stripped.
function prayerPickFive(timings) {
  const out = {};
  for (const name of PRAYER_NAMES) {
    const v = prayerStripOffset((timings || {})[name]);
    if (v) out[name] = v;
  }
  return out;
}

// Aladhan's calendar array -> { "YYYY-MM-DD": { Fajr: "04:23", ... } }. Its own date field is
// DD-MM-YYYY, which is flipped here so the keys sort and match the app's date strings.
function prayerIndexCalendar(days) {
  const out = {};
  for (const d of days || []) {
    const raw = d && d.date && d.date.gregorian && d.date.gregorian.date;
    if (!raw) continue;
    const [dd, mm, yyyy] = String(raw).split("-");
    if (!yyyy) continue;
    out[`${yyyy}-${mm}-${dd}`] = prayerPickFive(d.timings);
  }
  return out;
}

// Prayers whose time has passed today but that haven't been announced yet.
//! Bounded by `graceMin`: a laptop woken at 22:00 should not fire five notifications at once for
//! prayers that passed hours ago. Anything older than the grace window is marked seen silently.
function prayerDue(times, nowMin, alreadyNotified, graceMin = 30) {
  const seen = new Set(alreadyNotified || []);
  const due = [];
  const stale = [];
  for (const name of PRAYER_NAMES) {
    const at = prayerToMinutes((times || {})[name]);
    if (at === null || seen.has(name) || nowMin < at) continue;
    (nowMin - at <= graceMin ? due : stale).push(name);
  }
  return { due, stale };
}

// The next prayer still to come today, for the little status line in the UI.
function prayerNext(times, nowMin) {
  for (const name of PRAYER_NAMES) {
    const at = prayerToMinutes((times || {})[name]);
    if (at !== null && at > nowMin) return { name, at, inMin: at - nowMin };
  }
  return null;
}

function prayerNotificationText(name, reminder) {
  return {
    title: `${name} — time to pray`,
    message: reminder ? `${reminder.text}\n— ${reminder.source}` : "",
  };
}

// Drop cached days and notification marks from other months so storage can't creep upward.
function prayerPruneToMonth(map, monthPrefix) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (k.startsWith(monthPrefix)) out[k] = v;
  }
  return out;
}

// ---------- network + storage (popup/tab only; background.js never fetches) ----------

function prayerMonthKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

//* Zero-padded, so it prefix-matches the "YYYY-MM-DD" keys the caches are keyed by.
function prayerMonthPrefix(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

//! An unknown city does NOT error — Aladhan answers 200 with times for somewhere else entirely
//! ("Nowhereville, Nowhereland" resolves to America/Chicago). The caller must show the resolved
//! timezone to the user and compare it with the device's before saving anything.
async function prayerFetchMonth(city, country, method, school, when) {
  const d = when || new Date();
  const url =
    `${PRAYER_API}/calendarByCity/${d.getFullYear()}/${d.getMonth() + 1}` +
    `?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}` +
    `&method=${encodeURIComponent(method)}&school=${encodeURIComponent(school)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prayer times lookup failed (${res.status}).`);
  const body = await res.json();
  if (!body || body.code !== 200 || !Array.isArray(body.data) || !body.data.length) {
    throw new Error("Prayer times lookup returned nothing for that city.");
  }
  return {
    days: prayerIndexCalendar(body.data),
    tz: (body.data[0].meta && body.data[0].meta.timezone) || "",
    month: prayerMonthKey(d),
  };
}

function prayerDeviceTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (e) {
    return "";
  }
}

async function prayerLoad() {
  const { prayer } = await chrome.storage.local.get("prayer");
  return { ...prayerDefaults(), ...(prayer || {}) };
}

async function prayerSave(patch) {
  const next = { ...(await prayerLoad()), ...patch };
  await chrome.storage.local.set({ prayer: next });
  return next;
}

// Refresh the cache when the month rolls over. Silent by design: a failure leaves the old cache
// in place and the UI keeps showing what it has.
async function prayerEnsureMonth() {
  const p = await prayerLoad();
  if (!p.enabled || !p.city) return p;
  const key = prayerMonthKey(new Date());
  if (p.month === key && Object.keys(p.days || {}).length) return p;
  try {
    const fresh = await prayerFetchMonth(p.city, p.country, p.method, p.school);
    return await prayerSave({
      ...fresh,
      notified: prayerPruneToMonth(p.notified, prayerMonthPrefix(new Date())),
    });
  } catch (e) {
    console.warn("prayer: month refresh failed", e);
    return p;
  }
}
