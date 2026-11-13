"use strict";

// The "Create entry" subform (Project/Category live here, not the main form) —
// same site as FORM_URL, fetched separately for "Fetch projects" (Task: keep
// the Project/Category lists in sync with the live form instead of frozen at
// whatever they were when this file was last edited).
const SUBFORM_URL = "https://techzu.fillout.com/t/kwgd21pozYus";
// Fallback used until the user fetches the live lists at least once (then
// S.projects/S.categories from storage take over — see currentProjects()).
const DEFAULT_PROJECTS = ["Bookland ERP", "Builder Alliance", "Dr Cool", "Hydroflux", "NewERP",
  "Prowork", "Rina CRM", "SME Taskhub", "VSB", "Worksite Mini ERP", "ZuPOS"];
const DEFAULT_CATEGORIES = ["Meeting (General)", "Meeting (Technical)", "Development",
  "Code Review", "Miscellaneous"];
function currentProjects() { return (S.projects && S.projects.length) ? S.projects : DEFAULT_PROJECTS; }
function currentCategories() { return (S.categories && S.categories.length) ? S.categories : DEFAULT_CATEGORIES; }
// Category color coding, matching the reference screenshots' Topic badges.
const CATEGORY_COLORS = {
  "Meeting (General)": "#f59e0b",
  "Meeting (Technical)": "#38bdf8",
  "Development": "#8b5cf6",
  "Code Review": "#22c55e",
  "Miscellaneous": "#ef4444",
};
const CATEGORY_FALLBACK_COLOR = "#64748b"; // any category not in the map above
function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || CATEGORY_FALLBACK_COLOR;
}
// Project color coding — one distinct hue per project, spread across a
// different part of the palette than the categories above so the two badge
// kinds stay visually distinguishable sitting side by side.
const PROJECT_COLORS = {
  "Bookland ERP": "#ec4899",
  "Builder Alliance": "#14b8a6",
  "Dr Cool": "#06b6d4",
  "Hydroflux": "#6366f1",
  "NewERP": "#a855f7",
  "Prowork": "#84cc16",
  "Rina CRM": "#f97316",
  "SME Taskhub": "#0ea5e9",
  "VSB": "#d946ef",
  "Worksite Mini ERP": "#10b981",
  "ZuPOS": "#eab308",
};
const PROJECT_FALLBACK_COLOR = "#64748b"; // any project not in the map above
function projectColor(project) {
  return PROJECT_COLORS[project] || PROJECT_FALLBACK_COLOR;
}

var S = {}; // { name, names, date, lastCategory, entries[], timer:{activeId,startedAt} }
let tick = null;
// Which day the main view is showing/editing. Today uses the live S.entries;
// any past day reads/writes S.history[viewDate] so you can back-fill entries
// the same way the desktop app lets you (Task 4b).
var viewDate = null;
// Copy Tasks (Req 1): copyMode toggles the checkbox column; copySelected
// tracks which entry ids (of the viewed day) are picked for copying.
let copyMode = false;
let copySelected = new Set();

