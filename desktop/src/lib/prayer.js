// Prayer-time reminders. Times come from the Aladhan API a whole month at a time and are cached
// in app.data, so the notification path never touches the network — it works offline and can't be
// broken by a flaky connection mid-day.
//
// ES module twin of the extension's plain-script prayer.js; the logic is deliberately identical.

import { PRAYER_HEADINGS } from "./prayer-hadiths.js";

const PRAYER_API = "https://api.aladhan.com/v1";
//* The five obligatory prayers only. The API also returns Sunrise/Imsak/Midnight/Firstthird —
//* none of those are prayers and none should raise a notification.
export const PRAYER_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
//! Not prayers, and never notified — kept only because a waqt's END is one of these.
const PRAYER_BOUNDS = ["Sunrise", "Sunset", "Midnight"];

//! A waqt ends when the next one starts, EXCEPT Fajr (ends at sunrise, hours before Dhuhr) and
//! Isha (ends at Islamic midnight, not at the next Fajr). The API has no end field at all, so
//! every end is derived from one of the timings it does return.
const PRAYER_END_OF = { Fajr: "Sunrise", Dhuhr: "Asr", Asr: "Maghrib", Maghrib: "Isha", Isha: "Midnight" };
//? Fajr is treated as over 10 minutes before sunrise: praying right up to the edge risks the
//? sun breaking the horizon mid-prayer, which invalidates it. Tunable in one place.
const PRAYER_FAJR_MARGIN_MIN = 10;

export function prayerDefaults() {
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

//! Aladhan returns "04:23 (+06)", not "04:23".
export function stripOffset(t) {
  return String(t || "").trim().split(" ")[0];
}

export function toMinutes(hhmm) {
  const [h, m] = stripOffset(hhmm).split(":").map((n) => parseInt(n, 10));
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

// The five prayers plus the boundaries a waqt can end on, offsets stripped. Imsak/Firstthird/
// Lastthird are dropped — nothing needs them.
export function pickTimes(timings) {
  const out = {};
  for (const name of [...PRAYER_NAMES, ...PRAYER_BOUNDS]) {
    const v = stripOffset((timings || {})[name]);
    if (v) out[name] = v;
  }
  return out;
}

// Aladhan's calendar array -> { "YYYY-MM-DD": { Fajr: "04:23", ... } }. Its own date field is
// DD-MM-YYYY, which is flipped here so the keys match the app's own date strings.
export function indexCalendar(days) {
  const out = {};
  for (const d of days || []) {
    const raw = d?.date?.gregorian?.date;
    if (!raw) continue;
    const [dd, mm, yyyy] = String(raw).split("-");
    if (!yyyy) continue;
    out[`${yyyy}-${mm}-${dd}`] = pickTimes(d.timings);
  }
  return out;
}

// Prayers whose time has passed today but that haven't been announced yet.
//! Bounded by `graceMin`: a laptop woken at 22:00 should not fire five notifications at once for
//! prayers that passed hours ago. Anything older than the grace window is marked seen silently.
export function duePrayers(times, nowMin, alreadyNotified, graceMin = 30) {
  const seen = new Set(alreadyNotified || []);
  const due = [];
  const stale = [];
  for (const name of PRAYER_NAMES) {
    const at = toMinutes((times || {})[name]);
    if (at === null || seen.has(name) || nowMin < at) continue;
    (nowMin - at <= graceMin ? due : stale).push(name);
  }
  return { due, stale };
}

// The next prayer still to come today, for the little status line in the UI.
export function nextPrayer(times, nowMin) {
  for (const name of PRAYER_NAMES) {
    const at = toMinutes((times || {})[name]);
    if (at !== null && at > nowMin) return { name, at, inMin: at - nowMin };
  }
  return null;
}

// When a prayer's waqt is over, in minutes from midnight. null when the boundary it needs is
// missing from the cache (a day cached before boundaries were stored).
export function waqtEnd(times, name) {
  const startMin = toMinutes((times || {})[name]);
  let end = toMinutes((times || {})[PRAYER_END_OF[name]]);
  if (startMin === null || end === null) return null;
  if (name === "Fajr") end -= PRAYER_FAJR_MARGIN_MIN;
  //! Islamic midnight can land after 00:00 (midnightMode=JAFARI, or a high latitude), which reads
  //! as a smaller number than Isha's start. Push it into the next day so the compare still works.
  if (end <= startMin) end += 24 * 60;
  return end;
}

// The prayer whose waqt is running right now — started, and not yet expired. null in the gaps,
// which are real: nothing is due between sunrise and Dhuhr.
export function currentPrayer(times, nowMin) {
  for (const name of [...PRAYER_NAMES].reverse()) {
    const at = toMinutes((times || {})[name]);
    if (at === null || at > nowMin) continue;
    const endsAt = waqtEnd(times, name);
    //! An unknown end must not silently become "runs forever" — fall back to the next prayer's
    //! start, which is what this did before ends existed, and is right for Dhuhr/Asr/Maghrib.
    const fallback = nextPrayer(times, nowMin);
    const end = endsAt !== null ? endsAt : fallback && fallback.at;
    if (!end) return null;
    return nowMin < end ? { name, at, endsAt: end } : null;
  }
  return null;
}

// "15:27" -> "3:27 PM"
export function fmt12(hhmm) {
  const m = toMinutes(hhmm);
  if (m === null) return "";
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function fmtLeft(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m}min`;
  return m ? `${h}hr ${m}min` : `${h}hr`;
}

// "Dhuhr 2hr 34min remaining, Asr: 3:27 PM".
//! Either half is dropped when it doesn't exist — before Fajr there is no current prayer, after
//! Isha there is no next one — and the comma goes with the half it separated.
export function statusLine(times, nowMin) {
  const cur = currentPrayer(times, nowMin);
  const next = nextPrayer(times, nowMin);
  const parts = [];
  if (cur) parts.push(`${cur.name} ${fmtLeft(cur.endsAt - nowMin)} remaining`);
  if (next) parts.push(`${next.name}: ${fmt12(times[next.name])}`);
  return parts.join(", ");
}

//* Bengali headings; falls back to the API's own name so a missing one can't read "undefined".
export function notificationText(name, reminder) {
  return {
    title: PRAYER_HEADINGS[name] || name,
    body: reminder ? `${reminder.text}\n— ${reminder.source}` : "",
  };
}

// Drop cached days and notification marks from other months so storage can't creep upward.
export function pruneToMonth(map, monthPrefix) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (k.startsWith(monthPrefix)) out[k] = v;
  }
  return out;
}

export function monthKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

//* Zero-padded, so it prefix-matches the "YYYY-MM-DD" keys the caches are keyed by.
export function monthPrefix(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function dayKey(d) {
  return `${monthPrefix(d)}-${String(d.getDate()).padStart(2, "0")}`;
}

export function deviceTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

//! An unknown city does NOT error — Aladhan answers 200 with times for somewhere else entirely
//! ("Nowhereville, Nowhereland" resolves to America/Chicago). The caller must show the resolved
//! timezone to the user and compare it with the device's before saving anything.
//? Fetched straight from the webview rather than through Rust like the Drive calls: Aladhan sends
//? access-control-allow-origin *, and the app sets no CSP, so there is nothing to proxy around.
export async function fetchMonth(city, country, method, school, when) {
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
    days: indexCalendar(body.data),
    tz: body.data[0]?.meta?.timezone || "",
    month: monthKey(d),
  };
}
