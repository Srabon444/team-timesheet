// Issue #2 end to end on the desktop/mobile side: several devices share one Drive, with edits
// landing mid-sync, simultaneous syncs, stale copies and a restore after a delete.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDrive, fakeInvoke } from "./fake-drive.js";
import "../src/lib/sync-core.js";

const TT = globalThis.TTCore;
const D = "2026-09-20";

// One device = its own module instances of gdrive.js bound to its own app.data.
async function device(drive, who, entries, extra) {
  vi.resetModules();
  const fakeApp = {
    data: TT.ensureMeta({
      name: "Tester", days: { [D]: (entries || []).map((e) => ({ project: "P", category: "C", accSec: 60, ...e })) },
      submittedDays: {}, deletedEntries: {}, timer: { activeId: null, startedAt: null, date: null },
    }),
  };
  vi.doMock("../src/lib/store.svelte.js", () => ({ app: fakeApp, save: () => {} }));
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: fakeInvoke(drive, who, extra) }));
  const gd = await import("../src/lib/gdrive.js");
  const ids = () => (fakeApp.data.days[D] || []).map((e) => e.id).sort().join(",");
  return { app: fakeApp, gd, ids };
}

describe("sync v2 across devices", () => {
  beforeEach(() => vi.resetModules());

  it("edits made while a sync is waiting on the network survive and reach Drive", async () => {
    let dev = null;
    let n = 0;
    const typeOne = (id) => dev.app.data.days[D].push(TT.touch(dev.app.data, { id, project: "P", category: "C", description: id, accSec: 0 }));
    const drive = makeFakeDrive({ onDownload: async (f, who) => { if (who === "A" && dev && !n++) typeOne("typedDuringDownload"); } });
    // The old code lost edits made while it pushed submitted days to the dashboard, between its
    // merge and its write-back — so type one there too.
    let ingested = false;
    const extra = { timesheet_ingest: () => { if (!ingested) { ingested = true; typeOne("typedDuringIngest"); } return Promise.resolve(); } };
    const b = await device(drive, "B", [{ id: "fromB" }]);
    await b.gd.gdSync(false);
    dev = await device(drive, "A", [{ id: "a1" }], extra);
    dev.app.data.submittedDays[D] = { at: 1, method: "manual", by: "x" };
    await dev.gd.gdSync(false);
    expect(dev.ids()).toBe("a1,fromB,typedDuringDownload,typedDuringIngest");
    await dev.gd.gdSync(false);
    const c = await device(drive, "C", []);
    await c.gd.gdSync(false);
    expect(c.ids()).toBe("a1,fromB,typedDuringDownload,typedDuringIngest");
  });

  it("two devices syncing at the same instant both keep their data, and a third sees both", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    let waiting = 0;
    const drive = makeFakeDrive({
      onDownload: async (f, who) => {
        if ((who === "A" || who === "B") && waiting < 2) { if (++waiting === 2) release(); await gate; }
      },
    });
    const seed = await device(drive, "S", [{ id: "seed" }]);
    await seed.gd.gdSync(false);
    const a = await device(drive, "A", [{ id: "onlyA" }]);
    const b = await device(drive, "B", [{ id: "onlyB" }]);
    await Promise.all([a.gd.gdSync(false), b.gd.gdSync(false)]);
    const c = await device(drive, "C", []);
    await c.gd.gdSync(false);
    expect(c.ids()).toBe("onlyA,onlyB,seed");
  });

  it("a newer edit is not reverted by another device's stale copy", async () => {
    const drive = makeFakeDrive();
    const a = await device(drive, "A", [{ id: "t1", description: "old" }]);
    await a.gd.gdSync(false);
    const b = await device(drive, "B", []);
    await b.gd.gdSync(false);
    const e = a.app.data.days[D][0];
    e.description = "new";
    TT.touch(a.app.data, e);
    await a.gd.gdSync(false);
    await b.gd.gdSync(false);
    await a.gd.gdSync(false);
    expect(a.app.data.days[D][0].description).toBe("new");
    expect(b.app.data.days[D][0].description).toBe("new");
  });

  it("a restored task comes back on every device after a delete, and stays back", async () => {
    const drive = makeFakeDrive();
    const a = await device(drive, "A", [{ id: "keep" }, { id: "lost" }]);
    await a.gd.gdSync(false);
    const backup = JSON.parse(drive.deviceFile(a.app.data.deviceId).content);
    const b = await device(drive, "B", []);
    await b.gd.gdSync(false);
    a.app.data.days[D] = a.app.data.days[D].filter((e) => e.id !== "lost");
    TT.tombstone(a.app.data, "lost");
    await a.gd.gdSync(false);
    await b.gd.gdSync(false);
    expect(b.ids()).toBe("keep");
    const cands = TT.restoreCandidates(TT.stateOf(a.app.data), backup);
    expect(cands.map((c) => c.entry.id)).toEqual(["lost"]);
    TT.applyRestore(a.app.data, a.app.data.days, cands);
    await a.gd.gdSync(false);
    await b.gd.gdSync(false);
    await a.gd.gdSync(false);
    expect(a.ids()).toBe("keep,lost");
    expect(b.ids()).toBe("keep,lost");
  });

  it("a sync that removes tasks saves a recovery point and logs each removal with its source", async () => {
    const saved = [], logged = [];
    const extra = {
      save_recovery: ({ json }) => { saved.push(JSON.parse(json)); return Promise.resolve(); },
      append_log: ({ lines }) => { logged.push(...lines.map((l) => JSON.parse(l))); return Promise.resolve(); },
    };
    const drive = makeFakeDrive();
    const a = await device(drive, "A", [{ id: "r1" }, { id: "r2" }]);
    await a.gd.gdSync(false);
    const b = await device(drive, "B", [], extra);
    await b.gd.gdSync(false);
    for (const e of a.app.data.days[D]) TT.tombstone(a.app.data, e.id);
    a.app.data.days = {};
    await a.gd.gdSync(false);
    await b.gd.gdSync(false);
    expect(b.ids()).toBe("");
    expect(saved.length).toBe(1);
    expect(TT.counts(saved[0].env).entries).toBe(2);
    expect(logged.filter((e) => e.type === "removed")).toHaveLength(2);
  });
});

