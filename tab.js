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
function buildDaysMap() {
  return { ...S.history, [S.date]: S.entries.map((e) => ({ ...e, accSec: elapsedSec(e) })) };
}

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
  renderBreakdown("byProjectList", byProject(daysMap));
  renderBreakdown("byCategoryList", byCategory(daysMap), categoryColor);
}

function renderSettings() {
  document.getElementById("dailyLimitSelect").value = String(S.dailyLimitHours || 8);
  document.getElementById("confirmDeleteToggle").checked = S.confirmBeforeDelete !== false;
  document.getElementById("settingsNameInput").value = S.name || "";
  const ex = document.getElementById("exportBox");
  if (ex) ex.value = buildExportText();
}

// ---- Backup / transfer (Task 1: manual bridge, same envelope as the app) ----
function buildExportText() {
  return JSON.stringify(
    { app: "team-timesheet", v: 1, exportedAt: Date.now(), name: S.name || "", days: buildDaysMap() },
    null, 2
  );
}
async function copyExport() {
  const st = document.getElementById("ioStatus");
  try {
    await navigator.clipboard.writeText(buildExportText());
    st.className = "status ok"; st.textContent = "Copied to clipboard.";
  } catch {
    st.className = "status err"; st.textContent = "Copy failed — select the text and copy manually.";
  }
}
async function doImport() {
  const st = document.getElementById("ioStatus");
  st.className = "status";
  let obj;
  try { obj = JSON.parse(document.getElementById("importBox").value); }
  catch { st.className = "status err"; st.textContent = "That's not valid JSON."; return; }
  if (!obj || typeof obj.days !== "object" || obj.days === null) {
    st.className = "status err"; st.textContent = "No 'days' data found in that text."; return;
  }
  const n = Object.keys(obj.days).length;
  if (!(await showConfirm(`Replace all tracked data with this import (${n} day(s))? Current data is overwritten.`, "Yes, import"))) return;
  const today = todayStr();
  const history = {};
  let todays = [];
  for (const [date, list] of Object.entries(obj.days)) {
    const clean = (Array.isArray(list) ? list : []).map((e) => ({
      id: e.id || crypto.randomUUID(),
      project: e.project, category: e.category, description: e.description,
      accSec: e.accSec || 0, submitted: !!e.submitted,
    }));
    if (date === today) todays = clean; else history[date] = clean;
  }
  S.history = history;
  S.entries = todays;
  S.timer = { activeId: null, startedAt: null }; // never import a running timer
  S.date = today;
  if (obj.name && !S.name) S.name = obj.name;
  await chrome.storage.local.set({
    history: S.history, entries: S.entries, timer: S.timer, date: today, name: S.name,
  });
  document.getElementById("importBox").value = "";
  st.className = "status ok"; st.textContent = `Imported ${n} day(s).`;
  renderSettings();
  render();          // popup.js — refresh Today panel
  renderDashboard();
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
