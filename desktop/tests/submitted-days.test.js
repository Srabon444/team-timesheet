// Marking/unmarking a day is the only thing that reaches the team dashboard, so the two bugs
// guarded here are the ones that silently emptied it: an unmark that a Drive sync resurrects,
// and an unmark the dashboard never hears about.
import { describe, it, expect, vi, beforeEach } from "vitest";

const ingestCalls = [];

async function loadStore() {
  ingestCalls.length = 0;
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve("{}") }));
  vi.doMock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
  vi.doMock("@tauri-apps/plugin-notification", () => ({
    isPermissionGranted: () => Promise.resolve(false),
    requestPermission: () => Promise.resolve("denied"),
    sendNotification: () => {},
  }));
  vi.doMock("../src/lib/gdrive.js", () => ({
    gdConnected: () => Promise.resolve(true),
    gdConnect: () => Promise.resolve(),
    gdSyncNow: () => Promise.resolve(""),
    gdBackupNow: () => Promise.resolve(),
    timesheetIngest: (name, date, method, entries) => {
      ingestCalls.push({ date, method, entries });
      return Promise.resolve();
    },
  }));
  return import("../src/lib/store.svelte.js");
}

describe("day-submitted marking", () => {
  beforeEach(() => vi.resetModules());

  it("unmarking leaves an explicit null tombstone, not a missing key", async () => {
    const store = await loadStore();
    const DAY = "2026-09-04";
    store.app.data.days = { [DAY]: [{ id: "e1", project: "P", category: "C", description: "d", accSec: 600 }] };
    store.app.data.submittedDays = {};

    await store.markDaySubmitted(DAY, "manual");
    expect(store.daySubmitted(DAY)).toBeTruthy();

    await store.unmarkDaySubmitted(DAY);
    expect(store.daySubmitted(DAY)).toBeFalsy();
    // The bug: `delete` left nothing for the Drive merge ({...drive, ...local}) to override, so
    // the day came back marked on the next sync.
    expect(DAY in store.app.data.submittedDays).toBe(true);
    expect(store.app.data.submittedDays[DAY]).toBeNull();
  });

  it("a Drive copy that still has the day marked cannot resurrect a tombstone", async () => {
    const store = await loadStore();
    const DAY = "2026-09-04";
    store.app.data.days = { [DAY]: [{ id: "e1", accSec: 60 }] };
    store.app.data.submittedDays = {};
    await store.markDaySubmitted(DAY, "manual");
    await store.unmarkDaySubmitted(DAY);

    const drive = { [DAY]: { at: 1, method: "manual" } };
    const merged = { ...drive, ...store.app.data.submittedDays };
    expect(merged[DAY]).toBeNull();
  });

  it("unmarking tells the dashboard to drop the day", async () => {
    const store = await loadStore();
    const DAY = "2026-09-04";
    store.app.data.days = { [DAY]: [{ id: "e1", accSec: 60 }] };
    store.app.data.submittedDays = {};
    await store.markDaySubmitted(DAY, "manual");
    await store.unmarkDaySubmitted(DAY);

    expect(ingestCalls).toEqual([{ date: DAY, method: "unmark", entries: [] }]);
  });
});
