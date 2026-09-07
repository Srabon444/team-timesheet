// Scheduling logic for the prayer reminders. The failures worth guarding are silent ones: a
// notification that never fires, one that fires twice, or a burst of catch-up alerts after the
// machine wakes up.
import { describe, it, expect } from "vitest";
import {
  pickTimes, toMinutes, duePrayers, nextPrayer, currentPrayer, waqtEnd, indexCalendar,
  pruneToMonth, notificationText, dayKey, monthPrefix, statusLine,
} from "../src/lib/prayer.js";
import { prayerReminderAt, PRAYER_REMINDERS, PRAYER_HEADINGS } from "../src/lib/prayer-hadiths.js";

const raw = {
  Fajr: "04:23 (+06)", Sunrise: "05:40 (+06)", Dhuhr: "11:58 (+06)", Asr: "15:27 (+06)",
  Sunset: "18:17 (+06)", Maghrib: "18:17 (+06)", Isha: "19:34 (+06)", Imsak: "04:13 (+06)",
  Midnight: "23:58 (+06)",
};
const five = pickTimes(raw);

describe("pickTimes", () => {
  it("keeps the five prayers plus the boundaries a waqt ends on", () => {
    expect(Object.keys(five)).toEqual(["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha", "Sunrise", "Sunset", "Midnight"]);
  });

  it("strips the API's timezone suffix", () => {
    expect(five.Fajr).toBe("04:23");
  });

  it("drops the timings nothing needs", () => {
    expect(five.Imsak).toBeUndefined();
    expect(five.Firstthird).toBeUndefined();
  });

  //! The boundaries are stored now, so this has to be enforced where it matters instead.
  it("never notifies on a boundary — those are not prayers", () => {
    expect(duePrayers(five, 5 * 60 + 40, []).due).toEqual([]);   // Sunrise
    expect(duePrayers(five, 23 * 60 + 58, []).due).toEqual([]);  // Midnight
    expect(nextPrayer(five, 5 * 60).name).toBe("Dhuhr");         // not Sunrise
  });
});

describe("waqtEnd", () => {
  it("ends Fajr ten minutes before sunrise, not at Dhuhr", () => {
    expect(waqtEnd(five, "Fajr")).toBe(5 * 60 + 30); // sunrise 05:40
  });

  it("ends Asr at Maghrib", () => expect(waqtEnd(five, "Asr")).toBe(18 * 60 + 17));

  it("ends Isha at Islamic midnight", () => expect(waqtEnd(five, "Isha")).toBe(23 * 60 + 58));

  it("pushes an Islamic midnight past 00:00 into the next day instead of reading as expired", () => {
    expect(waqtEnd({ ...five, Midnight: "00:12" }, "Isha")).toBe(24 * 60 + 12);
  });

  it("returns null rather than a guess when the boundary was never cached", () => {
    expect(waqtEnd({ Fajr: "04:23" }, "Fajr")).toBeNull();
  });
});

describe("currentPrayer", () => {
  it("is the prayer that has started and not yet expired", () => {
    expect(currentPrayer(five, 4 * 60 + 30).name).toBe("Fajr");
  });

  it("is nothing in the gap between sunrise and Dhuhr", () => {
    expect(currentPrayer(five, 5 * 60 + 35)).toBeNull();
  });

  it("is nothing once Isha's waqt has run out", () => {
    expect(currentPrayer(five, 23 * 60 + 59)).toBeNull();
  });

  it("falls back to the next prayer's start when no boundary is cached", () => {
    expect(currentPrayer({ Fajr: "04:23", Dhuhr: "11:58" }, 5 * 60).name).toBe("Fajr");
  });
});

describe("toMinutes", () => {
  it("parses hh:mm", () => expect(toMinutes("04:23")).toBe(263));
  it("returns null on junk rather than NaN", () => expect(toMinutes("nonsense")).toBeNull());
});

describe("duePrayers", () => {
  it("fires on the exact minute", () => {
    expect(duePrayers(five, 15 * 60 + 27, []).due).toEqual(["Asr"]);
  });

  it("fires only the just-passed prayer, not everything before it", () => {
    const { due, stale } = duePrayers(five, 15 * 60 + 30, []);
    expect(due).toEqual(["Asr"]);
    expect(stale).toEqual(["Fajr", "Dhuhr"]);
  });

  it("silences the whole day when the app opens late instead of firing five at once", () => {
    const { due, stale } = duePrayers(five, 22 * 60, []);
    expect(due).toEqual([]);
    expect(stale).toHaveLength(5);
  });

  it("never repeats a prayer already notified", () => {
    expect(duePrayers(five, 15 * 60 + 30, ["Asr"]).due).toEqual([]);
  });

  it("does not fire a prayer that is still ahead", () => {
    expect(duePrayers(five, 4 * 60, []).due).toEqual([]);
  });
});

