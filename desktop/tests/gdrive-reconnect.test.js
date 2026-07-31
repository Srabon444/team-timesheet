// A Drive token revoke/expiry must flip a shared, reactive flag so the app
// can surface "reconnect" in the UI — the bug this guards against is that
// flag silently never getting set (App.svelte's auto-sync swallows errors).
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Drive reconnect signal", () => {
  beforeEach(() => vi.resetModules());

  it("sets gdriveNeedsReconnect when a Drive call fails after the token dies", async () => {
    const fakeApp = { gdriveNeedsReconnect: false };
    vi.doMock("../src/lib/store.svelte.js", () => ({ app: fakeApp, save: () => {} }));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (cmd) => {
        if (cmd === "gdrive_connected") return Promise.resolve(false); // Rust already cleared it
        if (cmd === "gdrive_api") return Promise.reject(new Error("token refresh failed"));
        return Promise.resolve();
      },
    }));

    const { gdListBackups } = await import("../src/lib/gdrive.js");
    await expect(gdListBackups()).rejects.toThrow(/reconnect/i);
    expect(fakeApp.gdriveNeedsReconnect).toBe(true);
  });

  it("does not flag a plain network error while still connected", async () => {
    const fakeApp = { gdriveNeedsReconnect: false };
    vi.doMock("../src/lib/store.svelte.js", () => ({ app: fakeApp, save: () => {} }));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (cmd) => {
        if (cmd === "gdrive_connected") return Promise.resolve(true); // token still good
        if (cmd === "gdrive_api") return Promise.reject(new Error("network blip"));
        return Promise.resolve();
      },
    }));

    const { gdListBackups } = await import("../src/lib/gdrive.js");
    await expect(gdListBackups()).rejects.toThrow("network blip");
    expect(fakeApp.gdriveNeedsReconnect).toBe(false);
  });

  it("clears the flag on reconnect and on explicit disconnect", async () => {
    const fakeApp = { gdriveNeedsReconnect: true };
    vi.doMock("../src/lib/store.svelte.js", () => ({ app: fakeApp, save: () => {} }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve() }));

    const { gdConnect, gdDisconnect } = await import("../src/lib/gdrive.js");
    await gdConnect();
    expect(fakeApp.gdriveNeedsReconnect).toBe(false);

    fakeApp.gdriveNeedsReconnect = true;
    await gdDisconnect();
    expect(fakeApp.gdriveNeedsReconnect).toBe(false);
  });
});
