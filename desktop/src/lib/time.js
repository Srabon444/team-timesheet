// Ported from the Chrome extension's popup.js — same rounding rules.
export const pad = (n) => String(n).padStart(2, "0");

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dateToStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}

export function secToHHMM(sec) {
  let m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return `${pad(h)}:${pad(m % 60)}`;
}

export function secToHHMMSS(sec) {
  sec = Math.floor(sec);
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}

// Compact display like Trackabi's day cards: "0:00", "1:38"
export function secToHMM(sec) {
  let m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return `${h}:${pad(m % 60)}`;
}

export function hhmmToSec(str) {
  const [h, m] = String(str).split(":").map((x) => parseInt(x, 10) || 0);
  return (h * 60 + m) * 60;
}

// Day-strip window: the 7 days ending at `endDate` (matches the reference
// screenshots: Sat Jul 4 .. Fri Jul 10 when today is Fri Jul 10).
export function stripDates(endDate) {
  const out = [];
  for (let i = 6; i >= 0; i--) out.push(addDays(endDate, -i));
  return out;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return { dow: DOW[d.getDay()], md: `${MONTHS[d.getMonth()]} ${d.getDate()}` };
}

export function longDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const DOWL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const ML = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${DOWL[d.getDay()]}, ${ML[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
