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
});
