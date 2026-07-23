// Ported from the Chrome extension's test/smoke.js — the same behavioral
// assertions, re-homed onto the desktop app's lib modules.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { secToHHMM, secToHHMMSS, hhmmToSec, stripDates, addDays } from "../src/lib/time.js";
import {
  dayTotal, trackedTotal, activeDayCount, dailyAverage, busiestDay,
  byProject, byCategory, mondayOf, weekDates, weekTotals,
} from "../src/lib/stats.js";
import * as timer from "../src/lib/timer.js";
import { parseNames } from "../src/lib/names.js";
import { categoryColor, projectColor, PROJECTS, CATEGORIES } from "../src/lib/constants.js";
import { buildFillScript } from "../src/lib/fillout-inject.js";
import { mergeDays } from "../src/lib/gdrive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("time conversions (extension parity)", () => {
  it("secToHHMM rounds to nearest minute", () => {
    expect(secToHHMM(0)).toBe("00:00");
    expect(secToHHMM(3600)).toBe("01:00");
    expect(secToHHMM(90)).toBe("00:02"); // round-nearest
    expect(secToHHMM(29)).toBe("00:00");
    expect(secToHHMM(3661)).toBe("01:01");
  });
  it("secToHHMMSS is exact", () => {
    expect(secToHHMMSS(3661)).toBe("01:01:01");
    expect(secToHHMMSS(59.9)).toBe("00:00:59");
  });
  it("hhmmToSec parses, tolerating loose input", () => {
    expect(hhmmToSec("02:30")).toBe(9000);
    expect(hhmmToSec("00:00")).toBe(0);
    expect(hhmmToSec("1:5")).toBe(3900);
  });
  it("stripDates returns 7 days ending at the anchor", () => {
    const dates = stripDates("2026-07-10");
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe("2026-07-04");
    expect(dates[6]).toBe("2026-07-10");
  });
  it("addDays crosses month boundaries", () => {
    expect(addDays("2026-07-01", -1)).toBe("2026-06-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("stats (extension parity fixture)", () => {
  const fixture = {
    "2026-07-06": [{ project: "ZuPOS", category: "Development", accSec: 3600 }],
    "2026-07-07": [],
    "2026-07-08": [
      { project: "ZuPOS", category: "Development", accSec: 1800 },
      { project: "VSB", category: "Code Review", accSec: 1800 },
    ],
    "2026-07-09": [{ project: "VSB", category: "Meeting (General)", accSec: 7200 }],
    "2026-07-10": [{ project: "ZuPOS", category: "Development", accSec: 900 }],
  };

  it("dayTotal sums a day's entries", () => {
    expect(dayTotal(fixture["2026-07-08"])).toBe(3600);
    expect(dayTotal([])).toBe(0);
    expect(dayTotal(undefined)).toBe(0);
  });
  it("trackedTotal sums every day", () => {
    expect(trackedTotal(fixture)).toBe(3600 + 0 + 3600 + 7200 + 900);
  });
  it("activeDayCount counts only days with entries", () => {
    expect(activeDayCount(fixture)).toBe(4);
  });
  it("dailyAverage divides by active days, 0 when empty", () => {
    expect(dailyAverage(fixture)).toBe(Math.round((3600 + 3600 + 7200 + 900) / 4));
    expect(dailyAverage({})).toBe(0);
  });
  it("busiestDay finds the highest-total day", () => {
    expect(busiestDay(fixture)).toEqual({ date: "2026-07-09", total: 7200 });
  });
  it("byProject / byCategory sum across days", () => {
    expect(byProject(fixture)["ZuPOS"]).toBe(3600 + 1800 + 900);
    expect(byProject(fixture)["VSB"]).toBe(1800 + 7200);
    expect(byCategory(fixture)["Development"]).toBe(3600 + 1800 + 900);
    expect(byCategory(fixture)["Meeting (General)"]).toBe(7200);
  });
  it("mondayOf handles Friday, Monday, and Sunday", () => {
    expect(mondayOf("2026-07-10")).toBe("2026-07-06"); // Fri -> Mon
    expect(mondayOf("2026-07-06")).toBe("2026-07-06"); // Mon -> itself
    expect(mondayOf("2026-07-12")).toBe("2026-07-06"); // Sun -> preceding Mon
  });
  it("weekDates / weekTotals give Mon..Sun with zero-fill", () => {
    const dates = weekDates("2026-07-06");
    expect(dates[0]).toBe("2026-07-06");
    expect(dates[6]).toBe("2026-07-12");
    const totals = weekTotals(fixture, "2026-07-06");
    expect(totals).toHaveLength(7);
    expect(totals[0].total).toBe(3600);
    expect(totals[4].total).toBe(900);
    expect(totals[5].total).toBe(0);
  });
});

describe("timer engine (extension parity)", () => {
  let data;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T10:00:00"));
    data = {
      days: { "2026-07-10": [] },
      timer: { activeId: null, startedAt: null, date: null },
      lastProject: null,
      lastCategory: null,
    };
    // node's crypto.randomUUID exists; entries need unique ids
    timer.addEntry(data, "2026-07-10", { project: "ZuPOS", category: "Development", description: "a" });
    timer.addEntry(data, "2026-07-10", { project: "VSB", category: "Code Review", description: "b" });
  });
  afterEach(() => vi.useRealTimers());

  const entries = () => data.days["2026-07-10"];

  it("addEntry records lastProject/lastCategory and submitted:false", () => {
    expect(data.lastProject).toBe("VSB");
    expect(data.lastCategory).toBe("Code Review");
    expect(entries().every((e) => e.submitted === false)).toBe(true);
  });

  it("one active timer; starting the second folds and stops the first", () => {
    const [a, b] = entries();
    timer.startTimer(data, "2026-07-10", a.id);
    vi.advanceTimersByTime(60_000);
    expect(Math.round(timer.elapsedSec(data, a))).toBe(60);
    timer.startTimer(data, "2026-07-10", b.id); // switch
    expect(Math.round(a.accSec)).toBe(60);
    expect(data.timer.activeId).toBe(b.id);
    vi.advanceTimersByTime(120_000);
    expect(Math.round(timer.elapsedSec(data, b))).toBe(120);
    expect(Math.round(timer.elapsedSec(data, a))).toBe(60); // a stays put
    timer.pauseTimer(data);
    expect(data.timer.activeId).toBeNull();
    expect(Math.round(b.accSec)).toBe(120);
  });

  it("editTime rebases a running timer", () => {
    const [a] = entries();
    timer.startTimer(data, "2026-07-10", a.id);
    vi.advanceTimersByTime(30_000);
    timer.editTime(data, "2026-07-10", a.id, "05:00");
    vi.advanceTimersByTime(60_000);
    expect(Math.round(timer.elapsedSec(data, a))).toBe(5 * 3600 + 60);
  });

  it("rollover folds a timer left running past midnight into ITS day", () => {
    const [a] = entries();
    timer.startTimer(data, "2026-07-10", a.id);
    vi.advanceTimersByTime(2 * 3600_000); // now 12:00 same day
    expect(timer.rolloverIfNeeded(data)).toBe(false);
    vi.setSystemTime(new Date("2026-07-11T00:30:00")); // past midnight
    expect(timer.rolloverIfNeeded(data)).toBe(true);
    expect(data.timer.activeId).toBeNull();
    // full elapsed credited to July 10's entry, none leaks into July 11
    expect(a.accSec).toBeGreaterThan(2 * 3600);
    expect(data.days["2026-07-11"]).toBeUndefined();
  });

  it("updateEntry keeps accSec and submitted; deleteEntry stops its timer", () => {
    const [a] = entries();
    a.accSec = 500;
    a.submitted = true;
    timer.updateEntry(data, "2026-07-10", a.id, { project: "NewERP", category: "Miscellaneous", description: "edited" });
    expect(a.accSec).toBe(500);
    expect(a.submitted).toBe(true);
    expect(a.project).toBe("NewERP");
    timer.startTimer(data, "2026-07-10", a.id);
    timer.deleteEntry(data, "2026-07-10", a.id);
    expect(data.timer.activeId).toBeNull();
    expect(entries().find((e) => e.id === a.id)).toBeUndefined();
  });

  it("pendingEntries excludes submitted; markSubmitted flips only listed ids", () => {
    const [a, b] = entries();
    expect(timer.pendingEntries(data, "2026-07-10")).toHaveLength(2);
    timer.markSubmitted(data, "2026-07-10", [a.id]);
    const pending = timer.pendingEntries(data, "2026-07-10");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(b.id);
  });
});