// ---------- utils ----------
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// The day currently shown in the main view. The "live" day is S.date (the
// day S.entries belongs to — kept == todayStr() by init()'s daily reset);
// any other day reads/writes that day's archived list.
function isTodayView() {
  return viewDate === S.date;
}
function currentEntries() {
  return isTodayView() ? S.entries : (S.history[viewDate] || []);
}
function secToHHMM(sec) {
  let m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return `${pad(h)}:${pad(m % 60)}`;
}
function secToHHMMSS(sec) {
  sec = Math.floor(sec);
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
function hhmmToSec(str) {
  const [h, m] = String(str).split(":").map((x) => parseInt(x, 10) || 0);
  return (h * 60 + m) * 60;
}
// ---------- time picker (hrs/min selects, same widget as the desktop app) ----------
function timeOptions(count, suffix, selected) {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += `<option value="${i}"${i === selected ? " selected" : ""}>${pad(i)} ${suffix}</option>`;
  }
  return out;
}
//! Hours run past 23 when a timer was left going overnight, so the list grows
//! to fit instead of clamping — a select that can't show 26:15 would silently
//! rewrite the entry the moment it fires a change.
function timePickInnerHTML(sec) {
  const mins = Math.round(sec / 60);
  const h = Math.floor(mins / 60);
  return `<select class="thrs" aria-label="Hours">${timeOptions(Math.max(24, h + 1), "hrs", h)}</select>
      <span class="colon">:</span>
      <select class="tmins" aria-label="Minutes">${timeOptions(60, "min", mins % 60)}</select>`;
}
function pickHHMM(root) {
  return `${pad(parseInt(root.querySelector(".thrs").value, 10))}:${pad(parseInt(root.querySelector(".tmins").value, 10))}`;
}
function setPickTime(root, sec) {
  root.innerHTML = timePickInnerHTML(sec);
}
//! The live tick calls this every second on the running row. It sets values in
//! place — an innerHTML rewrite would replace the selects, and once replaced
//! the row's time could no longer be edited at all.
function syncPickTime(root, sec) {
  const mins = Math.round(sec / 60);
  const h = Math.floor(mins / 60);
  const hrs = root.querySelector(".thrs");
  if (!hrs) return;
  for (let i = hrs.options.length; i <= h; i++) {   // timer crossed into an hour the list doesn't have yet
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${pad(i)} hrs`;
    hrs.appendChild(opt);
  }
  hrs.value = String(h);
  root.querySelector(".tmins").value = String(mins % 60);
}
//* The add form doubles as the edit form, so these two read/write whichever
//* entry is being worked on.
function formTimeStr() {
  const el = $("timePick");
  return el && el.querySelector(".thrs") ? pickHHMM(el) : "00:00";
}
function setFormTime(str) {
  const el = $("timePick");
  if (el) setPickTime(el, hhmmToSec(str));
}
function resolveTheme(theme) {
  if (theme === "system") {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}
function applyTheme(theme) {
  S.theme = theme;
  document.documentElement.dataset.theme = resolveTheme(theme);
  chrome.storage.local.set({ theme });
}

// ---------- storage / state ----------
//* S is a read-only cache of chrome.storage.local for rendering. Every change to tracked data goes
//* through mutate() (TTData.withData: cross-window lock + fresh read + one write), never through S,
//* so a window's stale copy can never overwrite what another window or a sync just wrote.
function adopt(written) {
  for (const [k, v] of Object.entries(written || {})) S[k] = v;
  S.entries = S.entries || [];
  S.history = S.history || {};
  S.timer = S.timer || { activeId: null, startedAt: null };
  S.submittedDays = S.submittedDays || {};
  S.deletedEntries = S.deletedEntries || {};
}
async function mutate(fn) {
  const { result, written } = await TTData.withData(fn);
  adopt(written);
  return result;
}
// TTData rolls storage over to today on any write; this only makes an idle window notice.
// Returns true if the day changed.
async function rollDayIfNeeded() {
  const today = todayStr();
  const stored = (await chrome.storage.local.get("date")).date;
  if (S.date === today && stored === today) return false;
  const before = S.date;
  await mutate(() => {});
  return before !== S.date;
}
// Background trigger (timer/visibilitychange) for rollDayIfNeeded() — those
// fire outside any click handler that would otherwise call render() itself,
// and outside a user action that would otherwise reset viewDate.
async function checkDayRollover() {
  const wasViewingToday = viewDate === S.date;
  const rolled = await rollDayIfNeeded();
  if (!rolled) return;
  if (wasViewingToday) viewDate = S.date;
  const main = $("main");
  if (S.name && main && !main.classList.contains("hidden")) {
    if ($("whoDate")) $("whoDate").textContent = S.date;
    updateDayNav();
    refreshAddForm();
    render();
  }
}
async function init() {
  S = await chrome.storage.local.get(null);
  adopt();
  S.confirmBeforeDelete = S.confirmBeforeDelete === undefined ? true : S.confirmBeforeDelete;
  const dailyLimitWasUnset = S.dailyLimitHours === undefined;
  S.dailyLimitHours = S.dailyLimitHours || 8;
  // background.js reads dailyLimitHours from storage directly (separate realm),
  // so the default must be persisted here, not just held in memory.
  if (dailyLimitWasUnset) await chrome.storage.local.set({ dailyLimitHours: S.dailyLimitHours });
  S.warnedDate = S.warnedDate === undefined ? null : S.warnedDate;
  S.theme = S.theme || "dark";
  //* First run on this device, or a day boundary crossed while closed: the data layer settles both.
  if (!S.deviceId || S.date !== todayStr()) await mutate(() => {});
  document.documentElement.dataset.theme = resolveTheme(S.theme);
  route();
  // Cross-device sync: silently merge with Google Drive on open (if connected).
  if (typeof gdSync === "function") gdSync(false).catch(() => {});
  //* Refreshes the cached month when it rolls over; a no-op the rest of the time.
  if (typeof prayerEnsureMonth === "function") prayerEnsureMonth().then(renderPrayerRow).catch(() => {});
  //! The row shows a countdown, so it goes stale in tab.html, which stays open all day.
  setInterval(renderPrayerRow, 60000);
  //! A window (esp. tab.html, left open for hours) never otherwise notices the
  //! wall clock crossing into a new day on its own. The interval is the fallback;
  //! visibilitychange catches it the instant the user looks back at the tab.
  setInterval(checkDayRollover, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkDayRollover(); });
  // Keep Names/Project/Category in sync with the live form on every open
  // instead of requiring a manual click — same silent-refresh idea as gdSync above.
  loadNames(true).catch(() => {});
  loadProjectsAndCategories(true).catch(() => {});
}

// ---------- timer engine (one active at a time) ----------
function elapsedSec(e) {
  let s = e.accSec || 0;
  if (S.timer.activeId === e.id && S.timer.startedAt) s += (Date.now() - S.timer.startedAt) / 1000;
  return s;
}
async function startTimer(id) {
  await mutate((d) => {
    TTData.foldTimer(d); // stops any other running timer
    d.timer = { activeId: id, startedAt: Date.now() };
  });
  render();
}
async function pauseTimer() {
  await mutate((d) => {
    const e = d.timer.activeId && TTData.find(d, d.date, d.timer.activeId);
    TTData.foldTimer(d);
    if (e) TTData.log(d, [{ type: "timer-stop", id: e.id, date: d.date, entry: TTCore.short(e) }]);
  });
  render();
}
async function editTime(id, str) {
  const date = viewDate;
  await mutate((d) => {
    const e = TTData.find(d, date, id);
    if (!e) return;
    const from = TTCore.short(e);
    e.accSec = hhmmToSec(str);
    TTCore.touch(d, e);
    if (date === d.date && d.timer.activeId === id) d.timer.startedAt = Date.now(); // rebase running timer
    TTData.log(d, [{ type: "edit-time", id, date, from, to: TTCore.short(e) }]);
  });
  //! Editing a row's time used to leave the day total stale — every other
  //! mutation re-renders, this one only needs the total refreshed (a full
  //! render would rebuild the selects and drop focus mid-edit).
  updateDayTotal();
}

// ---------- views ----------
function route() {
  if (S.name) showMain();
  else showSetup();
}
function showSetup() {
  $("setup").classList.remove("hidden");
  $("main").classList.add("hidden");
  $("setupStatus").textContent = "";
  if (S.names && S.names.length) {
    $("nameSelect").value = S.name || "";
    $("setupPicker").classList.remove("hidden");
    $("nameSelect").focus();
  } else {
    $("setupPicker").classList.add("hidden");
    $("loadNames").focus();
  }
}
function showMain() {
  $("setup").classList.add("hidden");
  $("main").classList.remove("hidden");
  $("whoName").textContent = S.name;
  $("whoDate").textContent = S.date;
  viewDate = S.date;
  fillSelect($("catSelect"), currentCategories());
  updateDayNav();
  refreshAddForm();
  render();
  showFillStatus(S.fillStatus);
  $("projSelect").focus();
}

// Day navigation for the main view (Task 4b: browse/back-fill past days).
function updateDayNav() {
  const inp = $("viewDateInput");
  if (inp) { inp.value = viewDate; inp.max = S.date; }
  const heading = $("dayHeading");
  if (heading) heading.textContent = isTodayView() ? "Today's projects" : `Projects — ${viewDate}`;
  const t = $("todayBtn");
  if (t) t.classList.toggle("hidden", isTodayView());
  const next = $("dayNext");
  if (next) next.disabled = isTodayView(); // no future days
  updateSubmittedUI();
}

// ---- Day-submitted marking (Task 7: auto + manual, display only) ----
function daySubmitted(date) {
  return TTCore.isMarked(S.submittedDays && S.submittedDays[date]);
}
// Neither of these pushes to Drive/the dashboard itself: the storage write below fires
// storage.onChanged, which does the ingest push, and gdSyncNow() does the Drive write.
async function markDaySubmitted(date, method) {
  await mutate((d) => {
    TTCore.setSubmitted(d, date, method);
    TTData.log(d, [{ type: "mark-submitted", date, method }]);
  });
  updateSubmittedUI();
  await gdSyncNow();
  //* Dated snapshot of the moment this day was marked. Non-interactive and best-effort: the
  //* rolling timesheet-latest.json written by gdSyncNow() above is the copy that actually matters.
  if (typeof gdBackupNow === "function") gdBackupNow(false).catch(() => {});
  if (method === "manual") await nudgeGoogleSignIn();
}
//! Unmark is a stamped {method:null}, never a deleted key — the merge keeps the newest value per
//! day, so an absent key would lose to another device's older mark and the day would come back.
async function unmarkDaySubmitted(date) {
  await mutate((d) => {
    TTCore.setSubmitted(d, date, null);
    TTData.log(d, [{ type: "unmark-submitted", date }]);
  });
  updateSubmittedUI();
  await gdSyncNow();
}
//! Never blocks the mark — the day is already saved. Points at the full view because an
//! interactive getAuthToken() from the popup tears the popup down mid-prompt.
async function nudgeGoogleSignIn() {
  if (typeof gdConnected !== "function" || (await gdConnected())) return;
  const go = await showDialog(
    "Marked submitted on this device only.\n\n" +
      "Signing in to Google backs this day up to your Drive and sends it to the team dashboard. " +
      "Open the full view to sign in?",
    "Open full view"
  );
  if (go === "yes") await openFullView();
}
function updateSubmittedUI() {
  const state = $("daySubmitState");
  if (!state) return;
  const done = daySubmitted(viewDate);
  state.textContent = done ? "✅ Submitted" : "⬜ Not submitted";
  state.className = "submitState" + (done ? " done" : "");
  const btn = $("markSubmitBtn");
  if (btn) {
    btn.textContent = done ? "Unmark" : "Mark submitted";
    // Nothing to mark submitted if there's no entries for this day —
    // unmarking stays available so a wrong mark can always be undone.
    btn.disabled = !done && currentEntries().length === 0;
  }
  //! A submitted day can't be re-filled without unmarking first — Unmark right next to it is the
  //! only escape, which is why its tombstone has to actually survive a Drive sync.
  const fs = $("finalSubmit");
  if (fs) {
    fs.disabled = done;
    fs.title = done ? "This day is marked submitted — unmark it first to re-fill the form." : "";
  }
}
function setViewDate(dateStr) {
  if (!dateStr || dateStr > S.date) dateStr = S.date; // never past the live day
  viewDate = dateStr;
  clearDraft(); // drop any in-progress edit when changing days
  copyMode = false; // selection was scoped to the day we're leaving
  copySelected.clear();
  if ($("copyStatus")) $("copyStatus").textContent = "";
  updateDayNav();
  render();
}
// Reflect S.draft into the add-form (survives popup close / tab switch).
// draft = { project, category, description, editingId }
function refreshAddForm() {
  //! Drop a stale edit target that was deleted. Looked up in the day on screen: checking only
  //! today's list used to throw away every edit of a past day's task, so the form never filled.
  if (S.draft && S.draft.editingId && !currentEntries().some((e) => e.id === S.draft.editingId)) S.draft = null;
  const d = S.draft;
  $("projSelect").value = (d && d.project) || S.lastProject || currentProjects()[0];
  fillSelect($("catSelect"), currentCategories(), (d && d.category) || S.lastCategory || currentCategories()[0]);
  $("descInput").value = (d && d.description) || "";
  setFormTime((d && d.time) || "00:00");
  const editing = !!(d && d.editingId);
  $("addProject").textContent = editing ? "Save changes" : "+ Add Project";
  $("cancelEdit").classList.toggle("hidden", !editing);
}
function saveDraft() {
  S.draft = {
    project: $("projSelect").value,
    category: $("catSelect").value,
    description: $("descInput").value,
    time: formTimeStr(),
    editingId: (S.draft && S.draft.editingId) || null,
  };
  chrome.storage.local.set({ draft: S.draft });
}
//* duplicate=true loads the task as a NEW one (time 00:00) instead of editing it in place.
function startEdit(id, duplicate) {
  const e = currentEntries().find((x) => x.id === id);
  if (!e) return;
  S.draft = {
    project: e.project, category: e.category, description: e.description,
    time: duplicate ? "00:00" : secToHHMM(elapsedSec(e)), editingId: duplicate ? null : id,
  };
  chrome.storage.local.set({ draft: S.draft });
  refreshAddForm();
  $("addStatus").textContent = "";
  $("descInput").focus();
}
function clearDraft() {
  S.draft = null;
  chrome.storage.local.set({ draft: null });
  $("addStatus").textContent = "";
  refreshAddForm();
}
// Custom confirm modal — window.confirm() is unreliable inside extension
// popups (can render cropped/off-screen and Chrome may tear down the popup
// before a click registers), so use an in-DOM overlay instead.
function showConfirm(message, yesLabel) {
  return showDialog(message, yesLabel || "Yes, submit").then((r) => r === "yes");
}
function showDialog(message, yesLabel) {
  return new Promise((resolve) => {
    $("confirmMsg").textContent = message;
    $("confirmYes").textContent = yesLabel;
    $("confirmOverlay").classList.remove("hidden");
    const done = (result) => {
      $("confirmOverlay").classList.add("hidden");
      $("confirmYes").onclick = null;
      $("confirmNo").onclick = null;
      resolve(result);
    };
    $("confirmYes").onclick = () => done("yes");
    $("confirmNo").onclick = () => done("cancel");
  });
}
//! Rebuilding the options resets a select to its first one. The live category fetch on every open
//! does that after the form is filled, so an edit silently saved the wrong category. Keep the
//! value, and keep it as an option even when the live list no longer has it (an older task).
function fillSelect(sel, items, value = sel.value) {
  sel.innerHTML = "";
  for (const it of value && !items.includes(value) ? [...items, value] : items) {
    const o = document.createElement("option");
    o.value = it;
    o.textContent = it;
    sel.appendChild(o);
  }
  if (value) sel.value = value;
}

// Searchable combobox: a plain <input> so .value stays fully compatible with
// existing get/set call sites (same API a native <select> gave them), plus a
// dropdown list that filters by substring (not just first-letter jump like a
// native <select>). Click or Enter selects; Escape/blur-without-a-match
// reverts to whatever was there before focus.
function setupSearchSelect(input, listEl, getOptions) {
  let hi = -1;
  let beforeFocus = "";
  function render(filter) {
    const q = (filter || "").toLowerCase();
    const matches = getOptions().filter((o) => o.toLowerCase().includes(q));
    listEl.innerHTML = "";
    matches.forEach((o, i) => {
      const row = document.createElement("div");
      row.className = "searchItem" + (i === hi ? " hi" : "");
      row.textContent = o;
      row.onmousedown = (e) => { e.preventDefault(); pick(o); };
      listEl.appendChild(row);
    });
    listEl.classList.toggle("hidden", matches.length === 0);
    return matches;
  }
  function pick(v) {
    input.value = v;
    listEl.classList.add("hidden");
    hi = -1;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function setHi(rows) {
    rows.forEach((r, i) => r.classList.toggle("hi", i === hi));
    if (rows[hi]) rows[hi].scrollIntoView({ block: "nearest" });
  }
  // Focus only places the cursor (e.g. programmatic autofocus on page load) —
  // it must NOT pop the list open on its own. The list opens on an explicit
  // click, or as soon as the user starts typing.
  input.addEventListener("focus", () => { beforeFocus = input.value; input.select(); });
  input.addEventListener("click", () => render(input.value === beforeFocus ? "" : input.value));
  input.addEventListener("input", () => { hi = -1; render(input.value); });
  input.addEventListener("keydown", (e) => {
    const rows = [...listEl.children];
    if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hi + 1, rows.length - 1); setHi(rows); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(hi - 1, 0); setHi(rows); }
    else if (e.key === "Enter") { e.preventDefault(); const r = rows[hi] || rows[0]; if (r) pick(r.textContent); }
    else if (e.key === "Escape") { input.value = beforeFocus; listEl.classList.add("hidden"); input.blur(); }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      listEl.classList.add("hidden");
      const exact = getOptions().find((o) => o.toLowerCase() === input.value.toLowerCase());
      input.value = exact || beforeFocus;
    }, 120);
  });
}

function viewTotalSec() {
  return currentEntries().reduce((sum, e) => sum + elapsedSec(e), 0);
}
function updateDayTotal() {
  const totalEl = $("dayTotal");
  if (totalEl) totalEl.textContent = secToHHMM(viewTotalSec());
}

// ---------- render entries ----------
function render() {
  const box = $("entries");
  box.innerHTML = "";
  const list = currentEntries();
  const todayView = isTodayView();
  $("emptyMsg").classList.toggle("hidden", list.length > 0);
  updateDayTotal();
  updateSubmittedUI();
  updateCopyBar();
  for (const e of list) {
    const active = todayView && S.timer.activeId === e.id;
    const div = document.createElement("div");
    div.className = "entry" + (active ? " active" : "");
    div.innerHTML = `
      <div class="row1">
        <div>
          ${copyMode ? `<input type="checkbox" class="copyChk" ${copySelected.has(e.id) ? "checked" : ""}>` : ""}
          <span class="statusDot"></span>
          <span class="pname"></span>
          <span class="cat"></span>
          ${e.submitted ? '<span class="submittedBadge">Submitted</span>' : ""}
        </div>
        <div class="acts">
          <button class="dup" title="Duplicate">⧉</button>
          <button class="edit" title="Edit">✎</button>
          <button class="del" title="Delete">&times;</button>
        </div>
      </div>
      <div class="desc"></div>
      <div class="row2">
        ${todayView ? `<button class="tbtn ${active ? "playing" : ""}">${active ? "❚❚" : "▶"}</button>` : ""}
        <span class="timepick">${timePickInnerHTML(elapsedSec(e))}</span>
        <span class="live">${active ? secToHHMMSS(elapsedSec(e)) : ""}</span>
      </div>`;
    if (copyMode) div.querySelector(".copyChk").onchange = (ev) => toggleCopySelect(e.id, ev.target.checked);
    div.querySelector(".statusDot").style.background = active ? "var(--success)" : "var(--text-muted)";
    const pnameEl = div.querySelector(".pname");
    pnameEl.textContent = e.project;
    pnameEl.style.background = projectColor(e.project);
    const catEl = div.querySelector(".cat");
    catEl.textContent = e.category;
    catEl.style.background = categoryColor(e.category);
    div.querySelector(".desc").textContent = e.description;
    const tbtn = div.querySelector(".tbtn");
    if (tbtn) tbtn.onclick = () => (active ? pauseTimer() : startTimer(e.id));
    div.querySelector(".dup").onclick = () => startEdit(e.id, true);
    div.querySelector(".edit").onclick = () => startEdit(e.id);
    div.querySelector(".del").onclick = () => deleteEntry(e.id);
    const pick = div.querySelector(".timepick");
    pick.onchange = () => editTime(e.id, pickHHMM(pick));
    box.appendChild(div);
  }
  startTick();
}
async function deleteEntry(id) {
  if (S.confirmBeforeDelete !== false) {
    if (!(await showConfirm("Delete this project entry?", "Yes, delete"))) return;
  }
  const date = viewDate;
  await mutate((d) => {
    const list = TTData.list(d, date);
    const idx = list.findIndex((x) => x.id === id);
    const gone = idx >= 0 ? list.splice(idx, 1)[0] : null;
    if (d.timer.activeId === id) d.timer = { activeId: null, startedAt: null };
    //! Tombstone even when it's already gone here — another device may still hold a copy.
    TTCore.tombstone(d, id);
    TTData.log(d, [{ type: "delete", id, date, entry: gone ? TTCore.short(gone) : "(not present locally)" }]);
  });
  render();
}
// ---------- Copy Tasks (Req 1) ----------
function toggleCopyMode() {
  copyMode = !copyMode;
  if (!copyMode) copySelected.clear();
  if ($("copyStatus")) $("copyStatus").textContent = "";
  render();
}
function toggleCopySelect(id, checked) {
  if (checked) copySelected.add(id);
  else copySelected.delete(id);
  updateCopyBar();
}
function updateCopyBar() {
  const modeBtn = $("copyModeBtn");
  if (modeBtn) modeBtn.textContent = copyMode ? "Cancel" : "Copy Tasks";
  const toBtn = $("copyToBtn");
  if (toBtn) {
    toBtn.classList.toggle("hidden", !copyMode || copySelected.size === 0);
    toBtn.textContent = `Copy to (${copySelected.size})`;
  }
}
function openCopyToDialog() {
  if (!copySelected.size) return;
  const inp = $("copyToDate");
  inp.min = S.date;
  inp.value = S.date;
  $("copyToStatus").textContent = "";
  $("copyToOverlay").classList.remove("hidden");
}
// Copies are always fresh: new id, accSec reset to 0, no submitted flag —
// same shape submitDraft() already pushes for a brand-new entry.
async function confirmCopyTo() {
  const target = $("copyToDate").value;
  const st = $("copyToStatus");
  // Mirror the native <input min> guard — it's the only affordance stopping
  // a past date, so re-check here rather than trust it unconditionally.
  if (!target || target < S.date) {
    st.className = "status err";
    st.textContent = "Pick today or a future date.";
    return;
  }
  const toCopy = currentEntries().filter((e) => copySelected.has(e.id));
  if (!toCopy.length) return;
  const clones = toCopy.map((e) => ({
    id: crypto.randomUUID(), project: e.project, category: e.category, description: e.description, accSec: 0,
  }));
  await mutate((d) => {
    for (const c of clones) TTData.list(d, target).push(TTCore.touch(d, c));
    TTData.log(d, clones.map((c) => ({ type: "add", id: c.id, date: target, entry: TTCore.short(c), via: "copy" })));
  });
  $("copyToOverlay").classList.add("hidden");
  copyMode = false;
  copySelected.clear();
  render();
  const doneSt = $("copyStatus");
  if (doneSt) {
    doneSt.className = "status ok";
    doneSt.textContent = `✓ Copied ${clones.length} task${clones.length === 1 ? "" : "s"} to ${target}.`;
  }
}

// live-update the running entry's time field (skip if user is editing it)
function startTick() {
  if (tick) clearInterval(tick);
  if (!S.timer.activeId) return;
  tick = setInterval(() => {
    const e = S.entries.find((x) => x.id === S.timer.activeId);
    if (!e) return;
    const sec = elapsedSec(e);
    const live = document.querySelector(".entry.active .live");
    if (live) live.textContent = secToHHMMSS(sec);   // ticks every second -> clearly running
    const pick = document.querySelector(".entry.active .timepick");
    //! Skip the rewrite while either select is focused — the user is picking a
    //! value and a per-second update would yank the list out from under them.
    if (pick && !pick.contains(document.activeElement)) syncPickTime(pick, sec);
    if (isTodayView()) updateDayTotal();
  }, 1000);
}

// ---------- add / edit project ----------
async function submitDraft() {
  const desc = $("descInput").value.trim();
  const st = $("addStatus");
  if (!desc) {
    st.className = "status err";
    st.textContent = "Description is required.";
    return;
  }
  const project = $("projSelect").value;
  const cat = $("catSelect").value;
  const timeStr = formTimeStr();
  const timeSec = /^\d{1,2}:\d{2}$/.test(timeStr) ? hhmmToSec(timeStr) : 0;
  const editingId = S.draft && S.draft.editingId;
  const date = viewDate;
  const missing = await mutate((d) => {
    if (editingId) {
      const e = TTData.find(d, date, editingId);
      if (!e) return true;
      const from = TTCore.short(e);
      e.project = project; e.category = cat; e.description = desc;
      e.accSec = timeSec;
      TTCore.touch(d, e);
      if (date === d.date && d.timer.activeId === editingId) d.timer.startedAt = Date.now(); // rebase running
      TTData.log(d, [{ type: "edit", id: e.id, date, from, to: TTCore.short(e) }]);
    } else {
      const e = TTCore.touch(d, { id: crypto.randomUUID(), project, category: cat, description: desc, accSec: timeSec });
      TTData.list(d, date).push(e);
      TTData.log(d, [{ type: "add", id: e.id, date, entry: TTCore.short(e) }]);
    }
    d.set.lastProject = project;
    d.set.lastCategory = cat;
    d.set.draft = null;
    return false;
  });
  if (missing) {
    st.className = "status err";
    st.textContent = "That entry was deleted in another window or device — nothing saved.";
    clearDraft();
    render();
    return;
  }
  st.className = "status ok";
  st.textContent = editingId ? "Saved." : "Added.";
  refreshAddForm();
  render();
}

// ---------- name / project / category loading ----------
// Names, Projects and Categories are all static options embedded in a form's
// server-rendered __NEXT_DATA__ (a Dropdown widget). Fetch + parse — no tab,
// no DOM scrape. Name lives on the main form; Project/Category live on the
// "Create entry" subform (SUBFORM_URL).
function parseDropdownOptions(html, fieldName) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  let opts = [];
  (function walk(o) {
    if (o && typeof o === "object") {
      const so = o.name === fieldName && o.template && o.template.options && o.template.options.staticOptions;
      if (so) {
        opts = so
          .map((x) => { try { return x.value.logic.value; } catch { return null; } })
          .filter(Boolean);
      }
      for (const k in o) walk(o[k]);
    }
  })(data);
  return opts;
}
function parseNames(html) {
  return parseDropdownOptions(html, "Name").sort((a, b) => a.localeCompare(b));
}
// silent=true (init()'s background auto-refresh) skips all status/DOM
// writes, same pattern as loadProjectsAndCategories(silent).
async function loadNames(silent) {
  const st = silent ? null : $("setupStatus");
  if (st) { st.className = "status"; st.textContent = "Loading names…"; }
  try {
    const res = await fetch(FORM_URL, { credentials: "omit" });
    const names = parseNames(await res.text());
    if (!names.length) {
      if (st) { st.className = "status err"; st.textContent = "Could not read names from form."; }
      return;
    }
    S.names = names;
    await chrome.storage.local.set({ names });
    if (!silent) {
      $("setupPicker").classList.remove("hidden");
      st.className = "status ok";
      st.textContent = `Loaded ${names.length} names. Pick yours.`;
    }
  } catch (err) {
    if (st) { st.className = "status err"; st.textContent = "Error: " + err.message; }
  }
}
// silent=true (init()'s background auto-refresh) skips all status-element
// writes instead of requiring pcStatus to exist — Settings' own button click
// still passes silent=false for its usual visible feedback.
async function loadProjectsAndCategories(silent) {
  const st = silent ? null : $("pcStatus");
  if (!silent && !st) return;
  if (st) { st.className = "status"; st.textContent = "Loading projects & categories…"; }
  try {
    const res = await fetch(SUBFORM_URL, { credentials: "omit" });
    const html = await res.text();
    const projects = parseDropdownOptions(html, "Project");
    const categories = parseDropdownOptions(html, "Work Category");
    if (!projects.length && !categories.length) {
      if (st) { st.className = "status err"; st.textContent = "Could not read projects/categories from form."; }
      return;
    }
    if (projects.length) { S.projects = projects; await chrome.storage.local.set({ projects }); }
    if (categories.length) { S.categories = categories; await chrome.storage.local.set({ categories }); }
    if ($("catSelect")) fillSelect($("catSelect"), currentCategories());
    if (st) { st.className = "status ok"; st.textContent = `Loaded ${projects.length} projects, ${categories.length} categories.`; }
  } catch (err) {
    if (st) { st.className = "status err"; st.textContent = "Error: " + err.message; }
  }
}
async function saveName() {
  S.name = $("nameSelect").value;
  await chrome.storage.local.set({ name: S.name });
  showMain();
}

// ---------- backup / sync data helpers (shared by popup + tab + gdrive.js) ----------
// Kept in popup.js so both the popup and the full tab view (and the Drive sync
// module) can build/apply the transfer envelope — the same shape the desktop
// app and the manual paste bridge use.
function buildDaysMap() {
  return { ...S.history, [S.date]: S.entries.map((e) => ({ ...e, accSec: elapsedSec(e) })) };
}
function buildExportText() {
  const state = {
    days: buildDaysMap(), deletedEntries: S.deletedEntries, deletedBy: S.deletedBy,
    submittedDays: S.submittedDays, clock: S.clock,
  };
  return JSON.stringify(TTCore.envelope(state, { name: S.name, deviceId: S.deviceId, deviceName: TTData.DEVICE_NAME }), null, 2);
}
function refreshDataViews() {
  if (typeof render === "function") render();
  if (typeof updateSubmittedUI === "function") updateSubmittedUI();
  if (typeof renderSettings === "function") renderSettings();
  if (typeof renderDashboard === "function") renderDashboard();
}
// Debounced push after local edits (gdrive.js provides gdSync; absent in tests).
let gdSyncTimer = null;
let gdSyncedAt = 0;
function gdSyncSoon() {
  if (typeof gdSync !== "function") return;
  clearTimeout(gdSyncTimer);
  gdSyncTimer = setTimeout(() => { gdSyncNow().catch(() => {}); }, 2500);
}
//! The 2500ms debounce dies with the popup, so marking and closing lost the push. Anything that
//! must not be lost awaits this instead of arming the timer.
//* Both paths funnel through here so one write can't kick off two full sweeps — gdSync re-pushes
//* every submitted day it knows about, so a duplicate sweep is not free.
async function gdSyncNow() {
  if (typeof gdSync !== "function") return "";
  if (Date.now() - gdSyncedAt < 3000) { gdSyncSoon(); return ""; } // too soon — re-arm, never drop
  clearTimeout(gdSyncTimer);
  gdSyncedAt = Date.now();
  try { return await gdSync(false); } finally { gdSyncedAt = Date.now(); }
}

// ---------- prayer reminders (UI only — background.js fires the notifications) ----------
//! prayer.js/prayer-hadiths.js are absent in the jsdom harness, so every entry point here is
//! typeof-guarded the same way the Drive calls are.
let prayerVerified = null; // a city the API has actually answered for, this session

async function renderPrayerRow() {
  if (!$("prayerBtn") || typeof prayerLoad !== "function") return;
  const p = await prayerLoad();
  const on = !!(p.enabled && p.city);
  //! Highlighted only once it is actually set up — an unconfigured button shouting for attention
  //! next to the timer is exactly the crowding this feature was meant to avoid.
  $("prayerBtn").classList.toggle("on", on);
  $("prayerTitle").textContent = on ? p.city : "Namaj Time";
  const label = $("prayerNext");
  //* The reminder the next notification will carry — same rotation, so the card previews it.
  const hadith = $("prayerHadith");
  const r = on && typeof prayerReminderAt === "function" ? prayerReminderAt(p.reminderIndex || 0) : null;
  hadith.textContent = r ? `${r.text} — ${r.source}` : "";
  if (!on) {
    label.textContent = "Set your city to get prayer reminders";
    return;
  }
  const times = (p.days || {})[todayStr()];
  if (!times) {
    label.textContent = "times unavailable";
    return;
  }
  const now = new Date();
  //! Empty is not an error: between Islamic midnight and 00:00 no waqt is running.
  label.textContent = prayerStatusLine(times, now.getHours() * 60 + now.getMinutes()) || "no prayer time right now";
}

async function openPrayerSettings() {
  const p = await prayerLoad();
  prayerVerified = null;
  $("prayerEnabled").checked = !!p.enabled;
  $("prayerCity").value = p.city || "";
  $("prayerCountry").value = p.country || "";
  $("prayerStatus").className = "status";
  $("prayerStatus").textContent = "";
  $("prayerPreview").classList.add("hidden");
  $("prayerSave").disabled = !p.city; // an already-configured city needs no re-check
  $("prayerOverlay").classList.remove("hidden");
}

function prayerSetStatus(msg, cls) {
  $("prayerStatus").className = "status" + (cls ? " " + cls : "");
  $("prayerStatus").textContent = msg;
}

async function prayerDoCheck() {
  const city = $("prayerCity").value.trim();
  const country = $("prayerCountry").value.trim();
  if (!city || !country) return prayerSetStatus("Enter both a city and a country.", "err");
  prayerSetStatus("Checking…");
  $("prayerPreview").classList.add("hidden");
  try {
    const p = await prayerLoad();
    const r = await prayerFetchMonth(city, country, p.method, p.school);
    const times = r.days[todayStr()] || Object.values(r.days)[0] || {};
    prayerVerified = { ...r, city, country };

    const box = $("prayerPreview");
    box.textContent = "";
    const tzLine = document.createElement("div");
    tzLine.textContent = `Resolved to ${r.tz || "an unknown timezone"}`;
    box.appendChild(tzLine);
    const timeLine = document.createElement("div");
    timeLine.className = "prayerTimes";
    timeLine.textContent = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]
      .map((n) => `${n} ${times[n] || "—"}`)
      .join("   ");
    box.appendChild(timeLine);

    //! Aladhan answers 200 for a city it has never heard of, with times for somewhere else
    //! entirely. A timezone that isn't this device's is the one automatic tell there is.
    const device = prayerDeviceTz();
    if (device && r.tz && device !== r.tz) {
      const warn = document.createElement("div");
      warn.className = "prayerWarn";
      warn.textContent = `⚠ Your device is on ${device}. If that city name was a typo these times belong to somewhere else — check them before saving.`;
      box.appendChild(warn);
    }
    box.classList.remove("hidden");
    prayerSetStatus("Found. Check the times above, then Save.", "ok");
    $("prayerSave").disabled = false;
  } catch (e) {
    prayerVerified = null;
    $("prayerSave").disabled = true;
    prayerSetStatus(e.message || String(e), "err");
  }
}

async function prayerDoSave() {
  const enabled = $("prayerEnabled").checked;
  const stored = await prayerLoad();
  const patch = { enabled };
  if (prayerVerified) {
    Object.assign(patch, {
      city: prayerVerified.city,
      country: prayerVerified.country,
      tz: prayerVerified.tz,
      days: prayerVerified.days,
      month: prayerVerified.month,
      notified: {}, //* a new city means today's marks no longer describe anything
    });
  }
  if (enabled && !(patch.city || stored.city)) {
    return prayerSetStatus("Check a city first.", "err");
  }
  await prayerSave(patch);
  $("prayerOverlay").classList.add("hidden");
  await renderPrayerRow();
}

// ---------- final submit ----------
async function finalSubmit() {
  const st = $("submitStatus");
  st.className = "status";
  const list = currentEntries();
  if (!list.length) {
    st.className = "status err";
    st.textContent = "No projects to submit.";
    return;
  }
  // Whole flow wrapped in one try/catch — the storage writes below can throw
  // (e.g. quota); left unguarded that used to die as an unhandled rejection
  // with no status message, looking like the extension crashed.
  try {
    const date = viewDate;
    await mutate((d) => { if (date === d.date) TTData.foldTimer(d); });
    render();
    const list = currentEntries();
    // Check raw elapsed seconds, not the minute-rounded hh:mm display — a
    // 30-59s entry rounds UP to "00:01" and would otherwise slip past.
    const under1min = list.filter((e) => elapsedSec(e) < 60);
    if (under1min.length) {
      st.className = "status err";
      st.textContent = `${under1min.length} project(s) have under 1 minute tracked — set a real time before submitting.`;
      return;
    }
    // Always a full resync (matches the desktop app): fillFormOnPage clears
    // whatever's already in the Fillout form for this day first, then fills
    // every LOCAL entry fresh. That's what makes re-running Final Submit
    // after adding/editing/removing an entry actually correct — an
    // incremental "only send what's new" model (the old behavior here)
    // could never reflect an edit or a removal back into the real form.
    const payload = list.map((e) => ({
      id: e.id,
      project: e.project,
      category: e.category,
      description: e.description,
      hhmm: secToHHMM(elapsedSec(e)),
    }));
    const msg = `Re-fill Fillout with all ${payload.length} project(s) for this day?` +
      (isTodayView() ? "" : `\nThese are for ${viewDate}.`) +
      `\n\nThis clears any existing entries already in the form, then adds these fresh.` +
      `\nThe form's own final Submit stays yours to click.`;
    if (!(await showConfirm(msg))) return;

    //* The fill runs in the service worker (fill.js startFill), so it keeps going when this popup
    //* closes; progress and the result come back through storage "fillStatus".
    st.textContent = "Starting…";
    const res = await chrome.runtime.sendMessage({ tt: "fill", job: { date, name: S.name, entries: payload } });
    if (res && res.busy) {
      st.className = "status err";
      st.textContent = "A fill is already running — wait for it to finish.";
      return;
    }
    if (res && res.error) throw new Error(res.error);
    const all = await chrome.storage.local.get(null);
    for (const k of TTData.DATA_KEYS) if (k in all) S[k] = all[k];
    adopt();
    render();
    showFillStatus(all.fillStatus);
  } catch (err) {
    st.className = "status err";
    st.textContent = "Error: " + err.message;
  }
}