describe("local persistence safety", () => {
  beforeEach(() => vi.resetModules());

  async function loadStore(invoke) {
    vi.doUnmock("../src/lib/store.svelte.js"); // the multi-device suite above mocks it
    if (typeof globalThis.document === "undefined") globalThis.document = { documentElement: { dataset: {} } };
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.doMock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
    vi.doMock("@tauri-apps/plugin-notification", () => ({
      isPermissionGranted: () => Promise.resolve(false), requestPermission: () => Promise.resolve("denied"), sendNotification: () => {},
    }));
    vi.doMock("../src/lib/gdrive.js", () => ({
      gdConnected: () => Promise.resolve(false), gdConnect: () => Promise.resolve(), gdSyncNow: () => Promise.resolve(""),
      gdBackupNow: () => Promise.resolve(), timesheetIngest: () => Promise.resolve(),
    }));
    return import("../src/lib/store.svelte.js");
  }
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("an unreadable data file is never saved over", async () => {
    const saves = [];
    const store = await loadStore((cmd, args) => {
      if (cmd === "load_data") return Promise.reject("unreadable: /x/data.json (locked)");
      if (cmd === "save_data") { saves.push(args.json); return Promise.resolve(); }
      return Promise.resolve([]);
    });
    await store.load();
    store.addEntry(D, { project: "P", category: "C", description: "x" });
    await flush();
    expect(store.app.loadError).toMatch(/unreadable/);
    expect(saves).toHaveLength(0);
  });

  it("a corrupt data file (already copied aside by Rust) lets the app start and save", async () => {
    const saves = [];
    const store = await loadStore((cmd, args) => {
      if (cmd === "load_data") return Promise.reject("corrupt: data.json could not be read; a copy was kept as x");
      if (cmd === "save_data") { saves.push(args.json); return Promise.resolve(); }
      return Promise.resolve([]);
    });
    await store.load();
    store.addEntry(D, { project: "P", category: "C", description: "x" });
    await flush();
    expect(store.app.loadError).toMatch(/corrupt/);
    expect(saves.length).toBeGreaterThan(0);
    expect(JSON.parse(saves[saves.length - 1]).days[D]).toHaveLength(1);
  });

  it("saves run immediately and serialized, and the last write always holds the latest data", async () => {
    const saves = [];
    let release;
    const store = await loadStore((cmd, args) => {
      if (cmd === "load_data") return Promise.resolve("{}");
      if (cmd === "save_data") {
        saves.push(JSON.parse(args.json));
        return saves.length === 1 ? new Promise((r) => (release = r)) : Promise.resolve();
      }
      return Promise.resolve([]);
    });
    await store.load();
    await flush();
    const before = saves.length;
    store.addEntry(D, { project: "P", category: "C", description: "one" });
    store.addEntry(D, { project: "P", category: "C", description: "two" });
    await flush();
    if (release) release();
    await flush();
    expect(saves.length).toBeGreaterThan(before);
    expect(saves[saves.length - 1].days[D].map((e) => e.description)).toEqual(["one", "two"]);
  });

  it("a failed save shows an error and a later save clears it", async () => {
    let fail = true;
    const store = await loadStore((cmd) => {
      if (cmd === "load_data") return Promise.resolve("{}");
      if (cmd === "save_data") return fail ? Promise.reject("disk full") : Promise.resolve();
      return Promise.resolve([]);
    });
    await store.load();
    await flush();
    expect(store.app.saveError).toMatch(/disk full/);
    fail = false;
    store.addEntry(D, { project: "P", category: "C", description: "x" });
    await flush();
    expect(store.app.saveError).toBe("");
  });

  it("restorePicked adds only the ticked tasks and keeps everything present", async () => {
    const store = await loadStore((cmd) => (cmd === "load_data" ? Promise.resolve("{}") : Promise.resolve([])));
    await store.load();
    const here = store.addEntry(D, { project: "P", category: "C", description: "here" });
    store.removeEntry(D, here.id);
    const backup = { days: { [D]: [{ ...here }, { id: "m2", description: "two" }] } };
    const cands = store.restoreCandidates(backup);
    expect(cands.map((c) => c.entry.id).sort()).toEqual([here.id, "m2"].sort());
    expect(store.restorePicked(cands.filter((c) => c.entry.id === here.id), "test")).toBe(1);
    expect(store.app.data.days[D].map((e) => e.id)).toEqual([here.id]);
    expect(TT.isLive(store.app.data.days[D][0], store.app.data.deletedEntries)).toBe(true);
  });
});
