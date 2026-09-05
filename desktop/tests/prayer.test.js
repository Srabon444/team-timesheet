// Scheduling logic for the prayer reminders. The failures worth guarding are silent ones: a
// notification that never fires, one that fires twice, or a burst of catch-up alerts after the
// machine wakes up.
import { describe, it, expect } from "vitest";
import {
  pickFive, toMinutes, duePrayers, nextPrayer, indexCalendar, pruneToMonth,
  notificationText, dayKey, monthPrefix,
} from "../src/lib/prayer.js";
import { prayerReminderAt, PRAYER_REMINDERS } from "../src/lib/prayer-hadiths.js";

const raw = {
  Fajr: "04:23 (+06)", Sunrise: "05:40 (+06)", Dhuhr: "11:58 (+06)", Asr: "15:27 (+06)",
  Sunset: "18:17 (+06)", Maghrib: "18:17 (+06)", Isha: "19:34 (+06)", Imsak: "04:13 (+06)",
  Midnight: "23:58 (+06)",
};
const five = pickFive(raw);

describe("pickFive", () => {
  it("keeps only the five obligatory prayers", () => {
    expect(Object.keys(five)).toEqual(["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]);
  });

  it("strips the API's timezone suffix", () => {
    expect(five.Fajr).toBe("04:23");
  });

  it("never lets Sunrise, Imsak or Midnight through — they are not prayers", () => {
    expect(five.Sunrise).toBeUndefined();
    expect(five.Imsak).toBeUndefined();
    expect(five.Midnight).toBeUndefined();
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

  it("names the prayer in the notification title", () => {
    const n = notificationText("Maghrib", prayerReminderAt(0));
    expect(n.title).toMatch(/^Maghrib/);
    expect(n.body).toContain("—");
  });
});
