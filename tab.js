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
// buildDaysMap / buildExportText / applyBackupData live in popup.js now (shared
// with the popup and gdrive.js sync). tab.js just uses them as globals.

let weekOffset = 0; // 0 = week containing today, -1 = previous week, etc.

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
// Apply a parsed backup envelope (same shape as buildExportText / the app's
// export). Confirms first, overwrites all tracked data, returns the day count
// (or null if invalid / cancelled). Shared by paste-import and Drive-restore.
async function applyImport(obj) {
  if (!obj || typeof obj.days !== "object" || obj.days === null) return { error: "No 'days' data found." };
  const n = Object.keys(obj.days).length;
  if (!(await showConfirm(`Replace all tracked data with this backup (${n} day(s))? Current data is overwritten.`, "Yes, restore"))) {
    return { cancelled: true };
  }
  await applyBackupData(obj); // popup.js — overwrite + refresh views
  return { n };
}

async function doImport() {
  const st = document.getElementById("ioStatus");
  st.className = "status";
  let obj;
  try { obj = JSON.parse(document.getElementById("importBox").value); }
  catch { st.className = "status err"; st.textContent = "That's not valid JSON."; return; }
  const res = await applyImport(obj);
  if (res.error) { st.className = "status err"; st.textContent = res.error; return; }
  if (res.cancelled) return;
  document.getElementById("importBox").value = "";
  st.className = "status ok"; st.textContent = `Imported ${res.n} day(s).`;
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
    const token = await gdToken(true);
    await gdBackupNow(token, buildExportText());
    S.gdLastBackup = todayStr();
    await chrome.storage.local.set({ gdLastBackup: S.gdLastBackup });
    gdSetStatus("Backed up to Google Drive ✓", "ok");
  } catch (e) { gdSetStatus(e.message || String(e), "err"); }
}
async function gdDoRestore() {
  gdSetStatus("Loading backups…");
  const listEl = document.getElementById("gdList");
  try {
    const token = await gdToken(true);
    const files = await gdListBackups(token);
    if (!files.length) { gdSetStatus("No backups found in Drive.", "err"); return; }
    gdSetStatus(`${files.length} backup(s) — pick one to restore.`);
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
        gdSetStatus(`Restoring ${f.name}…`);
        try {
          const text = await gdDownload(token, f.id);
          const res = await applyImport(JSON.parse(text));
          if (res.error) { gdSetStatus(res.error, "err"); return; }
          if (res.cancelled) { gdSetStatus("Restore cancelled."); return; }
          listEl.classList.add("hidden");
          gdSetStatus(`Restored ${res.n} day(s) from ${f.name} ✓`, "ok");
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
    const token = await gdToken(false); // silent — no prompt on load
    await gdBackupNow(token, buildExportText());
    S.gdLastBackup = todayStr();
    await chrome.storage.local.set({ gdLastBackup: S.gdLastBackup });
  } catch (e) { /* not connected or offline — skip quietly */ }
}

async function resetEverything() {
  const msg = "Delete all tasks, history, and settings? This cannot be undone. Your name is kept.";
  if (!(await showConfirm(msg, "Yes, reset"))) return;
  S.entries = [];
  S.history = {};
  S.timer = { activeId: null, startedAt: null };
  S.draft = null;
  S.lastProject = null;
  S.lastCategory = null;
  S.dailyLimitHours = 8;
  S.confirmBeforeDelete = true;
  S.theme = "dark";
  S.warnedDate = null;
  await chrome.storage.local.set({
    entries: [], history: {}, timer: S.timer, draft: null,
    lastProject: null, lastCategory: null,
    dailyLimitHours: 8, confirmBeforeDelete: true, theme: "dark", warnedDate: null,
  });
  document.documentElement.dataset.theme = resolveTheme("dark");
  renderSettings();
  render();          // popup.js — refresh Today panel's entry list
  renderDashboard();
}

function showPanel(name) {
  for (const panel of ["today", "dashboard", "settings"]) {
    document.getElementById("panel" + panel[0].toUpperCase() + panel.slice(1)).classList.toggle("hidden", panel !== name);
    document.getElementById("nav" + panel[0].toUpperCase() + panel.slice(1)).classList.toggle("active", panel === name);
  }
  if (name === "dashboard" && typeof renderDashboard === "function") renderDashboard();
  if (name === "settings" && typeof renderSettings === "function") renderSettings();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("navToday").onclick = () => showPanel("today");
  document.getElementById("navDashboard").onclick = () => showPanel("dashboard");
  document.getElementById("navSettings").onclick = () => showPanel("settings");
  document.getElementById("weekPrev").onclick = () => { weekOffset--; renderDashboard(); };
  document.getElementById("weekNext").onclick = () => { weekOffset++; renderDashboard(); };

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