describe("nextPrayer", () => {
  it("skips the prayers already passed", () => {
    expect(nextPrayer(five, 12 * 60).name).toBe("Asr");
  });

  it("returns null once Isha has passed", () => {
    expect(nextPrayer(five, 20 * 60)).toBeNull();
  });
});

describe("statusLine", () => {
  it("names the running prayer with its time left, then the next one", () => {
    // 12:53 — Dhuhr started at 11:58, Asr comes at 15:27.
    expect(statusLine(five, 12 * 60 + 53)).toBe("Dhuhr 2hr 34min remaining, Asr: 3:27 PM");
  });

  it("drops the current half AND its comma before the first prayer of the day", () => {
    expect(statusLine(five, 2 * 60)).toBe("Fajr: 4:23 AM");
  });

  it("drops the next half AND its comma after the last prayer of the day", () => {
    expect(statusLine(five, 21 * 60)).toBe("Isha 2hr 58min remaining");
  });

  it("counts Fajr down to sunrise, not to Dhuhr", () => {
    expect(statusLine(five, 4 * 60 + 30)).toBe("Fajr 1hr remaining, Dhuhr: 11:58 AM");
  });

  it("shows only the next prayer in the gap after sunrise", () => {
    expect(statusLine(five, 6 * 60)).toBe("Dhuhr: 11:58 AM");
  });

  it("omits the hour when under an hour is left", () => {
    expect(statusLine(five, 15 * 60)).toBe("Dhuhr 27min remaining, Asr: 3:27 PM");
  });

  it("returns empty rather than a bare comma when there are no times at all", () => {
    expect(statusLine({}, 12 * 60)).toBe("");
  });

  it("renders midnight and noon as 12, not 0", () => {
    expect(statusLine({ Fajr: "00:10" }, 0).endsWith("12:10 AM")).toBe(true);
    expect(statusLine({ Dhuhr: "12:05" }, 0).endsWith("12:05 PM")).toBe(true);
  });
});

describe("indexCalendar", () => {
  it("flips the API's DD-MM-YYYY into the app's YYYY-MM-DD", () => {
    const cal = indexCalendar([{ date: { gregorian: { date: "01-09-2026" } }, timings: raw }]);
    expect(Object.keys(cal)).toEqual(["2026-09-01"]);
    expect(cal["2026-09-01"].Asr).toBe("15:27");
  });

  it("skips malformed rows instead of throwing", () => {
    expect(indexCalendar([{ timings: raw }, null])).toEqual({});
  });
});

describe("pruneToMonth", () => {
  it("keeps only the current month so the cache cannot grow forever", () => {
    expect(Object.keys(pruneToMonth({ "2026-08-31": 1, "2026-09-01": 2 }, "2026-09")))
      .toEqual(["2026-09-01"]);
  });
});

describe("date keys", () => {
  it("zero-pads so keys sort and prefix-match", () => {
    const d = new Date(2026, 0, 5);
    expect(monthPrefix(d)).toBe("2026-01");
    expect(dayKey(d)).toBe("2026-01-05");
  });
});

describe("reminders", () => {
  it("rotates rather than repeating back to back", () => {
    expect(prayerReminderAt(0).text).not.toBe(prayerReminderAt(1).text);
  });

  it("wraps in both directions", () => {
    expect(prayerReminderAt(PRAYER_REMINDERS.length)).toEqual(prayerReminderAt(0));
    expect(prayerReminderAt(-1)).toEqual(prayerReminderAt(PRAYER_REMINDERS.length - 1));
  });

  it("every reminder carries a text and a source", () => {
    for (const r of PRAYER_REMINDERS) {
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.source.length).toBeGreaterThan(0);
    }
  });

  it("carries the whole hadith and its source in the notification body", () => {
    const r = prayerReminderAt(3);
    const n = notificationText("Asr", r);
    expect(n.body).toBe(`${r.text}\n— ${r.source}`);
  });

  it("names the prayer in Bengali in the notification title", () => {
    const n = notificationText("Maghrib", prayerReminderAt(0));
    expect(n.title).toBe("মাগরিবের ওয়াক্ত হয়েছে");
    expect(n.body).toContain("—");
  });

  it("has a Bengali heading for every one of the five prayers", () => {
    for (const name of ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]) {
      expect(PRAYER_HEADINGS[name]).toBeTruthy();
      expect(notificationText(name, prayerReminderAt(0)).title).not.toBe(name);
    }
  });

  it("falls back to the API name when a heading is missing", () => {
    expect(notificationText("Sunrise", prayerReminderAt(0)).title).toBe("Sunrise");
  });
});
