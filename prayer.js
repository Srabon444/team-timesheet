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

// The five prayers plus the boundaries a waqt can end on, offsets stripped. Imsak/Firstthird/
// Lastthird are dropped — nothing needs them.
function prayerPickTimes(timings) {
  const out = {};
  for (const name of [...PRAYER_NAMES, ...PRAYER_BOUNDS]) {
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
    out[`${yyyy}-${mm}-${dd}`] = prayerPickTimes(d.timings);
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

// When a prayer's waqt is over, in minutes from midnight. null when the boundary it needs is
// missing from the cache (a day cached before boundaries were stored).
function prayerWaqtEnd(times, name) {
  const startMin = prayerToMinutes((times || {})[name]);
  let end = prayerToMinutes((times || {})[PRAYER_END_OF[name]]);
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
function prayerAsrMakruhStart(times) {
  const m = prayerToMinutes((times || {}).Maghrib);
  return m === null ? null : m - ASR_MAKRUH_BEFORE_MAGHRIB_MIN;
}

// The prayer whose waqt is running right now — started, and not yet expired. null in the gaps,
// which are real: nothing is due between sunrise and Dhuhr.
function prayerCurrent(times, nowMin) {
  for (const name of [...PRAYER_NAMES].reverse()) {
    const at = prayerToMinutes((times || {})[name]);
    if (at === null || at > nowMin) continue;
    const endsAt = prayerWaqtEnd(times, name);
    //! An unknown end must not silently become "runs forever" — fall back to the next prayer's
    //! start, which is what this did before ends existed, and is right for Dhuhr/Asr/Maghrib.
    const fallback = prayerNext(times, nowMin);
    const end = endsAt !== null ? endsAt : fallback && fallback.at;
    if (!end) return null;
    if (nowMin >= end) return null;
    const makruhAt = name === "Asr" ? prayerAsrMakruhStart(times) : null;
    return { name, at, endsAt: end, makruh: makruhAt !== null && nowMin >= makruhAt };
  }
  return null;
}

// "15:27" -> "3:27 PM"
function prayerFmt12(hhmm) {
  const m = prayerToMinutes(hhmm);
  if (m === null) return "";
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function prayerFmtLeft(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m}min`;
  return m ? `${h}hr ${m}min` : `${h}hr`;
}

// "Dhuhr 2hr 34min remaining, Asr: 3:27 PM".
//! Either half is dropped when it doesn't exist — before Fajr there is no current prayer, after
//! Isha there is no next one — and the comma goes with the half it separated.
function prayerStatusLine(times, nowMin) {
  const cur = prayerCurrent(times, nowMin);
  const next = prayerNext(times, nowMin);
  const parts = [];
  if (cur) parts.push(`${cur.name} ${prayerFmtLeft(cur.endsAt - nowMin)} remaining${cur.makruh ? " (makruh)" : ""}`);
  if (next) parts.push(`${next.name}: ${prayerFmt12(times[next.name])}`);
  return parts.join(", ");
}

// Warnings that a running waqt is about to expire, one per lead in PRAYER_WARN_LEADS_MIN.
//! Marks are "Asr:30", never "Asr", so they can share the day's notified list with the start
//! notifications without either silencing the other.
//! Bounded like prayerDue: a warning that sat unfired past the grace window, or past the end
//! itself, is recorded silently rather than arriving as a burst after a wake-up.
function prayerEndingWarnings(times, nowMin, alreadyNotified, graceMin = 10) {
  const seen = new Set(alreadyNotified || []);
  const due = [];
  const stale = [];
  for (const name of PRAYER_NAMES) {
    const at = prayerToMinutes((times || {})[name]);
    const end = prayerWaqtEnd(times, name);
    if (at === null || end === null || nowMin < at) continue; // not started — nothing to warn about
    for (const lead of PRAYER_WARN_LEADS_MIN) {
      const mark = `${name}:${lead}`;
      const warnAt = end - lead;
      if (seen.has(mark) || nowMin < warnAt) continue;
      if (nowMin < end && nowMin - warnAt <= graceMin) {
        //! The real minutes left, not the lead: a warning that fires a few minutes late must not
        //! claim 30 when 24 are left.
        const makruhAt = name === "Asr" ? prayerAsrMakruhStart(times) : null;
        due.push({ name, mark, leftMin: end - nowMin, makruh: makruhAt !== null && nowMin >= makruhAt });
      } else {
        stale.push(mark);
      }
    }
  }
  return { due, stale };
}

//* Bengali, from prayer-hadiths.js. Falls back to the API's own name if a heading is ever
//* missing, so an unmapped prayer still notifies rather than saying "undefined".
function prayerNotificationText(name, reminder) {
  const headings = typeof PRAYER_HEADINGS === "object" ? PRAYER_HEADINGS : {};
  return {
    title: headings[name] || name,
    message: reminder ? `${reminder.text}\n— ${reminder.source}` : "",
  };
}

//* Bengali, from prayer-hadiths.js. Carries no hadith: a "hurry up" alert should be one glance.
function prayerEndingText(warning) {
  const headings = typeof PRAYER_ENDING_HEADINGS === "object" ? PRAYER_ENDING_HEADINGS : {};
  const left = typeof prayerBnDigits === "function" ? prayerBnDigits(warning.leftMin) : warning.leftMin;
  return {
    title: headings[warning.name] || warning.name,
    message: `আর ${left} মিনিট বাকি${warning.makruh ? "\nএখন মাকরুহ ওয়াক্ত চলছে" : ""}`,
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

//* Zero-padded "YYYY-MM-DD", matching the day keys the caches use.
function prayerDayKey(d) {
  return `${prayerMonthPrefix(d)}-${String(d.getDate()).padStart(2, "0")}`;
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
  //! A day cached before the boundary timings were stored cannot tell when a waqt ends, so a
  //! missing Sunrise forces a refetch rather than waiting for the month to roll over.
  const cached = (p.days || {})[prayerDayKey(new Date())];
  if (p.month === key && Object.keys(p.days || {}).length && (!cached || cached.Sunrise)) return p;
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
