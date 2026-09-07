// Prayer-time reminders. Times come from the Aladhan API a whole month at a time and are cached
// in app.data, so the notification path never touches the network — it works offline and can't be
// broken by a flaky connection mid-day.
//
// ES module twin of the extension's plain-script prayer.js; the logic is deliberately identical.

import { PRAYER_HEADINGS, PRAYER_ENDING_HEADINGS, bnDigits } from "./prayer-hadiths.js";

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
//? Cut short of the boundary on purpose: praying right up to the edge risks the sun crossing the
//? horizon mid-prayer, which invalidates it. Fajr against sunrise, Asr against sunset.
const PRAYER_END_MARGIN_MIN = { Fajr: 10, Asr: 10 };
//! Makruh (isfirar) is not in the API and has no single agreed minute — this is the common
//! "sun visibly yellowing" convention, kept as one tunable number rather than a solar calculation.
const ASR_MAKRUH_BEFORE_MAGHRIB_MIN = 20;
//* Two nudges before a waqt runs out.
const PRAYER_WARN_LEADS_MIN = [30, 15];

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
  end -= PRAYER_END_MARGIN_MIN[name] || 0;
  if (end <= startMin) {
    //! Only Isha's end legitimately crosses midnight (midnightMode=JAFARI, or a high latitude),
    //! where it reads as a smaller number than Isha's start — push it into the next day.
    //! For any other prayer that ordering means degenerate data (a polar sunrise minutes after
    //! Fajr); a null "unknown" is far safer there than a waqt that appears to run 24 hours.
    if (name !== "Isha") return null;
    end += 24 * 60;
  }
  return end;
}

// When Asr turns makruh — still valid, but discouraged. null when Maghrib is not cached.
export function asrMakruhStart(times) {
  const m = toMinutes((times || {}).Maghrib);
  return m === null ? null : m - ASR_MAKRUH_BEFORE_MAGHRIB_MIN;
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
    if (nowMin >= end) return null;
    const makruhAt = name === "Asr" ? asrMakruhStart(times) : null;
    return { name, at, endsAt: end, makruh: makruhAt !== null && nowMin >= makruhAt };
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
  if (cur) parts.push(`${cur.name} ${fmtLeft(cur.endsAt - nowMin)} remaining${cur.makruh ? " (makruh)" : ""}`);
  if (next) parts.push(`${next.name}: ${fmt12(times[next.name])}`);
  return parts.join(", ");
}

// Warnings that a running waqt is about to expire, one per lead in PRAYER_WARN_LEADS_MIN.
//! Marks are "Asr:30", never "Asr", so they can share the day's notified list with the start
//! notifications without either silencing the other.
//! Bounded like duePrayers: a warning that sat unfired past the grace window, or past the end
//! itself, is recorded silently rather than arriving as a burst after a wake-up.
export function endingWarnings(times, nowMin, alreadyNotified, graceMin = 10) {
  const seen = new Set(alreadyNotified || []);
  const due = [];
  const stale = [];
  for (const name of PRAYER_NAMES) {
    const at = toMinutes((times || {})[name]);
    const end = waqtEnd(times, name);
    if (at === null || end === null || nowMin < at) continue; // not started — nothing to warn about
    for (const lead of PRAYER_WARN_LEADS_MIN) {
      const mark = `${name}:${lead}`;
      const warnAt = end - lead;
      if (seen.has(mark) || nowMin < warnAt) continue;
      if (nowMin < end && nowMin - warnAt <= graceMin) {
        //! The real minutes left, not the lead: a warning that fires a few minutes late must not
        //! claim 30 when 24 are left.
        const makruhAt = name === "Asr" ? asrMakruhStart(times) : null;
        due.push({ name, mark, leftMin: end - nowMin, makruh: makruhAt !== null && nowMin >= makruhAt });
      } else {
        stale.push(mark);
      }
    }
  }
  return { due, stale };
}

//* Bengali headings; falls back to the API's own name so a missing one can't read "undefined".
export function notificationText(name, reminder) {
  return {
    title: PRAYER_HEADINGS[name] || name,
    body: reminder ? `${reminder.text}\n— ${reminder.source}` : "",
  };
}

//* Bengali. Carries no hadith: a "hurry up" alert should be one glance.
export function endingText(warning) {
  return {
    title: PRAYER_ENDING_HEADINGS[warning.name] || warning.name,
    body: `আর ${bnDigits(warning.leftMin)} মিনিট বাকি${warning.makruh ? "\nএখন মাকরুহ ওয়াক্ত চলছে" : ""}`,
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
