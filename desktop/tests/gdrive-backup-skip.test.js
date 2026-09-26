// gdBackupNow() used to write a new dated Drive snapshot on every call, even
// with zero net change since the last one (once/day auto-backup, or any
// manual "Back up now" click) -- cluttering Drive with identical copies and
// making it harder to spot the one dated snapshot from just before a real
// problem. Ported from the extension's equivalent regression test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDrive, fakeInvoke } from "./fake-drive.js";

describe("gdBackupNow skips a redundant dated snapshot", () => {
  beforeEach(() => vi.resetModules());

  it("skips writing when nothing changed, still writes on a real change", async () => {
    const drive = makeFakeDrive();
    const fakeApp = {
      data: {
        name: "Debjit Paul",
        days: { "2026-09-20": [{ id: "e1", project: "ZuPOS", category: "Development", description: "one", accSec: 3600 }] },
        submittedDays: {},
        deletedEntries: {},
        timer: { activeId: null, startedAt: null, date: null },
      },
    };
    vi.doMock("../src/lib/store.svelte.js", () => ({ app: fakeApp, save: () => {} }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: fakeInvoke(drive, "A") }));

    const { gdBackupNow } = await import("../src/lib/gdrive.js");

    const wrote1 = await gdBackupNow(true);
    expect(wrote1).toBe(true);
    expect(drive.dated().length).toBe(1);

    const wrote2 = await gdBackupNow(true);
    expect(wrote2).toBe(false);
    expect(drive.dated().length).toBe(1); // no new file for a no-op call

    // A real change must still be backed up (content-checked, not
    // file-count-checked -- a same-minute rerun overwrites that minute's
    // dated file rather than multiplying it, per gdBackupNow's own comment).
    fakeApp.data.days["2026-09-20"].push({ id: "e2", project: "ZuPOS", category: "Development", description: "two", accSec: 60 });
    const wrote3 = await gdBackupNow(true);
    expect(wrote3).toBe(true);
    const latestDated = drive.dated().sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))[0];
    expect(JSON.parse(latestDated.content).days["2026-09-20"].some((e) => e.id === "e2")).toBe(true);
  });
});
