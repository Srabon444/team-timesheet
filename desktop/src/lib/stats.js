// Ported verbatim from the Chrome extension's tab.js — pure functions over a
// daysMap: { "YYYY-MM-DD": [ { project, category, accSec, ... } ] }.
import { pad } from "./time.js";

export function dayTotal(entries) {
  return (entries || []).reduce((sum, e) => sum + (e.accSec || 0), 0);
}
export function trackedTotal(daysMap) {
  return Object.values(daysMap).reduce((sum, entries) => sum + dayTotal(entries), 0);
}
export function activeDayCount(daysMap) {
  return Object.values(daysMap).filter((entries) => entries.length > 0).length;
}
export function dailyAverage(daysMap) {
  const days = activeDayCount(daysMap);
  return days === 0 ? 0 : Math.round(trackedTotal(daysMap) / days);
}
export function busiestDay(daysMap) {
  const dates = Object.keys(daysMap).sort().reverse(); // most-recent first, for tie-breaking
  let best = null;
  for (const date of dates) {
    const total = dayTotal(daysMap[date]);
    if (!best || total > best.total) best = { date, total };
  }
  return best;
}
export function byProject(daysMap) {
  const out = {};
  for (const entries of Object.values(daysMap)) {
    for (const e of entries) out[e.project] = (out[e.project] || 0) + (e.accSec || 0);
  }
  return out;
}
export function byCategory(daysMap) {
  const out = {};
  for (const entries of Object.values(daysMap)) {
    for (const e of entries) out[e.category] = (out[e.category] || 0) + (e.accSec || 0);
  }
  return out;
}
export function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function weekDates(mondayStr) {
  const d = new Date(mondayStr + "T00:00:00");
  const out = [];
  for (let i = 0; i < 7; i++) {
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}
export function weekTotals(daysMap, mondayStr) {
  return weekDates(mondayStr).map((date) => ({ date, total: dayTotal(daysMap[date]) }));
}
