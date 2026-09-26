"use strict";
// Sync v2 core, shared byte-for-byte by the extension (root sync-core.js) and the desktop/mobile
// apps (desktop/src/lib/sync-core.js). Classic script: it only assigns globalThis.TTCore, so the
// extension loads it with <script>/importScripts and the desktop app with a side-effect import.
//
// Model: every entry is a last-writer-wins register keyed by id, versioned by (updatedAt,
// updatedBy) from a hybrid logical clock; a delete is a tombstone {id: deletedAt}; an entry is live
// while its updatedAt is newer than its tombstone. merge() is commutative, associative and
// idempotent, so every device converges no matter who syncs first or how often.
// On Drive each device writes ONLY its own device-<id>.json and reads everyone's, so no two
// devices ever write the same file and a concurrent sync cannot lose anyone's data.
(function (root) {
  const FOLDER = "Team Timesheet Backups";
  const LEGACY = "timesheet-latest.json";
  const DEVICE_RE = /^device-(.+)\.json$/;
  const DRIVE = "https://www.googleapis.com/drive/v3/files";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const LOG_MAX = 500;

  const uuid = () => (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID()
    : "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));

  // ---- clock + stamping -------------------------------------------------------
  //* Every stamp is greater than any stamp this device has seen, so an edit made after seeing a
  //* version always beats it even if this device's wall clock runs behind the other one's.
  function ensureMeta(d) {
    if (!d.deviceId) d.deviceId = uuid();
    if (typeof d.clock !== "number" || !isFinite(d.clock)) d.clock = 0;
    if (!d.deletedEntries || typeof d.deletedEntries !== "object") d.deletedEntries = {};
    if (!d.deletedBy || typeof d.deletedBy !== "object") d.deletedBy = {};
    if (!d.submittedDays || typeof d.submittedDays !== "object") d.submittedDays = {};
    //? Legacy unmark was a bare null (no timestamp); give it this device's stamp once so it keeps
    //? beating older marks, which is what the old local-wins merge did for this device.
    for (const k of Object.keys(d.submittedDays)) {
      if (d.submittedDays[k] === null) d.submittedDays[k] = { at: stamp(d), method: null, by: d.deviceId };
    }
    return d;
  }
  function stamp(d) {
    d.clock = Math.max(Date.now(), (d.clock || 0) + 1);
    return d.clock;
  }
  function touch(d, e) {
    e.updatedAt = stamp(d);
    e.updatedBy = d.deviceId;
    return e;
  }
  function tombstone(d, id) {
    d.deletedEntries[id] = stamp(d);
    d.deletedBy[id] = d.deviceId;
  }
  function setSubmitted(d, date, method) {
    d.submittedDays[date] = { at: stamp(d), method: method || null, by: d.deviceId };
  }
  function isMarked(info) {
    return !!(info && info.method);
  }

  // ---- entries ----------------------------------------------------------------
  const ts = (e) => Number(e && e.updatedAt) || 0;
  const tomb = (deleted, id) => {
    const v = deleted && deleted[id];
    return v === undefined || v === null ? null : Number(v) || 0;
  };
  function isLive(e, deleted) {
    const t = tomb(deleted, e.id);
    return t === null || ts(e) > t;
  }
  function cleanEntry(e) {
    const out = {
      id: String(e.id), project: e.project || "", category: e.category || "",
      description: e.description || "", accSec: Number(e.accSec) || 0, submitted: !!e.submitted,
    };
    if (e.updatedAt) out.updatedAt = Number(e.updatedAt) || 0;
    if (e.updatedBy) out.updatedBy = String(e.updatedBy);
    return out;
  }
  const canon = (e) => JSON.stringify([e.project || "", e.category || "", e.description || "",
    Number(e.accSec) || 0, !!e.submitted, ts(e), e.updatedBy || ""]);
  // >0 when a wins. Total order: newer stamp, then writer id, then (legacy, unstamped) more time
  // tracked, then content — so every device picks the same winner.
  function cmpEntry(a, b) {
    if (ts(a) !== ts(b)) return ts(a) > ts(b) ? 1 : -1;
    const ab = a.updatedBy || "", bb = b.updatedBy || "";
    if (ab !== bb) return ab > bb ? 1 : -1;
    const as = Number(a.accSec) || 0, bs = Number(b.accSec) || 0;
    if (as !== bs) return as > bs ? 1 : -1;
    const ac = canon(a), bc = canon(b);
    return ac === bc ? 0 : ac > bc ? 1 : -1;
  }
  const subAt = (i) => (i && Number(i.at)) || 0;
  function normSub(i) {
    if (i === null || i === undefined) return { at: 0, method: null, by: "" };
    return { at: subAt(i), method: i.method || null, by: i.by || "" };
  }
  function cmpSub(a, b) {
    if (a.at !== b.at) return a.at > b.at ? 1 : -1;
    if ((a.by || "") !== (b.by || "")) return (a.by || "") > (b.by || "") ? 1 : -1;
    const am = a.method || "", bm = b.method || "";
    return am === bm ? 0 : am > bm ? 1 : -1;
  }

  //* Pull the syncable part out of any envelope/doc (v1 or v2). Entries without an id get a
  //* content-derived one so two devices importing the same legacy file agree on it.
  function stateOf(o) {
    o = o || {};
    const days = {};
    for (const [date, list] of Object.entries(o.days && typeof o.days === "object" ? o.days : {})) {
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (!e || typeof e !== "object") continue;
        const id = e.id || "h-" + hash(date + "|" + e.project + "|" + e.category + "|" + e.description);
        (days[date] = days[date] || []).push(cleanEntry({ ...e, id }));
      }
    }
    const deletedEntries = {};
    //! A tombstone must be a real time: a junk/zero one would silently kill every unstamped entry.
    for (const [id, t] of Object.entries(o.deletedEntries || {})) if (Number(t) > 0) deletedEntries[id] = Number(t);
    const submittedDays = {};
    for (const [d, i] of Object.entries(o.submittedDays || {})) submittedDays[d] = normSub(i);
    return {
      days, deletedEntries, submittedDays,
      deletedBy: { ...(o.deletedBy || {}) }, clock: Number(o.clock) || 0,
    };
  }

  function merge(states) {
    const deletedEntries = {}, deletedBy = {}, submittedDays = {};
    const best = new Map(), order = [];
    let clock = 0;
    for (const raw of states) {
      if (!raw) continue;
      const s = stateOf(raw);
      clock = Math.max(clock, s.clock);
      for (const [id, t] of Object.entries(s.deletedEntries)) {
        const by = s.deletedBy[id] || "";
        if (!(id in deletedEntries) || t > deletedEntries[id] || (t === deletedEntries[id] && by > (deletedBy[id] || ""))) {
          deletedEntries[id] = t;
          if (by) deletedBy[id] = by;
        }
        clock = Math.max(clock, t);
      }
      for (const [d, i] of Object.entries(s.submittedDays)) {
        if (!submittedDays[d] || cmpSub(i, submittedDays[d]) > 0) submittedDays[d] = i;
        clock = Math.max(clock, i.at);
      }
      for (const [date, list] of Object.entries(s.days)) {
        for (const e of list) {
          const cur = best.get(e.id);
          if (!cur) { best.set(e.id, { date, e }); order.push(e.id); }
          else {
            //? Same version filed under two dates can only come from a hand-edited file; pick the later
            //? date so the result still doesn't depend on merge order.
            const c = cmpEntry(e, cur.e);
            if (c > 0 || (c === 0 && date > cur.date)) best.set(e.id, { date, e });
          }
          clock = Math.max(clock, ts(e));
        }
      }
    }
    const days = {};
    for (const id of order) {
      const { date, e } = best.get(id);
      if (isLive(e, deletedEntries)) (days[date] = days[date] || []).push(e);
    }
    return { days, deletedEntries, deletedBy, submittedDays, clock };
  }

  function canonState(s) {
    s = stateOf(s);
    const days = Object.keys(s.days).sort().map((d) => [d, s.days[d].map(canon).map((c, i) => s.days[d][i].id + c).sort()]);
    const del = Object.keys(s.deletedEntries).sort().map((k) => [k, s.deletedEntries[k]]);
    const sub = Object.keys(s.submittedDays).sort().map((k) => [k, s.submittedDays[k].at, s.submittedDays[k].method, s.submittedDays[k].by]);
    return JSON.stringify([days, del, sub]);
  }
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }
  const sig = (s) => hash(canonState(s));
  function counts(s) {
    s = stateOf(s);
    let entries = 0;
    for (const l of Object.values(s.days)) entries += l.length;
    return { entries, tombstones: Object.keys(s.deletedEntries).length, submitted: Object.keys(s.submittedDays).length };
  }

  //* What changed for the entries live in `before` vs `after` — feeds the activity log and decides
  //* whether a recovery point is needed.
  function diff(before, after) {
    const idx = (s) => {
      const m = new Map();
      for (const [date, list] of Object.entries(stateOf(s).days)) for (const e of list) m.set(e.id, { date, e });
      return m;
    };
    const b = idx(before), a = idx(after);
    const aState = stateOf(after);
    const added = [], removed = [], changed = [];
    for (const [id, x] of a) {
      const y = b.get(id);
      if (!y) added.push(x);
      else if (canon(y.e) !== canon(x.e) || y.date !== x.date) changed.push({ date: x.date, before: y.e, after: x.e });
    }
    for (const [id, y] of b) {
      if (a.has(id)) continue;
      const t = tomb(aState.deletedEntries, id);
      removed.push({ ...y, deletedAt: t, deletedBy: aState.deletedBy[id] || "" });
    }
    return { added, removed, changed };
  }

  // ---- restore ----------------------------------------------------------------
  //* Entries in a backup that are not live here now — the only things a restore can offer.
  function restoreCandidates(current, backup) {
    const live = new Set();
    for (const list of Object.values(stateOf(current).days)) for (const e of list) live.add(e.id);
    const out = [];
    const b = stateOf(backup);
    for (const date of Object.keys(b.days).sort().reverse()) {
      for (const e of b.days[date]) if (!live.has(e.id)) out.push({ date, entry: e });
    }
    return out;
  }
  //! A fresh stamp is what lets a restored entry beat the tombstone that removed it, on every device.
  function applyRestore(d, days, picked) {
    const live = new Set();
    for (const list of Object.values(days)) for (const e of list) live.add(e.id);
    const added = [];
    for (const { date, entry } of picked) {
      if (live.has(entry.id)) continue;
      const e = touch(d, cleanEntry(entry));
      (days[date] = days[date] || []).push(e);
      live.add(e.id);
      added.push({ date, e });
    }
    return added;
  }

  // ---- envelopes --------------------------------------------------------------
  function envelope(state, meta) {
    const s = stateOf(state);
    return {
      app: "team-timesheet", v: 2, exportedAt: Date.now(), name: (meta && meta.name) || "",
      deviceId: (meta && meta.deviceId) || "", deviceName: (meta && meta.deviceName) || "",
      clock: s.clock, days: s.days, deletedEntries: s.deletedEntries, deletedBy: s.deletedBy,
      submittedDays: s.submittedDays,
    };
  }
  //? Old clients read timesheet-latest.json and treat any truthy submittedDays value as "marked",
  //? so an unmark goes out as the null they understand.
  function legacyEnvelope(state, meta) {
    const env = envelope(state, meta);
    const sd = {};
    for (const [d, i] of Object.entries(env.submittedDays)) sd[d] = i.method ? { at: i.at, method: i.method } : null;
    env.submittedDays = sd;
    return env;
  }
  function parseEnvelope(text) {
    const o = JSON.parse(text);
    if (!o || typeof o !== "object" || !o.days || typeof o.days !== "object") throw new Error("Not a timesheet backup (no 'days').");
    return o;
  }

  // ---- activity log -----------------------------------------------------------
  const short = (e) => `${e.project || "?"} / ${e.category || "?"} / "${(e.description || "").slice(0, 60)}" ${fmtSec(e.accSec)}`;
  function fmtSec(sec) {
    const m = Math.round((Number(sec) || 0) / 60);
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  function logLine(ev) {
    return { t: new Date().toISOString(), ...ev };
  }
  function pushLog(list, evs) {
    const out = Array.isArray(list) ? list.slice() : [];
    for (const ev of evs) out.push(logLine(ev));
    return out.length > LOG_MAX ? out.slice(out.length - LOG_MAX) : out;
  }
  //* One log event per removed/changed entry so a disappearance can be traced to its source.
  function diffEvents(dif, source, devices) {
    const name = (id) => (devices && devices[id]) || (id ? "device " + String(id).slice(0, 8) : "unknown device");
    const evs = [];
    for (const r of dif.removed) {
      evs.push({
        type: "removed", source, id: r.e.id, date: r.date, entry: short(r.e),
        reason: r.deletedAt !== null ? `deleted on ${name(r.deletedBy)} at ${new Date(r.deletedAt).toISOString()}` : "not present after merge",
      });
    }
    for (const c of dif.changed) {
      evs.push({ type: "changed", source, id: c.after.id, date: c.date, from: short(c.before), to: short(c.after), by: name(c.after.updatedBy) });
    }
    for (const a of dif.added) evs.push({ type: "added", source, id: a.e.id, date: a.date, entry: short(a.e), by: name(a.e.updatedBy) });
    return evs;
  }

  // ---- Drive ------------------------------------------------------------------
  // http(method, url, body?, contentType?) -> Promise<string>; throws on a non-2xx response.
  function drive(http) {
    const q = encodeURIComponent;
    const json = async (m, u, b, c) => { const t = await http(m, u, b, c); return t ? JSON.parse(t) : {}; };
    async function listAll(query, fields) {
      const out = [];
      let token = "";
      do {
        const r = await json("GET", `${DRIVE}?q=${q(query)}&spaces=drive&pageSize=1000&fields=nextPageToken,files(${fields})` +
          (token ? `&pageToken=${q(token)}` : ""));
        out.push(...(r.files || []));
        token = r.nextPageToken || "";
      } while (token);
      return out;
    }
    return {
      //! Two devices connecting at once can each create the folder; read from every one, write to
      //! the oldest, so nobody ends up syncing against a different folder.
      async folders(create) {
        const f = await listAll(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`, "id,createdTime");
        f.sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
        if (f.length || !create) return f.map((x) => x.id);
        const c = await json("POST", `${DRIVE}?fields=id`, JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" }), "application/json");
        return [c.id];
      },
      async files(folderIds) {
        if (!folderIds.length) return [];
        const parents = folderIds.map((id) => `'${id}' in parents`).join(" or ");
        return listAll(`(${parents}) and trashed=false and mimeType='application/json'`, "id,name,modifiedTime,createdTime");
      },
      download: (id) => http("GET", `${DRIVE}/${id}?alt=media`),
      async create(folderId, name, content) {
        const boundary = "ttb" + Math.random().toString(16).slice(2);
        const meta = { name, parents: [folderId], mimeType: "application/json" };
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
        return json("POST", `${UPLOAD}?uploadType=multipart&fields=id,name`, body, `multipart/related; boundary=${boundary}`);
      },
      update: (id, content) => json("PATCH", `${UPLOAD}/${id}?uploadType=media&fields=id,name`, content, "application/json"),
    };
  }
  const byCreated = (a, b) => String(a.createdTime || "").localeCompare(String(b.createdTime || ""));

  // io: { http, deviceId, deviceName, name, meta:{get(k),set(k,v)}, commit(remoteState, devices) ->
  //       Promise<{final, diff}>, log(events), onLegacyClient() }
  //* The only step that touches local data is io.commit, which each platform runs atomically
  //* against its CURRENT local state — never against a copy taken before the network calls.
  async function sync(io) {
    const api = drive(io.http);
    const folders = await api.folders(true);
    const files = await api.files(folders);
    const mine = `device-${io.deviceId}.json`;
    const wanted = files.filter((f) => DEVICE_RE.test(f.name) || f.name === LEGACY).sort(byCreated);
    const texts = await Promise.all(wanted.map((f) => api.download(f.id).then((t) => t, (e) => ({ error: e }))));
    const states = [], devices = {};
    let own = null, ownSig = null, legacy = null, legacyObj = null;
    const bad = [];
    wanted.forEach((f, i) => {
      const t = texts[i];
      if (t && t.error) { bad.push({ name: f.name, error: String(t.error.message || t.error) }); return; }
      let o;
      try { o = parseEnvelope(t); } catch (e) { bad.push({ name: f.name, error: e.message }); return; }
      states.push(o);
      if (o.deviceId && o.deviceName) devices[o.deviceId] = o.deviceName;
      if (f.name === mine && !own) { own = f; ownSig = sig(o); }
      if (f.name === LEGACY && !legacy) { legacy = f; legacyObj = o; }
    });
    devices[io.deviceId] = io.deviceName;
    //! A file that can't be read is skipped, never treated as empty: skipping loses nothing under a
    //! union merge, but "empty" would be.
    if (bad.length) io.log(bad.map((b) => ({ type: "sync-bad-file", file: b.name, error: b.error })));

    const remote = merge(states);
    const { final, diff: dif } = await io.commit(remote, devices);
    const c = counts(final);
    const out = { pulled: dif.added.length + dif.removed.length + dif.changed.length, pushed: false, diff: dif };
    if (!c.entries && !c.tombstones && !c.submitted) return { ...out, status: "Nothing to sync yet — add an entry first." };

    const meta = { name: io.name, deviceId: io.deviceId, deviceName: io.deviceName };
    const finalSig = sig(final);
    if (ownSig !== finalSig) {
      const text = JSON.stringify(envelope(final, meta), null, 1);
      if (own) await api.update(own.id, text);
      else await api.create(folders[0], mine, text);
      out.pushed = true;
    }
    //? Compatibility mirror for devices still on the old version; nothing on v2 depends on it.
    const mirrorAt = Number(await io.meta.get("mirrorWrittenAt")) || 0;
    if (legacyObj && legacyObj.v !== 2 && mirrorAt && Number(legacyObj.exportedAt) > mirrorAt) {
      io.log([{ type: "legacy-client", detail: "timesheet-latest.json was written by a device still on the old version" }]);
      if (io.onLegacyClient) io.onLegacyClient();
    }
    if (!legacy || sig(legacyObj) !== finalSig) {
      const text = JSON.stringify(legacyEnvelope(final, meta), null, 1);
      if (legacy) await api.update(legacy.id, text);
      else await api.create(folders[0], LEGACY, text);
      await io.meta.set("mirrorWrittenAt", Date.now());
    } else if (!mirrorAt) {
      //! Mirror already matched, so nothing was written — still start the clock, or a later write by
      //! an old client could never be told apart from the one we found here.
      await io.meta.set("mirrorWrittenAt", Date.now());
    }
    out.status = out.pulled && out.pushed ? "Synced (merged this device's and Drive's changes)."
      : out.pulled ? "Synced (pulled from Drive)." : out.pushed ? "Synced (pushed to Drive)." : "Already in sync.";
    return out;
  }

  //* Dated snapshot of this device's post-sync state; skipped when nothing changed since the last.
  async function snapshot(io, state) {
    if (!counts(state).entries) throw new Error("Nothing to back up yet — add an entry first.");
    const s = sig(state);
    if ((await io.meta.get("lastBackupSig")) === s) return false;
    const api = drive(io.http);
    const folders = await api.folders(true);
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    const name = `timesheet-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${String(io.deviceId).slice(0, 6)}.json`;
    const text = JSON.stringify(envelope(state, { name: io.name, deviceId: io.deviceId, deviceName: io.deviceName }), null, 1);
    const existing = (await api.files(folders)).find((f) => f.name === name);
    if (existing) await api.update(existing.id, text);
    else await api.create(folders[0], name, text);
    await io.meta.set("lastBackupSig", s);
    return true;
  }

  async function listBackups(http) {
    const api = drive(http);
    const files = await api.files(await api.folders(false));
    return files.sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
  }

  root.TTCore = {
    FOLDER, LEGACY, LOG_MAX,
    ensureMeta, stamp, touch, tombstone, setSubmitted, isMarked, isLive, cleanEntry,
    stateOf, merge, sig, counts, diff, restoreCandidates, applyRestore,
    envelope, legacyEnvelope, parseEnvelope,
    pushLog, diffEvents, fmtSec, short,
    drive, sync, snapshot, listBackups,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
