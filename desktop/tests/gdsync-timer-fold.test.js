// Investigating a reported bug: a manually-edited entry's time reverting to
// 00 sometime later, on desktop-linux, while connected to Google Drive.
// Hypothesis under test: applyEnvelope() (gdSync's "pulled" branch) replaces
// app.data.timer with a blank one WITHOUT folding the currently-running
// timer first -- so if a Drive pull happens while a timer is running, every
// live (not-yet-folded) second since startedAt is silently discarded instead
// of being credited to the entry's accSec.
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Drive pull folds a running timer before wiping it", () => {
  beforeEach(() => vi.resetModules());

  it("live elapsed seconds are credited to accSec, not discarded, when a pull happens mid-timer", async () => {
    const now = Date.now();
    const fakeApp = {
      data: {
        name: "Debjit Paul",
        days: { "2026-09-15": [{ id: "e1", project: "ZuPOS", category: "Development", description: "task", accSec: 0 }] },
        submittedDays: {},
        deletedEntries: {},
        timer: { activeId: "e1", startedAt: now - 60000, date: "2026-09-15" }, // running for 60s
      },
    };
    vi.doMock("../src/lib/store.svelte.js", () => ({ app: fakeApp, save: () => {} }));

    // Drive already has a DIFFERENT entry (e.g. from another device) so the
    // merge genuinely differs from local -- forcing gdSync's "pulled" branch,
    // the only path that calls applyEnvelope() and wipes the timer.
    let files = [
      { id: "folder1", name: "Team Timesheet Backups", isFolder: true },
    ];
    const latestContent = JSON.stringify({
      app: "team-timesheet", v: 1, name: "Debjit Paul",
      days: { "2026-09-15": [{ id: "e2", project: "VSB", category: "Development", description: "other device's task", accSec: 120 }] },
      submittedDays: {}, deletedEntries: {},
    });
    files.push({ id: "latest1", name: "timesheet-latest.json", isFolder: false, content: latestContent, parent: "folder1" });

    const fetchDrive = async (method, url, body) => {
      const u = new URL(url);
      if (u.pathname === "/drive/v3/files" && method === "GET") {
        const q = decodeURIComponent(u.searchParams.get("q") || "");
        const nameMatch = q.match(/name='([^']*)'/);
        const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
        const list = files.filter((f) => !!f.isFolder === wantFolder && (!nameMatch || f.name === nameMatch[1]));
        return JSON.stringify({ files: list.map((f) => ({ id: f.id, name: f.name })) });
      }
      const dl = u.pathname.match(/^\/drive\/v3\/files\/(.+)$/);
      if (dl && u.searchParams.get("alt") === "media") {
        const f = files.find((x) => x.id === dl[1]);
        return f ? f.content : "";
      }
      if (u.pathname === "/upload/drive/v3/files" && method === "POST") {
        return JSON.stringify({ id: "newfile", name: "x" });
      }
      const upd = u.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/);
      if (upd && method === "PATCH") return JSON.stringify({ id: upd[1], name: "x" });
      throw new Error("unhandled: " + method + " " + url);
    };

    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: async (cmd, args) => {
        if (cmd === "gdrive_connected") return true;
        if (cmd === "gdrive_api") return fetchDrive(args.method, args.url, args.body);
        return null;
      },
    }));

    const { gdSync } = await import("../src/lib/gdrive.js");

    const before = fakeApp.data.days["2026-09-15"][0].accSec + (Date.now() - fakeApp.data.timer.startedAt) / 1000;
    expect(before).toBeGreaterThan(55); // sanity: ~60s of live elapsed time exists before sync

    await gdSync(false);

    const e1 = fakeApp.data.days["2026-09-15"].find((e) => e.id === "e1");
    // Whether the timer is still running or was folded on the pull, the ~60
    // live seconds must be accounted for somewhere -- either accSec grew, or
    // the timer is still active and still counting them.
    const stillRunning = fakeApp.data.timer.activeId === "e1";
    const accountedFor = stillRunning || e1.accSec >= 55;
    expect(accountedFor).toBe(true);
  });
});
