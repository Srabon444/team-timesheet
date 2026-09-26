// Activity log + local recovery points (both kept by the Rust side as files in the app data
// folder, outside data.json, so they survive a damaged data file). Kept apart from store.svelte.js
// so the Drive layer can log without importing the whole store.
import { invoke } from "@tauri-apps/api/core";
import "./sync-core.js";

export const TT = globalThis.TTCore;

export function deviceName() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/Android/i.test(ua)) return "Android app";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS app";
  if (/Windows/i.test(ua)) return "Windows desktop";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS desktop";
  return "Linux desktop";
}

export function logEvents(evs) {
  if (!evs || !evs.length) return Promise.resolve();
  const dev = deviceName();
  const lines = evs.map((ev) => JSON.stringify({ t: new Date().toISOString(), dev, ...ev }));
  return Promise.resolve(invoke("append_log", { lines })).catch((e) => console.error("activity log write failed", e));
}

export async function readLog(max = 300) {
  const lines = (await invoke("read_log", { max })) || [];
  return lines.map((l) => {
    try { return JSON.parse(l); } catch { return { t: "", type: "raw", detail: l }; }
  });
}

//! Captures the state synchronously (envelope() copies it), so callers can mutate right after.
export function addRecoveryPoint(state, reason) {
  const env = TT.envelope(state, { deviceName: deviceName() });
  logEvents([{ type: "recovery-point", reason, entries: TT.counts(env).entries }]);
  return Promise.resolve(invoke("save_recovery", { json: JSON.stringify({ at: Date.now(), reason, env }) }))
    .catch((e) => console.error("recovery point write failed", e));
}

export async function listRecovery() {
  const list = (await invoke("list_recovery")) || [];
  return list.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}
