"use strict";
// Loaded after popup.js in tab.html — reuses its globals ($, S, route, init,
// showSetup, showMain, etc.) directly; do not redeclare `$` or `S` here.

function dayTotal(entries) {
  return (entries || []).reduce((sum, e) => sum + (e.accSec || 0), 0);
}
function trackedTotal(daysMap) {
  return Object.values(daysMap).reduce((sum, entries) => sum + dayTotal(entries), 0);
}
function activeDayCount(daysMap) {
  return Object.values(daysMap).filter((entries) => entries.length > 0).length;
}
function dailyAverage(daysMap) {
  const days = activeDayCount(daysMap);
  return days === 0 ? 0 : Math.round(trackedTotal(daysMap) / days);
}
function busiestDay(daysMap) {
  const dates = Object.keys(daysMap).sort().reverse(); // most-recent first, for tie-breaking
  let best = null;
  for (const date of dates) {
    const total = dayTotal(daysMap[date]);
    if (!best || total > best.total) best = { date, total };
  }
  return best;
}
function byProject(daysMap) {
  const out = {};
  for (const entries of Object.values(daysMap)) {
    for (const e of entries) out[e.project] = (out[e.project] || 0) + (e.accSec || 0);
  }
  return out;
}
function byCategory(daysMap) {
  const out = {};
  for (const entries of Object.values(daysMap)) {
    for (const e of entries) out[e.category] = (out[e.category] || 0) + (e.accSec || 0);
  }
  return out;
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // days to subtract to reach Monday
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function weekDates(mondayStr) {
  const d = new Date(mondayStr + "T00:00:00");
  const out = [];
  for (let i = 0; i < 7; i++) {
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}
function weekTotals(daysMap, mondayStr) {
  return weekDates(mondayStr).map((date) => ({ date, total: dayTotal(daysMap[date]) }));
}
// buildDaysMap / buildExportText / mutate live in popup.js (shared with the
// popup and gdrive.js sync). tab.js just uses them as globals.

let weekOffset = 0; // 0 = week containing today, -1 = previous week, etc.
let tsWeekOffset = 0; // same idea, independent state for the Timesheet panel

// Weekly Timesheet panel: every day of the week as its own card (full entry
// list, not just a total), click a card to jump to that day in Today.
function renderTimesheet() {
  const daysMap = buildDaysMap();
  const today = todayStr();
  const monday = addDaysStr(mondayOf(today), tsWeekOffset * 7);
  const dates = weekDates(monday);
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  document.getElementById("tsWeekLabel").textContent = `${dates[0]} – ${dates[6]}`;
  const weekTotal = dates.reduce((sum, d) => sum + dayTotal(daysMap[d]), 0);
  document.getElementById("tsWeekTotal").textContent = `Week: ${secToHHMM(weekTotal)}`;

  const container = document.getElementById("tsDays");
  container.innerHTML = "";
  dates.forEach((d, i) => {
    const entries = daysMap[d] || [];
    const isToday = d === today;
    const day = document.createElement("section");
    day.className = "tsDay" + (isToday ? " istoday" : "");
    day.innerHTML = `
      <div class="tsHead">
        <span><span class="tsDow"></span> <span class="muted tsDate"></span>${isToday ? '<span class="tsToday">Today</span>' : ""}</span>
        <span class="mono muted tsTotal"></span>
      </div>
      <div class="tsRows"></div>`;
    day.querySelector(".tsDow").textContent = DOW[i];
    day.querySelector(".tsDate").textContent = d;
    day.querySelector(".tsTotal").textContent = secToHHMM(dayTotal(entries));
    const rows = day.querySelector(".tsRows");
    if (!entries.length) {
      rows.innerHTML = '<p class="tsNone">No entries.</p>';
    } else {
      for (const e of entries) {
        const row = document.createElement("div");
        row.className = "tsRow";
        row.innerHTML = `
          <span class="dot"></span>
          <span class="desc"></span>
          <span class="cat"></span>
          <span class="proj muted"></span>
          <span class="mono t"></span>`;
        row.querySelector(".dot").style.background = projectColor(e.project);
        row.querySelector(".desc").textContent = e.description;
        const catEl = row.querySelector(".cat");
        catEl.textContent = e.category;
        catEl.style.background = categoryColor(e.category);
        row.querySelector(".proj").textContent = e.project;
        row.querySelector(".t").textContent = secToHHMM(e.accSec || 0);
        rows.appendChild(row);
      }
    }
    day.onclick = () => { setViewDate(d); showPanel("today"); };
    container.appendChild(day);
  });
}

function renderDashboard() {
  const daysMap = buildDaysMap();
  const todayMonday = mondayOf(S.date);
  const shiftedMonday = (() => {
    const d = new Date(todayMonday + "T00:00:00");
    d.setDate(d.getDate() + weekOffset * 7);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();
  const totals = weekTotals(daysMap, shiftedMonday);
  const maxTotal = Math.max(1, ...totals.map((t) => t.total));
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  document.getElementById("weekLabel").textContent =
    `${shiftedMonday} – ${weekDates(shiftedMonday)[6]}`;

  const chart = document.getElementById("weekChart");
  chart.innerHTML = "";
  totals.forEach((t, i) => {
    const col = document.createElement("div");
    col.className = "col" + (t.date === S.date ? " today" : "");
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.max(2, (t.total / maxTotal) * 100)}px`;
    bar.title = `${DOW[i]} ${t.date}: ${secToHHMM(t.total)}`;
    const dow = document.createElement("div");
    dow.className = "dow";
    dow.textContent = DOW[i];
    col.appendChild(bar);
    col.appendChild(dow);
    chart.appendChild(col);
  });

  document.getElementById("tileToday").textContent = secToHHMM(dayTotal(daysMap[S.date]));
  document.getElementById("tileTotal").textContent = secToHHMM(trackedTotal(daysMap));
  document.getElementById("tileAvg").textContent = secToHHMM(dailyAverage(daysMap));
  document.getElementById("tileAvgSub").textContent = `across ${activeDayCount(daysMap)} active day(s)`;
  const busiest = busiestDay(daysMap);
  document.getElementById("tileBusiest").textContent = busiest ? secToHHMM(busiest.total) : "—";
  document.getElementById("tileBusiestSub").textContent = busiest ? busiest.date : "";

  const renderBreakdown = (containerId, totalsMap, colorFn) => {
    const container = document.getElementById(containerId);
    container.innerHTML = "";
    const entries = Object.entries(totalsMap).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    for (const [name, secs] of entries) {
      const row = document.createElement("div");
      row.className = "breakdownRow";
      row.innerHTML = `<div class="name"></div><div class="bar"><span></span></div><div class="amount"></div>`;
      row.querySelector(".name").textContent = name;
      const bar = row.querySelector(".bar > span");
      bar.style.width = `${(secs / max) * 100}%`;
      if (colorFn) bar.style.background = colorFn(name);
      row.querySelector(".amount").textContent = secToHHMM(secs);
      container.appendChild(row);
    }
  };
  renderBreakdown("byProjectList", byProject(daysMap), projectColor);
  renderBreakdown("byCategoryList", byCategory(daysMap), categoryColor);
}

function renderSettings() {
  document.getElementById("dailyLimitSelect").value = String(S.dailyLimitHours || 8);
  document.getElementById("confirmDeleteToggle").checked = S.confirmBeforeDelete !== false;
  document.getElementById("settingsNameInput").value = S.name || "";
  const ex = document.getElementById("exportBox");
  if (ex) ex.value = buildExportText();
  if (typeof gdRefreshUI === "function") gdRefreshUI();
  const legacy = document.getElementById("gdLegacyWarn");
  if (legacy) legacy.classList.toggle("hidden", !(S.gdLegacyClientAt && Date.now() - S.gdLegacyClientAt < 14 * 864e5));
  renderRecovery();
  renderActivityLog();
}

// ---- Backup / transfer (Task 1: manual bridge, same envelope as the app) ----
async function copyExport() {
  const st = document.getElementById("ioStatus");
  try {
    await navigator.clipboard.writeText(buildExportText());
    st.className = "status ok"; st.textContent = "Copied to clipboard.";
  } catch {
    st.className = "status err"; st.textContent = "Copy failed — select the text and copy manually.";
  }
}
// ---- Restore picker (Drive backups, paste import, local recovery points) ----
//* A restore only ever ADDS the tasks the user ticks ✓; nothing current is removed or overwritten.
let restorePick = null; // { cands, choice[], source, resolve }

async function openRestorePicker(obj, source) {
  if (!obj || typeof obj.days !== "object" || obj.days === null) return { error: "No 'days' data found." };
  const current = TTCore.stateOf(TTData.toDoc(await chrome.storage.local.get(null)));
  const cands = TTCore.restoreCandidates(current, obj);
  if (!cands.length) return { none: true };
  return new Promise((resolve) => {
    restorePick = { cands, choice: cands.map(() => null), source, resolve };
    document.getElementById("restoreTitle").textContent =
      `${cands.length} task(s) in ${source} are not in your data now. Tick ✓ to add a task back, ✗ to leave it out.`;
    document.getElementById("restoreStatus").textContent = "";
    renderRestoreList();
    document.getElementById("restoreOverlay").classList.remove("hidden");
  });
}
function renderRestoreList() {
  const box = document.getElementById("restoreList");
  box.innerHTML = "";
  let lastDate = null;
  restorePick.cands.forEach((c, i) => {
    if (c.date !== lastDate) {
      lastDate = c.date;
      const h = document.createElement("div");
      h.className = "rDate";
      h.textContent = c.date;
      box.appendChild(h);
    }
    const row = document.createElement("div");
    const ch = restorePick.choice[i];
    row.className = "rRow" + (ch === true ? " yes" : ch === false ? " no" : "");
    row.innerHTML = `<span class="rMain"><span class="proj"></span> · <span class="cat"></span><span class="rDesc"></span></span>
      <span class="mono rTime"></span>
      <button class="rYes" title="Add this task back">✓</button><button class="rNo" title="Leave it out">✗</button>`;
    row.querySelector(".proj").textContent = c.entry.project;
    row.querySelector(".cat").textContent = c.entry.category;
    row.querySelector(".rDesc").textContent = c.entry.description;
    row.querySelector(".rTime").textContent = secToHHMM(c.entry.accSec || 0);
    row.querySelector(".rYes").onclick = () => { restorePick.choice[i] = true; renderRestoreList(); };
    row.querySelector(".rNo").onclick = () => { restorePick.choice[i] = false; renderRestoreList(); };
    box.appendChild(row);
  });
  const n = restorePick.choice.filter((x) => x === true).length;
  document.getElementById("restoreApply").textContent = `Add ${n} task(s)`;
}
function closeRestorePicker(result) {
  document.getElementById("restoreOverlay").classList.add("hidden");
  const r = restorePick;
  restorePick = null;
  if (r) r.resolve(result);
}
async function applyRestorePick() {
  const { cands, choice, source } = restorePick;
  const picked = cands.filter((_, i) => choice[i] === true);
  if (!picked.length) {
    const st = document.getElementById("restoreStatus");
    st.className = "status err";
    st.textContent = "Tick ✓ on at least one task, or Cancel.";
    return;
  }
  const added = await mutate((d) => {
    TTData.addRecoveryPoint(d, `before restoring from ${source}`);
    const a = TTCore.applyRestore(d, d.days, picked);
    TTData.log(d, [{ type: "restore", source, added: a.length, skipped: cands.length - picked.length },
      ...a.map((x) => ({ type: "add", id: x.e.id, date: x.date, entry: TTCore.short(x.e), via: "restore" }))]);
    return a.length;
  });
  closeRestorePicker({ added });
  refreshDataViews();
}
function restoreMessage(res, source) {
  if (res.error) return [res.error, "err"];
  if (res.none) return [`Nothing missing — every task in ${source} is already here.`, "ok"];
  if (res.cancelled) return ["Restore cancelled.", ""];
  return [`Added ${res.added} task(s) back from ${source} ✓`, "ok"];
}

async function doImport() {
  const st = document.getElementById("ioStatus");
  st.className = "status";
  let obj;
  try { obj = JSON.parse(document.getElementById("importBox").value); }
  catch { st.className = "status err"; st.textContent = "That's not valid JSON."; return; }
  const res = await openRestorePicker(obj, "the pasted data");
  const [msg, cls] = restoreMessage(res, "the pasted data");
  st.className = "status" + (cls ? " " + cls : "");
  st.textContent = msg;
  if (res.added) document.getElementById("importBox").value = "";
}

// ---- Local recovery points + activity log ----
function renderRecovery() {
  const box = document.getElementById("recoveryList");
  if (!box) return;
  box.innerHTML = "";
  const points = (S.recoveryPoints || []).slice().reverse();
  if (!points.length) { box.innerHTML = '<p class="desc">None yet — one is saved automatically before anything removes tasks.</p>'; return; }
  for (const p of points) {
    const row = document.createElement("button");
    row.className = "gdFile";
    row.innerHTML = `<span class="gdName"></span><span class="gdWhen"></span>`;
    row.querySelector(".gdName").textContent = `${p.reason} (${TTCore.counts(p.env).entries} tasks)`;
    row.querySelector(".gdWhen").textContent = new Date(p.at).toLocaleString();
    row.onclick = async () => {
      const label = "the recovery point from " + new Date(p.at).toLocaleString();
      const [msg, cls] = restoreMessage(await openRestorePicker(p.env, label), label);
      const st = document.getElementById("recoveryStatus");
      st.className = "status" + (cls ? " " + cls : "");
      st.textContent = msg;
    };
    box.appendChild(row);
  }
}
function logText(ev) {
  const what = ev.entry || (ev.from ? `${ev.from} -> ${ev.to}` : "") || ev.reason || ev.detail || ev.status || ev.error || "";
  const extra = ["added", "removed", "changed", "tombstoned", "entries"].filter((k) => ev[k] !== undefined).map((k) => `${k}=${ev[k]}`).join(" ");
  return `${ev.t} [${ev.dev || "?"}] ${ev.type}${ev.date ? " " + ev.date : ""}${ev.source ? " (" + ev.source + ")" : ""} ${what}${ev.reason && ev.entry ? " — " + ev.reason : ""} ${extra}`.trim();
}
function renderActivityLog() {
  const box = document.getElementById("activityLog");
  if (!box) return;
  const log = (S.ttLog || []).slice(-200).reverse();
  box.textContent = log.length ? log.map(logText).join("\n") : "No activity recorded yet.";
}
async function copyActivityLog() {
  const st = document.getElementById("recoveryStatus");
  const text = JSON.stringify({ app: "team-timesheet", deviceId: S.deviceId, device: TTData.DEVICE_NAME, copiedAt: new Date().toISOString(), log: S.ttLog || [] }, null, 1);
  try { await navigator.clipboard.writeText(text); st.className = "status ok"; st.textContent = "Activity log copied — paste it into the issue."; }
  catch { st.className = "status err"; st.textContent = "Copy failed."; }
}

// ---- Google Drive backup/restore (gdrive.js provides the API calls) ----
async function gdRefreshUI() {
  if (typeof gdConnected !== "function") return; // gdrive.js not loaded (e.g. tests)
  if (typeof S === "undefined" || !S || !document.getElementById("gdConnect")) return;
  const connected = await gdConnected();
  const st = document.getElementById("gdStatus");
  document.getElementById("gdConnect").hidden = connected;
  document.getElementById("gdDisconnect").hidden = !connected;
  document.getElementById("gdSyncBtn").disabled = !connected;
  document.getElementById("gdBackup").disabled = !connected;
  document.getElementById("gdRestore").disabled = !connected;
  document.getElementById("gdAutoBackup").checked = !!S.gdAutoBackup;
  if (!connected) { document.getElementById("gdList").classList.add("hidden"); if (st) st.textContent = ""; }
}
function gdSetStatus(msg, cls) {
  const st = document.getElementById("gdStatus");
  st.className = "status" + (cls ? " " + cls : "");
  st.textContent = msg;
}
async function gdDoConnect() {
  gdSetStatus("Connecting…");
  try { await gdToken(true); gdSetStatus("Connected.", "ok"); await gdRefreshUI(); }
  catch (e) { gdSetStatus(e.message || String(e), "err"); }
}
async function gdDoDisconnect() {
  await gdDisconnect();
  gdSetStatus("Disconnected.");
  await gdRefreshUI();
}
async function gdDoSync() {
  gdSetStatus("Syncing…");
  try {
    const r = await gdSync(true);
    gdSetStatus(r || "Done.", "ok");
    await gdRefreshUI();
  } catch (e) { gdSetStatus(e.message || String(e), "err"); }
}
async function gdDoBackup() {
  gdSetStatus("Backing up…");
  try {
    const wrote = await gdBackupNow();
    S.gdLastBackup = todayStr();
    await chrome.storage.local.set({ gdLastBackup: S.gdLastBackup });
    gdSetStatus(wrote ? "Backed up to Google Drive ✓" : "Already up to date — nothing new to back up.", "ok");
    await gdRefreshUI();
  } catch (e) { gdSetStatus(e.message || String(e), "err"); }
}
async function gdDoRestore() {
  gdSetStatus("Loading backups…");
  const listEl = document.getElementById("gdList");
  try {
    const token = await gdToken(true);
    const files = await gdListBackups(token);
    if (!files.length) { gdSetStatus("No backups found in Drive.", "err"); return; }
    gdSetStatus(`${files.length} backup(s) — pick one to review what's missing.`);
    listEl.classList.remove("hidden");
    listEl.innerHTML = "";
    for (const f of files) {
      const when = f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : "";
      const row = document.createElement("button");
      row.className = "gdFile";
      row.innerHTML = `<span class="gdName"></span><span class="gdWhen"></span>`;
      row.querySelector(".gdName").textContent = f.name;
      row.querySelector(".gdWhen").textContent = when;
      row.onclick = async () => {
        gdSetStatus(`Reading ${f.name}…`);
        try {
          const obj = TTCore.parseEnvelope(await gdDownload(token, f.id));
          const res = await openRestorePicker(obj, f.name);
          const [msg, cls] = restoreMessage(res, f.name);
          if (res.added) listEl.classList.add("hidden");
          gdSetStatus(msg, cls);
        } catch (e) { gdSetStatus(e.message || String(e), "err"); }
      };
      listEl.appendChild(row);
    }
  } catch (e) { gdSetStatus(e.message || String(e), "err"); }
}
// Auto-backup once per day, silently, if enabled and already connected.
async function gdMaybeAutoBackup() {
  if (typeof S === "undefined" || !S || !S.gdAutoBackup) return;
  if (S.gdLastBackup === todayStr()) return;
  try {
    await gdBackupNow(false); // throws (and skips) if there's nothing to back up yet
    S.gdLastBackup = todayStr();
    await chrome.storage.local.set({ gdLastBackup: S.gdLastBackup });
  } catch (e) { /* not connected, offline, or nothing to back up — skip quietly */ }
}

async function resetEverything() {
  const inp = document.getElementById("resetConfirmInput");
  const st = document.getElementById("resetStatus");
  //! The typed word is the guard against the misclick that once wiped every device; check it here,
  //! not only via the button's disabled state.
  if (!inp || inp.value.trim() !== "RESET") {
    if (st) { st.className = "status err"; st.textContent = 'Type RESET in the box first.'; }
    return;
  }
  const msg = "Delete all tasks, history, and settings on every synced device? Your name is kept, and a local recovery point is saved first.";
  if (!(await showConfirm(msg, "Yes, reset"))) return;
  await mutate((d) => {
    TTData.addRecoveryPoint(d, "before Reset Everything");
    let n = 0;
    //* Tombstones propagate the reset to other devices instead of them pulling everything back.
    for (const list of Object.values(d.days)) for (const e of list) { TTCore.tombstone(d, e.id); n++; }
    d.days = {};
    d.timer = { activeId: null, startedAt: null };
    Object.assign(d.set, {
      draft: null, lastProject: null, lastCategory: null,
      dailyLimitHours: 8, confirmBeforeDelete: true, theme: "dark", warnedDate: null,
    });
    TTData.log(d, [{ type: "reset", tombstoned: n }]);
  });
  inp.value = "";
  document.getElementById("resetEverything").disabled = true;
  if (st) st.textContent = "";
  document.documentElement.dataset.theme = resolveTheme("dark");
  renderSettings();
  render();          // popup.js — refresh Today panel's entry list
  renderDashboard();
}

function showPanel(name) {
  for (const panel of ["today", "timesheet", "dashboard", "settings"]) {
    document.getElementById("panel" + panel[0].toUpperCase() + panel.slice(1)).classList.toggle("hidden", panel !== name);
    document.getElementById("nav" + panel[0].toUpperCase() + panel.slice(1)).classList.toggle("active", panel === name);
  }
  if (name === "timesheet" && typeof renderTimesheet === "function") renderTimesheet();
  if (name === "dashboard" && typeof renderDashboard === "function") renderDashboard();
  if (name === "settings" && typeof renderSettings === "function") renderSettings();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("navToday").onclick = () => showPanel("today");
  document.getElementById("navTimesheet").onclick = () => showPanel("timesheet");
  document.getElementById("navDashboard").onclick = () => showPanel("dashboard");
  document.getElementById("navSettings").onclick = () => showPanel("settings");
  document.getElementById("weekPrev").onclick = () => { weekOffset--; renderDashboard(); };
  document.getElementById("weekNext").onclick = () => { weekOffset++; renderDashboard(); };
  document.getElementById("tsWeekPrev").onclick = () => { tsWeekOffset--; renderTimesheet(); };
  document.getElementById("tsWeekNext").onclick = () => { tsWeekOffset++; renderTimesheet(); };

  document.getElementById("dailyLimitSelect").onchange = (e) => {
    S.dailyLimitHours = Number(e.target.value);
    chrome.storage.local.set({ dailyLimitHours: S.dailyLimitHours });
  };
  document.getElementById("confirmDeleteToggle").onchange = (e) => {
    S.confirmBeforeDelete = e.target.checked;
    chrome.storage.local.set({ confirmBeforeDelete: S.confirmBeforeDelete });
  };
  document.getElementById("themeDark").onclick = () => applyTheme("dark");
  document.getElementById("themeLight").onclick = () => applyTheme("light");
  document.getElementById("themeSystem").onclick = () => applyTheme("system");
  document.getElementById("resetEverything").onclick = resetEverything;
  document.getElementById("resetConfirmInput").oninput = (e) => {
    document.getElementById("resetEverything").disabled = e.target.value.trim() !== "RESET";
  };
  document.getElementById("restoreApply").onclick = applyRestorePick;
  document.getElementById("restoreCancel").onclick = () => closeRestorePicker({ cancelled: true });
  document.getElementById("restoreAllYes").onclick = () => { restorePick.choice = restorePick.choice.map(() => true); renderRestoreList(); };
  document.getElementById("restoreAllNo").onclick = () => { restorePick.choice = restorePick.choice.map(() => false); renderRestoreList(); };
  document.getElementById("copyLog").onclick = copyActivityLog;
  if (document.getElementById("copyExport")) document.getElementById("copyExport").onclick = copyExport;
  if (document.getElementById("doImport")) document.getElementById("doImport").onclick = doImport;
  if (document.getElementById("gdConnect")) {
    document.getElementById("gdConnect").onclick = gdDoConnect;
    document.getElementById("gdDisconnect").onclick = gdDoDisconnect;
    document.getElementById("gdSyncBtn").onclick = gdDoSync;
    document.getElementById("gdBackup").onclick = gdDoBackup;
    document.getElementById("gdRestore").onclick = gdDoRestore;
    document.getElementById("gdAutoBackup").onchange = async (e) => {
      S.gdAutoBackup = e.target.checked;
      await chrome.storage.local.set({ gdAutoBackup: S.gdAutoBackup });
      if (S.gdAutoBackup) gdMaybeAutoBackup();
    };
    // S loads async in init(); give it a moment, then auto-backup once/day.
    setTimeout(gdMaybeAutoBackup, 1500);
  }
  setupSearchSelect(
    document.getElementById("settingsNameInput"),
    document.getElementById("settingsNameList"),
    () => S.names || []
  );
  document.getElementById("settingsNameInput").addEventListener("change", async () => {
    S.name = document.getElementById("settingsNameInput").value;
    await chrome.storage.local.set({ name: S.name });
    route(); // refresh Today panel (popup.js)
  });
});