describe("parseNames (against the real captured form HTML)", () => {
  it("extracts all 21 names, sorted", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "..", "test", "fixtures", "form.html"), "utf8");
    const names = parseNames(html);
    expect(names).toHaveLength(21);
    expect(names).toContain("Md Ashraful Islam");
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
  it("returns [] on junk input", () => {
    expect(parseNames("<html></html>")).toEqual([]);
    expect(parseNames("")).toEqual([]);
  });
});

describe("colors", () => {
  it("categories and projects each get distinct, stable colors with fallbacks", () => {
    expect(categoryColor("Development")).not.toBe(categoryColor("Code Review"));
    expect(categoryColor("Development")).toBe(categoryColor("Development"));
    expect(categoryColor("Nope")).toBeTruthy();
    expect(projectColor("ZuPOS")).not.toBe(projectColor("VSB"));
    expect(projectColor("Nope")).toBeTruthy();
    expect(PROJECTS).toHaveLength(11);
    expect(CATEGORIES).toHaveLength(5);
  });
});

describe("buildFillScript", () => {
  it("produces a self-contained IIFE embedding the payload", () => {
    const script = buildFillScript(
      [{ id: "x1", project: "ZuPOS", category: "Development", description: "task", hhmm: "01:30" }],
      "Md Ashraful Islam"
    );
    expect(script).toContain('"ZuPOS"');
    expect(script).toContain('"Md Ashraful Islam"');
    expect(script).toContain("TT_STATE:");
    expect(script).toContain("contentDocument");
    // untrusted-event automation essentials survived stringification
    expect(script).toContain("react-select__placeholder");
    expect(script).toContain("HTMLInputElement.prototype");
    // must be syntactically valid JS
    expect(() => new Function(script)).not.toThrow();
  });
  it("escapes hostile strings safely via JSON", () => {
    const script = buildFillScript(
      [{ id: "x", project: "ZuPOS", category: "Development", description: 'a"b</script>\\n', hhmm: "00:01" }],
      'name"quote'
    );
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("Drive sync merge", () => {
  it("keeps entries added on two offline devices — neither overrides the other", () => {
    const phone = { "2026-07-20": [{ id: "A", description: "phone task" }] };
    const desktop = { "2026-07-20": [{ id: "B", description: "desktop task" }] };
    const m = mergeDays(phone, {}, desktop, {});
    expect(m.days["2026-07-20"]).toHaveLength(2);
    expect(m.days["2026-07-20"].map((e) => e.id).sort()).toEqual(["A", "B"]);
  });
  it("an empty local side does not erase Drive's entries", () => {
    const m = mergeDays({}, {}, { "2026-07-20": [{ id: "A" }] }, {});
    expect(m.days["2026-07-20"]).toHaveLength(1);
  });
  it("an empty Drive side does not erase local entries", () => {
    const m = mergeDays({ "2026-07-20": [{ id: "A" }] }, {}, {}, {});
    expect(m.days["2026-07-20"]).toHaveLength(1);
  });
  it("a tombstoned entry is not resurrected from the other side's stale copy", () => {
    const m = mergeDays(
      { "2026-07-20": [] }, { A: Date.now() },
      { "2026-07-20": [{ id: "A" }] }, {}
    );
    expect(m.days["2026-07-20"]).toBeUndefined();
    expect(m.deleted).toHaveProperty("A");
  });
  it("same-id collision (edited on both sides while offline) deterministically prefers local", () => {
    const m = mergeDays(
      { "2026-07-20": [{ id: "A", description: "local edit" }] }, {},
      { "2026-07-20": [{ id: "A", description: "drive edit" }] }, {}
    );
    expect(m.days["2026-07-20"][0].description).toBe("local edit");
  });
});
