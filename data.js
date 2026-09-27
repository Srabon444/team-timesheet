"use strict";
// Extension data layer. chrome.storage.local is the single source of truth; every change to
// tracked data goes through TTData.withData(), which holds a cross-context lock (popup, full view
// and service worker share one Web Lock namespace) around read -> change -> write. No context ever
// writes from its own in-memory copy, so one window can no longer erase another window's edit.
// Needs sync-core.js loaded first.
(function (root) {
  const DEVICE_NAME = "Chrome extension";
  const RECOVERY_MAX = 10;
  const DATA_KEYS = ["entries", "history", "date", "timer", "deletedEntries", "deletedBy", "submittedDays",
    "clock", "deviceId", "ttLog", "recoveryPoints"];

  //? Defer to the page's todayStr() when there is one, so the data layer and the UI can never
  //? disagree on which day is live (the service worker has none and uses its own).
  function today() {
    if (typeof root.todayStr === "function") return root.todayStr();
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  //? Web Locks are shared across every extension page and the service worker; the fallback only
  //? serializes within one context (tests, or a browser without the API).
  const chains = {};
  function lock(name, fn) {
    if (root.navigator && root.navigator.locks && root.navigator.locks.request) {
      return root.navigator.locks.request(name, fn);
    }
    const run = (chains[name] || Promise.resolve()).then(() => fn());
    chains[name] = run.then(() => {}, () => {});
    return run;
  }

  function unionById(a, b) {
    const m = new Map();
    for (const e of a || []) if (e && e.id) m.set(e.id, e);
    for (const e of b || []) if (e && e.id) m.set(e.id, e);
    return [...m.values()];
  }

  // Storage snapshot -> working doc with one unified `days` map. Rolls the day over here, so a
  // context left open across midnight can never write under yesterday's date.
  function toDoc(st) {
    const t = today();
    const d = {
      date: t,
      timer: st.timer && st.timer.activeId ? { ...st.timer } : { activeId: null, startedAt: null },
      days: {},
      deletedEntries: { ...(st.deletedEntries || {}) },
      deletedBy: { ...(st.deletedBy || {}) },
      submittedDays: { ...(st.submittedDays || {}) },
      clock: st.clock, deviceId: st.deviceId,
      ttLog: Array.isArray(st.ttLog) ? st.ttLog : [],
      recoveryPoints: Array.isArray(st.recoveryPoints) ? st.recoveryPoints : [],
      set: {}, // extra non-data keys a change wants written in the same storage call
      rolled: false,
    };
    TTCore.ensureMeta(d);
    for (const [date, list] of Object.entries(st.history || {})) if (Array.isArray(list)) d.days[date] = list.slice();
    const liveDate = st.date || t;
    if (Array.isArray(st.entries) && st.entries.length) d.days[liveDate] = unionById(d.days[liveDate], st.entries);
    if (st.date && st.date !== t) {
      //* The running timer belongs to the old day's entry; credit it there before the new day starts.
      foldTimer(d, st.date);
      d.rolled = true;
      d.set.draft = null;
    }
    return d;
  }
  function fromDoc(d) {
    const history = {};
    for (const [date, list] of Object.entries(d.days)) if (date !== d.date && list.length) history[date] = list;
    return {
      ...d.set,
      entries: d.days[d.date] || [], history, date: d.date, timer: d.timer,
      deletedEntries: d.deletedEntries, deletedBy: d.deletedBy, submittedDays: d.submittedDays,
      clock: d.clock, deviceId: d.deviceId, ttLog: d.ttLog, recoveryPoints: d.recoveryPoints,
    };
  }

  function list(d, date) {
    return (d.days[date] = d.days[date] || []);
  }
  function find(d, date, id) {
    return (d.days[date] || []).find((e) => e.id === id) || null;
  }
  // Fold the running timer's live seconds into its entry (stamped, so the time syncs) and stop it.
  function foldTimer(d, date) {
    const { activeId, startedAt } = d.timer || {};
    if (activeId && startedAt) {
      const e = find(d, date || d.date, activeId);
      if (e) {
        e.accSec = (Number(e.accSec) || 0) + (Date.now() - startedAt) / 1000;
        TTCore.touch(d, e);
      }
    }
    d.timer = { activeId: null, startedAt: null };
  }
  function log(d, evs) {
    d.ttLog = TTCore.pushLog(d.ttLog, evs.map((ev) => ({ dev: DEVICE_NAME, ...ev })));
  }
  function addRecoveryPoint(d, reason) {
    const env = TTCore.envelope(TTCore.stateOf(d), { deviceId: d.deviceId, deviceName: DEVICE_NAME });
    d.recoveryPoints = [...d.recoveryPoints, { at: Date.now(), reason, env }].slice(-RECOVERY_MAX);
    log(d, [{ type: "recovery-point", reason, entries: TTCore.counts(env).entries }]);
  }

  // Run fn(doc) under the lock against fresh storage and write the result back in one set().
  // fn must not do network I/O — it holds the lock every other context is waiting on.
  async function withData(fn) {
    return lock("tt-data", async () => {
      const st = await chrome.storage.local.get(null);
      //! toDoc shares entry objects with st, so compare against a copy taken before fn runs.
      const pristine = JSON.parse(JSON.stringify(st));
      const d = toDoc(st);
      const result = await fn(d);
      const out = fromDoc(d);
      //* Only keys whose value actually changed, so a no-op change fires no onChanged/sync.
      const changed = {};
      for (const [k, v] of Object.entries(out)) if (JSON.stringify(v) !== JSON.stringify(pristine[k])) changed[k] = v;
      if (Object.keys(changed).length) await chrome.storage.local.set(changed);
      return { result, doc: d, written: out };
    });
  }

  root.TTData = { DEVICE_NAME, DATA_KEYS, today, lock, withData, list, find, foldTimer, log, addRecoveryPoint, toDoc };
})(typeof globalThis !== "undefined" ? globalThis : this);