//* A finished run's message only shows for a while; a running one always does.
function showFillStatus(fs) {
  const st = $("submitStatus");
  if (!st || !fs || fs.date !== viewDate) return;
  if (!fs.running && Date.now() - fs.at > 10 * 60000) return;
  st.className = "status" + (fs.cls ? " " + fs.cls : "");
  st.textContent = fs.text;
}

async function openFullView() {
  const url = chrome.runtime.getURL("tab.html");
  const existing = await chrome.tabs.query({ url: url + "*" });
  if (existing[0]) {
    await chrome.tabs.update(existing[0].id, { active: true });
  } else {
    await chrome.tabs.create({ url, active: true });
  }
}

// ---------- wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  $("loadNames").onclick = () => loadNames(false);
  if ($("loadProjects")) $("loadProjects").onclick = () => loadProjectsAndCategories(false);
  $("saveName").onclick = saveName;
  if ($("openFullView")) $("openFullView").onclick = openFullView;
  $("changeName").onclick = showSetup;
  $("addProject").onclick = submitDraft;
  $("cancelEdit").onclick = clearDraft;
  $("projSelect").onchange = saveDraft;
  $("catSelect").onchange = saveDraft;
  $("descInput").oninput = saveDraft;
  //! change, not input — a select never fires input events.
  if ($("timePick")) $("timePick").onchange = saveDraft;
  if ($("dayPrev")) $("dayPrev").onclick = () => setViewDate(addDaysStr(viewDate, -1));
  if ($("dayNext")) $("dayNext").onclick = () => setViewDate(addDaysStr(viewDate, 1));
  if ($("todayBtn")) $("todayBtn").onclick = () => setViewDate(S.date);
  if ($("viewDateInput")) $("viewDateInput").onchange = (e) => setViewDate(e.target.value);
  $("finalSubmit").onclick = finalSubmit;
  if ($("prayerBtn")) {
    $("prayerBtn").onclick = openPrayerSettings;
    $("prayerCheck").onclick = prayerDoCheck;
    $("prayerCancel").onclick = () => $("prayerOverlay").classList.add("hidden");
    $("prayerSave").onclick = prayerDoSave;
  }
  if ($("copyModeBtn")) $("copyModeBtn").onclick = toggleCopyMode;
  if ($("copyToBtn")) $("copyToBtn").onclick = openCopyToDialog;
  if ($("copyToCancel")) $("copyToCancel").onclick = () => $("copyToOverlay").classList.add("hidden");
  if ($("copyToConfirm")) $("copyToConfirm").onclick = confirmCopyTo;
  if ($("markSubmitBtn")) $("markSubmitBtn").onclick = () =>
    daySubmitted(viewDate) ? unmarkDaySubmitted(viewDate) : markDaySubmitted(viewDate, "manual");
  // Reflect an auto-mark written by the form-tab watcher while the popup is open.
  if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      //* Another window, the service worker or a sync wrote tracked data: refresh this window's cache.
      if (Object.keys(changes).some((k) => TTData.DATA_KEYS.includes(k))) {
        const oldDate = S.date;
        for (const k of Object.keys(changes)) if (TTData.DATA_KEYS.includes(k)) S[k] = changes[k].newValue;
        adopt();
        if (viewDate === oldDate && S.date !== oldDate) viewDate = S.date;
        const main = $("main");
        if (S.name && main && !main.classList.contains("hidden")) render();
        if (typeof renderDashboard === "function") renderDashboard();
        if (typeof renderTimesheet === "function") renderTimesheet();
      }
      if (changes.submittedDays) {
        updateSubmittedUI();
      }
      if (changes.fillStatus) showFillStatus(changes.fillStatus.newValue);
      // Push local edits to Drive shortly after any data change. A pull writes
      // the same keys, but gdSync merges rather than blindly overwriting, so
      // the follow-up push is a no-op once both sides already agree.
      if (changes.entries || changes.history || changes.date || changes.name || changes.submittedDays || changes.deletedEntries) {
        gdSyncSoon();
      }
    });
  }
  setupSearchSelect($("projSelect"), $("projList"), () => currentProjects());
  setupSearchSelect($("nameSelect"), $("nameList"), () => S.names || []);
  init();
});
