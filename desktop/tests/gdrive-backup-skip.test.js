// gdBackupNow() used to write a new dated Drive snapshot on every call, even
// with zero net change since the last one (once/day auto-backup, or any
// manual "Back up now" click) -- cluttering Drive with identical copies and
// making it harder to spot the one dated snapshot from just before a real
// problem. Ported from the extension's equivalent regression test.
import { describe, it, expect, vi, beforeEach } from "vitest";

function makeFakeDrive() {
  let files = [];
  let nextId = 1;
  const fetchDrive = async (method, url, body) => {
    const u = new URL(url);
    if (u.pathname === "/drive/v3/files" && method === "GET") {
      const q = decodeURIComponent(u.searchParams.get("q") || "");
      const nameMatch = q.match(/name='([^']*)'/);
      const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
      let list = files.filter((f) => !!f.isFolder === wantFolder && (!nameMatch || f.name === nameMatch[1]));
      if (u.searchParams.get("orderBy") === "modifiedTime desc") list = [...list].sort((a, b) => b.modifiedTime - a.modifiedTime);
      return JSON.stringify({ files: list.map((f) => ({ id: f.id, name: f.name, modifiedTime: new Date(f.modifiedTime).toISOString() })) });
    }
    if (u.pathname === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(body);
      const f = { id: "f" + nextId++, name: meta.name, isFolder: true, modifiedTime: Date.now() };
      files.push(f);
      return JSON.stringify({ id: f.id });
    }
    if (u.pathname === "/upload/drive/v3/files" && method === "POST") {
      const chunks = body.split(/--ttb[0-9a-f]+/).map((c) => c.trim()).filter((c) => c && c !== "--");
      const meta = JSON.parse(chunks[0].slice(chunks[0].indexOf("{")));
      const content = chunks[1].slice(chunks[1].indexOf("{"), chunks[1].lastIndexOf("}") + 1);
      const f = { id: "f" + nextId++, name: meta.name, content, modifiedTime: Date.now() };
      files.push(f);
      return JSON.stringify({ id: f.id, name: f.name });
    }
    const upd = u.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/);
    if (upd && method === "PATCH") {
      const f = files.find((x) => x.id === upd[1]);
      if (f) { f.content = body; f.modifiedTime = Date.now(); }
      return JSON.stringify(f ? { id: f.id, name: f.name } : {});
    }
    const dl = u.pathname.match(/^\/drive\/v3\/files\/(.+)$/);
    if (dl && u.searchParams.get("alt") === "media") {
      const f = files.find((x) => x.id === dl[1]);
      return f ? f.content : "";
    }
    throw new Error("unhandled fake-drive request: " + method + " " + url);
  };
  return { fetchDrive, dated: () => files.filter((f) => !f.isFolder && f.name !== "timesheet-latest.json") };
}

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
        gdLastBackupSig: null,
        timer: { activeId: null, startedAt: null, date: null },
      },
    };
    vi.doMock("../src/lib/store.svelte.js", () => ({ app: fakeApp, save: () => {} }));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (cmd, args) => {
        if (cmd === "gdrive_connected") return Promise.resolve(true);
        if (cmd === "gdrive_api") return drive.fetchDrive(args.method, args.url, args.body);
        return Promise.resolve();
      },
    }));

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
    const latestDated = drive.dated().sort((a, b) => b.modifiedTime - a.modifiedTime)[0];
    expect(JSON.parse(latestDated.content).days["2026-09-20"].some((e) => e.id === "e2")).toBe(true);
  });
});
