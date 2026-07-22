"use strict";

const FORM_URL = "https://techzu.fillout.com/t/uhz6TddCX2us";
const PROJECTS = ["Bookland ERP", "Builder Alliance", "Dr Cool", "Hydroflux", "NewERP",
  "Prowork", "Rina CRM", "SME Taskhub", "VSB", "Worksite Mini ERP", "ZuPOS"];
const CATEGORIES = ["Meeting (General)", "Meeting (Technical)", "Development",
  "Code Review", "Miscellaneous"];
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
let viewDate = null;

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
async function persistCurrent() {
  if (isTodayView()) await chrome.storage.local.set({ entries: S.entries, timer: S.timer });
  else await chrome.storage.local.set({ history: S.history });
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
async function persist() {
  await chrome.storage.local.set({ entries: S.entries, timer: S.timer });
}
async function init() {
  S = await chrome.storage.local.get(null);
  S.entries = S.entries || [];
  S.timer = S.timer || { activeId: null, startedAt: null };
  S.history = S.history || {};
  S.submittedDays = S.submittedDays || {}; // { date: { at, method } } — Task 7
  S.confirmBeforeDelete = S.confirmBeforeDelete === undefined ? true : S.confirmBeforeDelete;
  const dailyLimitWasUnset = S.dailyLimitHours === undefined;
  S.dailyLimitHours = S.dailyLimitHours || 8;
  // background.js reads dailyLimitHours from storage directly (separate realm),
  // so the default must be persisted here, not just held in memory.
  if (dailyLimitWasUnset) await chrome.storage.local.set({ dailyLimitHours: S.dailyLimitHours });
  S.warnedDate = S.warnedDate === undefined ? null : S.warnedDate;
  S.theme = S.theme || "dark";
  const today = todayStr();
  if (S.date !== today) {
    // Archive the outgoing day's entries before clearing them — skip on the
    // very first run ever (no S.date yet) so we don't write a bogus entry.
    if (S.date && S.entries.length) {
      foldActive(); // fold any running timer into accSec before archiving
      S.history[S.date] = S.entries;
    }
    // daily reset: clear projects + timer + draft, keep name/names/lastCategory
    S.entries = [];
    S.timer = { activeId: null, startedAt: null };
    S.draft = null;
    S.date = today;
    await chrome.storage.local.set({ history: S.history, entries: [], timer: S.timer, draft: null, date: today });
  }
  document.documentElement.dataset.theme = resolveTheme(S.theme);
  route();
  // Cross-device sync: silently sync with Google Drive on open (if connected).
  // A true conflict returns "sync-conflict"; re-run interactively to prompt
  // (token is already cached, so no OAuth popup just to ask).
  if (typeof gdSync === "function") {
    const trySync = () => gdSync(false).then((r) => { if (r === "sync-conflict") gdSync(true); }).catch(() => {});
    trySync();
    // Poll while this view stays open (mainly the full tab, which can sit open
    // for a while) so a change made on another device/app shows up here without
    // needing a local edit to trigger the debounced push-based sync.
    setInterval(trySync, 20000);
  }
}

// ---------- timer engine (one active at a time) ----------
function elapsedSec(e) {
  let s = e.accSec || 0;
  if (S.timer.activeId === e.id && S.timer.startedAt) s += (Date.now() - S.timer.startedAt) / 1000;
  return s;
}
function foldActive() {
  if (S.timer.activeId && S.timer.startedAt) {
    const e = S.entries.find((x) => x.id === S.timer.activeId);
    if (e) e.accSec = (e.accSec || 0) + (Date.now() - S.timer.startedAt) / 1000;
  }
  S.timer = { activeId: null, startedAt: null };
}
async function startTimer(id) {
  foldActive();                 // stops any other running timer
  S.timer = { activeId: id, startedAt: Date.now() };
  await persist();
  render();
}
async function pauseTimer() {
  foldActive();
  await persist();
  render();
}
function editTime(id, str) {
  const e = currentEntries().find((x) => x.id === id);
  if (!e) return;
  e.accSec = hhmmToSec(str);
  if (isTodayView() && S.timer.activeId === id) S.timer.startedAt = Date.now(); // rebase running timer
  persistCurrent();
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
  fillSelect($("catSelect"), CATEGORIES);
  updateDayNav();
  refreshAddForm();
  render();
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
  return !!(S.submittedDays && S.submittedDays[date]);
}
async function markDaySubmitted(date, method) {
  S.submittedDays = S.submittedDays || {};
  S.submittedDays[date] = { at: Date.now(), method };
  await chrome.storage.local.set({ submittedDays: S.submittedDays });
  updateSubmittedUI();
}
async function unmarkDaySubmitted(date) {
  if (S.submittedDays) delete S.submittedDays[date];
  await chrome.storage.local.set({ submittedDays: S.submittedDays || {} });
  updateSubmittedUI();
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
}
// Injected into the form tab after a fill: watches for the "Thank you"
// completion screen and records a REAL submission (method "auto") straight
// to storage — the popup may be closed by the time the user hits Submit, so
// this can't rely on it. Self-contained: no closure refs (executeScript
// serializes it), content-script context has chrome.storage access.
function watchForSubmit(date) {
  if (window.__ttSubmitWatch) return;
  window.__ttSubmitWatch = setInterval(() => {
    try {
      const txt = (document.body.innerText || "").toLowerCase();
      const createGone = ![...document.querySelectorAll("button,[role=button],a,div,span")]
        .some((n) => (n.textContent || "").trim() === "Create" && n.offsetParent !== null);
      if (txt.includes("thank you") && createGone) {
        clearInterval(window.__ttSubmitWatch);
        chrome.storage.local.get(["submittedDays"]).then((g) => {
          const sd = g.submittedDays || {};
          sd[date] = { at: Date.now(), method: "auto" };
          chrome.storage.local.set({ submittedDays: sd });
        });
      }
    } catch (e) {}
  }, 1500);
}
function setViewDate(dateStr) {
  if (!dateStr || dateStr > S.date) dateStr = S.date; // never past the live day
  viewDate = dateStr;
  clearDraft(); // drop any in-progress edit when changing days
  updateDayNav();
  render();
}
// Reflect S.draft into the add-form (survives popup close / tab switch).
// draft = { project, category, description, editingId }
function refreshAddForm() {
  // drop a stale edit target that was deleted
  if (S.draft && S.draft.editingId && !S.entries.some((e) => e.id === S.draft.editingId)) S.draft = null;
  const d = S.draft;
  $("projSelect").value = (d && d.project) || S.lastProject || PROJECTS[0];
  $("catSelect").value = (d && d.category) || S.lastCategory || CATEGORIES[0];
  $("descInput").value = (d && d.description) || "";
  if ($("timeInput")) $("timeInput").value = (d && d.time) || "00:00";
  const editing = !!(d && d.editingId);
  $("addProject").textContent = editing ? "Save changes" : "+ Add Project";
  $("cancelEdit").classList.toggle("hidden", !editing);
}
function saveDraft() {
  S.draft = {
    project: $("projSelect").value,
    category: $("catSelect").value,
    description: $("descInput").value,
    time: $("timeInput") ? $("timeInput").value : "00:00",
    editingId: (S.draft && S.draft.editingId) || null,
  };
  chrome.storage.local.set({ draft: S.draft });
}
function startEdit(id) {
  const e = currentEntries().find((x) => x.id === id);
  if (!e) return;
  S.draft = {
    project: e.project, category: e.category, description: e.description,
    time: secToHHMM(elapsedSec(e)), editingId: id,
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
  return showDialog(message, yesLabel || "Yes, submit", null).then((r) => r === "yes");
}
// Three-way choice: resolves "yes" | "alt" | "cancel" (e.g. sync conflict).
function showChoice(message, yesLabel, altLabel) {
  return showDialog(message, yesLabel, altLabel);
}
function showDialog(message, yesLabel, altLabel) {
  return new Promise((resolve) => {
    $("confirmMsg").textContent = message;
    $("confirmYes").textContent = yesLabel;
    const alt = $("confirmAlt");
    if (alt) {
      if (altLabel) { alt.textContent = altLabel; alt.classList.remove("hidden"); }
      else alt.classList.add("hidden");
    }
    $("confirmOverlay").classList.remove("hidden");
    const done = (result) => {
      $("confirmOverlay").classList.add("hidden");
      $("confirmYes").onclick = null;
      $("confirmNo").onclick = null;
      if (alt) alt.onclick = null;
      resolve(result);
    };
    $("confirmYes").onclick = () => done("yes");
    $("confirmNo").onclick = () => done("cancel");
    if (alt) alt.onclick = () => done("alt");
  });
}
function fillSelect(sel, items) {
  sel.innerHTML = "";
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it;
    o.textContent = it;
    sel.appendChild(o);
  }
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

// ---------- render entries ----------
function render() {
  const box = $("entries");
  box.innerHTML = "";
  const list = currentEntries();
  const todayView = isTodayView();
  $("emptyMsg").classList.toggle("hidden", list.length > 0);
  const totalEl = $("dayTotal");
  if (totalEl) totalEl.textContent = secToHHMM(viewTotalSec());
  updateSubmittedUI();
  for (const e of list) {
    const active = todayView && S.timer.activeId === e.id;
    const div = document.createElement("div");
    div.className = "entry" + (active ? " active" : "");
    div.innerHTML = `
      <div class="row1">
        <div>
          <span class="statusDot"></span>
          <span class="pname"></span>
          <span class="cat"></span>
          ${e.submitted ? '<span class="submittedBadge">Submitted</span>' : ""}
        </div>
        <div class="acts">
          <button class="edit" title="Edit">✎</button>
          <button class="del" title="Delete">&times;</button>
        </div>
      </div>
      <div class="desc"></div>
      <div class="row2">
        ${todayView ? `<button class="tbtn ${active ? "playing" : ""}">${active ? "❚❚" : "▶"}</button>` : ""}
        <input class="time" type="text" value="${secToHHMM(elapsedSec(e))}">
        <span class="live">${active ? secToHHMMSS(elapsedSec(e)) : ""}</span>
      </div>`;
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
    div.querySelector(".edit").onclick = () => startEdit(e.id);
    div.querySelector(".del").onclick = () => deleteEntry(e.id);
    const ti = div.querySelector(".time");
    ti.onchange = () => editTime(e.id, ti.value);
    box.appendChild(div);
  }
  startTick();
}
async function deleteEntry(id) {
  if (S.confirmBeforeDelete !== false) {
    if (!(await showConfirm("Delete this project entry?", "Yes, delete"))) return;
  }
  if (isTodayView() && S.timer.activeId === id) S.timer = { activeId: null, startedAt: null };
  const list = currentEntries();
  const idx = list.findIndex((x) => x.id === id);
  if (idx >= 0) list.splice(idx, 1);
  await persistCurrent();
  render();
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
    const inp = document.querySelector(".entry.active .time");
    if (inp && document.activeElement !== inp) inp.value = secToHHMM(sec);
    if (isTodayView()) {
      const totalEl = $("dayTotal");
      if (totalEl) totalEl.textContent = secToHHMM(viewTotalSec());
    }
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
  const timeStr = $("timeInput") ? $("timeInput").value.trim() : "00:00";
  const timeSec = /^\d{1,2}:\d{2}$/.test(timeStr) ? hhmmToSec(timeStr) : 0;
  const editingId = S.draft && S.draft.editingId;
  if (editingId) {
    const e = currentEntries().find((x) => x.id === editingId);
    if (e) {
      e.project = project; e.category = cat; e.description = desc;
      e.accSec = timeSec;
      if (isTodayView() && S.timer.activeId === editingId) S.timer.startedAt = Date.now(); // rebase running
    }
  } else {
    if (!isTodayView() && !S.history[viewDate]) S.history[viewDate] = [];
    currentEntries().push({ id: crypto.randomUUID(), project, category: cat, description: desc, accSec: timeSec });
  }
  S.lastProject = project;
  S.lastCategory = cat;
  S.draft = null;
  await persistCurrent();
  await chrome.storage.local.set({ lastProject: project, lastCategory: cat, draft: null });
  st.className = "status ok";
  st.textContent = editingId ? "Saved." : "Added.";
  refreshAddForm();
  render();
}

// ---------- name loading ----------
// Names are static options embedded in the form's server-rendered
// __NEXT_DATA__ (Name Dropdown widget). Fetch + parse — no tab, no DOM scrape.
function parseNames(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }
  let names = [];
  (function walk(o) {
    if (o && typeof o === "object") {
      const so = o.name === "Name" && o.template && o.template.options && o.template.options.staticOptions;
      if (so) {
        names = so
          .map((x) => { try { return x.value.logic.value; } catch { return null; } })
          .filter(Boolean);
      }
      for (const k in o) walk(o[k]);
    }
  })(data);
  return names.sort((a, b) => a.localeCompare(b));
}
async function loadNames() {
  const st = $("setupStatus");
  st.className = "status";
  st.textContent = "Loading names…";
  try {
    const res = await fetch(FORM_URL, { credentials: "omit" });
    const names = parseNames(await res.text());
    if (!names.length) {
      st.className = "status err";
      st.textContent = "Could not read names from form.";
      return;
    }
    S.names = names;
    await chrome.storage.local.set({ names });
    $("setupPicker").classList.remove("hidden");
    st.className = "status ok";
    st.textContent = `Loaded ${names.length} names. Pick yours.`;
  } catch (err) {
    st.className = "status err";
    st.textContent = "Error: " + err.message;
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
  return JSON.stringify(
    {
      app: "team-timesheet", v: 1, exportedAt: Date.now(), name: S.name || "",
      days: buildDaysMap(), submittedDays: S.submittedDays || {},
    },
    null, 2
  );
}
// Overwrite all tracked data from a parsed envelope (no confirm — callers
// confirm/decide). Refreshes whatever views exist in this context.
async function applyBackupData(obj) {
  const today = todayStr();
  const history = {};
  let todays = [];
  for (const [date, list] of Object.entries(obj.days || {})) {
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
  S.submittedDays = obj.submittedDays || {};
  await chrome.storage.local.set({
    history: S.history, entries: S.entries, timer: S.timer, date: today, name: S.name,
    submittedDays: S.submittedDays,
  });
  refreshDataViews();
}
function refreshDataViews() {
  if (typeof render === "function") render();
  if (typeof updateSubmittedUI === "function") updateSubmittedUI();
  if (typeof renderSettings === "function") renderSettings();
  if (typeof renderDashboard === "function") renderDashboard();
}
// Debounced push after local edits (gdrive.js provides gdSync; absent in tests).
let gdSyncTimer = null;
function gdSyncSoon() {
  if (typeof gdSync !== "function") return;
  clearTimeout(gdSyncTimer);
  gdSyncTimer = setTimeout(() => { gdSync(false).catch(() => {}); }, 2500);
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
  if (isTodayView()) foldActive();
  await persistCurrent();
  render();
  // Only re-submit entries that haven't gone through yet — otherwise a
  // second Final Submit click (e.g. after adding one more project) would
  // re-add every already-submitted entry a second time in the real form.
  const pending = list.filter((e) => !e.submitted);
  if (!pending.length) {
    st.className = "status err";
    st.textContent = "All projects here already submitted. Add a new one to submit more.";
    return;
  }
  const payload = pending.map((e) => ({
    project: e.project,
    category: e.category,
    description: e.description,
    hhmm: secToHHMM(elapsedSec(e)),
  }));
  if (payload.every((e) => hhmmToSec(e.hhmm) === 0)) {
    st.className = "status err";
    st.textContent = "All projects are 00:00 — set a time first.";
    return;
  }
  const zeros = payload.filter((e) => hhmmToSec(e.hhmm) === 0).length;
  const msg = `Submit ${payload.length} project(s) to the timesheet form?` +
    (zeros ? `\n${zeros} have 00:00 time.` : "") +
    (isTodayView() ? "" : `\nThese are for ${viewDate} — set the form's Date field to ${viewDate} before its final Submit.`) +
    `\n\nThis fills entries only — it will NOT click the form's final Submit.`;
  if (!(await showConfirm(msg))) return;

  st.textContent = "Opening form…";
  try {
    const tabId = await ensureFormTab();
    st.textContent = "Filling entries…";
    const out = await fillFormOnPage(tabId, payload, S.name);
    // fillFormOnPage processes `pending` in order and stops at the first
    // failure, so the first `added` of them are the ones that succeeded.
    const addedCount = out ? out.added : 0;
    for (let i = 0; i < addedCount; i++) pending[i].submitted = true;
    if (addedCount > 0) { await persistCurrent(); render(); }
    // Auto-detect the user's real Submit (Task 7): leave a watcher in the form
    // tab that marks this day submitted when the "Thank you" screen appears.
    if (addedCount > 0) {
      try { await chrome.scripting.executeScript({ target: { tabId }, func: watchForSubmit, args: [viewDate] }); } catch (e) {}
    }
    if (out && out.error) {
      st.className = "status err";
      st.textContent = "Stopped: " + out.error + ` (${addedCount} added)`;
    } else {
      st.className = "status ok";
      st.textContent = `Done — ${addedCount} entries added. Review & Submit manually.`;
    }
  } catch (err) {
    st.className = "status err";
    st.textContent = "Error: " + err.message;
  }
}

async function ensureFormTab() {
  const existing = await chrome.tabs.query({ url: FORM_URL + "*" });
  let tab = existing[0];
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    tab = await chrome.tabs.create({ url: FORM_URL + "?name=" + encodeURIComponent(S.name), active: true });
  }
  await waitTabComplete(tab.id);
  // Reload immediately once the tab has at least finished its initial
  // navigation — before any readiness polling, before Name selection,
  // before anything else — so the reload is the first visible thing that
  // happens and is obviously a fresh load, not a late/invisible one buried
  // after a wait. Always reloads, new tab or reused, even though this means
  // any in-progress session-only entries already on a reused tab get
  // discarded (Fillout doesn't persist entries until the real Submit).
  //
  // CRITICAL: wait for the reload via the onUpdated *event*, not by polling
  // tabs.get().status. Confirmed live: right after reload() resolves, a
  // tabs.get() call can still read the OLD "complete" status for a brief
  // moment before Chrome flips it to "loading" — a poll landing in that gap
  // treats the reload as already done and lets automation run against the
  // page that's a moment away from being torn down, silently losing
  // whatever it just selected (e.g. Name) once the real reload lands. This
  // is exactly why it only worked after a prior *manual* reload — that gave
  // the race window time to pass before Final Submit ever ran. The listener
  // is attached before reload() is called so the transition can't be missed.
  const reloaded = waitForTabReloadComplete(tab.id);
  await chrome.tabs.reload(tab.id);
  await reloaded;
  // A fixed sleep here used to guess how long the React app takes to
  // actually become interactive after the tab reports "complete". Confirmed
  // live: on a cold load that can take 1.3s+, longer than any fixed guess
  // reliably covers. Poll for real readiness instead.
  await waitForFormReady(tab.id);
  return tab.id;
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
// True once the Name field (placeholder or already-selected value) or the
// Create button is actually present — covers both a fresh page (Name still
// shows its placeholder) and a reused tab where Name was already selected.
function pageFormReady() {
  const hasNamePlaceholder = [...document.querySelectorAll(".react-select__placeholder")]
    .some((e) => e.textContent.trim() === "Name" && e.offsetParent !== null);
  const hasNameValue = document.querySelectorAll(".react-select__single-value").length > 0;
  const hasCreate = [...document.querySelectorAll("button,[role=button],a,div,span")]
    .some((n) => n.textContent.trim() === "Create" && n.children.length === 0 && n.offsetParent !== null);
  return hasNamePlaceholder || hasNameValue || hasCreate;
}
async function waitForFormReady(tabId, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: pageFormReady }).catch(() => [{}]);
    if (res && res.result) return true;
    await sleep(300);
  }
  return false;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitTabComplete(tabId, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return;
    await sleep(200);
  }
}
// Event-based wait for a reload specifically — see the CRITICAL comment at
// its call site for why this can't be a tabs.get().status poll like
// waitTabComplete above. Must be called (to attach the listener) BEFORE
// chrome.tabs.reload() is issued, so the status transition can't be missed.
function waitForTabReloadComplete(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// =====================================================================
// FORM AUTOMATION — Fillout's "Create" opens a genuine cross-origin-style
// <iframe> subform (a separate document, own react-select instances). A
// top-frame content script cannot see into it, which is why the previous
// single-frame version always failed to find Project/Category/Description/
// Time. Confirmed live via headless Chrome:
//   - Name/Project/Category are react-select (`.react-select__control`,
//     `.react-select__placeholder`, `input[role=combobox]`,
//     `.react-select__single-value`), not Radix — selected by typing the
//     value into the input then a synthetic Enter keydown (verified this
//     works with untrusted/synthetic events, same as react-select's own
//     built-in search).
//   - The subform's own "Submit" button lives entirely inside that iframe's
//     document, so filling/clicking it there can never reach the main
//     form's Submit — no [role=dialog] scoping trick needed.
// Orchestration below alternates executeScript calls between the top frame
// (frameId 0, default) and the dynamically-discovered subform frameId.
// =====================================================================

function pageSelectName(name) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const setNative = (el, val) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const fire = (el, type, extra) =>
    el.dispatchEvent(new (type.startsWith("key") ? KeyboardEvent : MouseEvent)(type, { bubbles: true, cancelable: true, ...extra }));
  const already = [...document.querySelectorAll(".react-select__single-value")]
    .find((e) => norm(e.textContent) === name);
  if (already) return { skipped: true };
  const ph = [...document.querySelectorAll(".react-select__placeholder")]
    .find((e) => norm(e.textContent) === "Name" && e.offsetParent !== null);
  if (!ph) return { error: "Name field not found" };
  const control = ph.closest(".react-select__control");
  const input = control.querySelector("input[role=combobox]");
  fire(input, "mousedown");
  input.focus();
  setNative(input, name);
  return new Promise((resolve) => {
    setTimeout(() => {
      fire(input, "keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
      setTimeout(() => {
        const sv = control.querySelector(".react-select__single-value");
        resolve(sv && norm(sv.textContent) === name ? { ok: true } : { error: `could not select name "${name}"` });
      }, 350);
    }, 450);
  });
}

function pageClickCreate() {
  const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  const el = [...document.querySelectorAll("button,[role=button],a,div,span")]
    .find((n) => n.textContent.trim() === "Create" && n.children.length === 0 && n.offsetParent !== null);
  if (!el) return { error: 'Create button not found' };
  ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => fire(el, t));
  return { ok: true };
}

// Probe run with allFrames:true — true only in the subform iframe once loaded.
function probeSubform() {
  return !!document.querySelector('input[placeholder="Task Description"]');
}

// After a submit, Fillout's "Timesheet Entries" list does its own async
// refetch/re-render (confirmed live: a loading-skeleton bar for ~0.5-1s+,
// sometimes longer) before the just-added entry's text actually appears.
// Clicking "Create" again while that refresh is still in flight can hit a
// transitional/about-to-be-replaced DOM node whose click handler no longer
// fires — this is the flaky "worked once, then silently did nothing on the
// next entry" failure. Confirm the entry text is actually visible before
// moving on to the next Create.
function pageEntryVisible(description) {
  return document.body.innerText.includes(description);
}

// Runs targeted at the discovered subform frameId only — physically cannot
// see or click the main page's Submit button.
function frameFillEntry(entry) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const setNative = (el, val) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const fire = (el, type, extra) =>
    el.dispatchEvent(new (type.startsWith("key") ? KeyboardEvent : MouseEvent)(type, { bubbles: true, cancelable: true, ...extra }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const selectReact = async (placeholder, value) => {
    const ph = [...document.querySelectorAll(".react-select__placeholder")]
      .find((e) => norm(e.textContent) === placeholder && e.offsetParent !== null);
    if (!ph) throw new Error(`dropdown "${placeholder}" not found`);
    const control = ph.closest(".react-select__control");
    const input = control.querySelector("input[role=combobox]");
    fire(input, "mousedown");
    input.focus();
    setNative(input, value);
    await sleep(400);
    fire(input, "keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
    await sleep(300);
    const sv = control.querySelector(".react-select__single-value");
    if (!sv || norm(sv.textContent) !== value) throw new Error(`could not select "${value}" for "${placeholder}"`);
  };
  const setByPlaceholder = (placeholder, value) => {
    const inp = [...document.querySelectorAll("input,textarea")].find((i) => i.placeholder === placeholder);
    if (!inp) throw new Error(`input "${placeholder}" not found`);
    setNative(inp, value);
  };
  return (async () => {
    try {
      await selectReact("Select Project", entry.project);
      await selectReact("Select Work Category", entry.category);
      setByPlaceholder("Task Description", entry.description);
      setByPlaceholder("Hours Clocked (hh:mm)", entry.hhmm);
      await sleep(150);
      const submitBtn = [...document.querySelectorAll("button,[role=button]")]
        .find((b) => norm(b.textContent) === "Submit"); // scoped to this iframe document only
      if (!submitBtn) throw new Error("modal Submit button not found");
      ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => fire(submitBtn, t));
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  })();
}

// ---------- cross-frame orchestration (runs in the popup, not injected) ----------
async function waitForSubframe(tabId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probeSubform });
    const hit = results.find((r) => r.frameId !== 0 && r.result === true);
    if (hit) return hit.frameId;
    await sleep(400);
  }
  return null;
}
async function waitForSubframeGone(tabId, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const results = await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, func: probeSubform })
      .catch(() => []);
    if (!results.some((r) => r.result === true)) return true;
    await sleep(400);
  }
  return false;
}
// Best-effort: don't throw on timeout — the entry may still have been added
// even if this text-presence heuristic doesn't confirm it (e.g. very long
// descriptions get visually truncated). It just buys the list time to settle.
async function waitForEntryVisible(tabId, description, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const [res] = await chrome.scripting
      .executeScript({ target: { tabId }, func: pageEntryVisible, args: [description] })
      .catch(() => [{}]);
    if (res && res.result) return true;
    await sleep(300);
  }
  return false;
}
async function fillFormOnPage(tabId, entries, name) {
  let added = 0;
  try {
    const [nameRes] = await chrome.scripting.executeScript({ target: { tabId }, func: pageSelectName, args: [name] });
    if (nameRes.result && nameRes.result.error) throw new Error(nameRes.result.error);

    for (const e of entries) {
      const [createRes] = await chrome.scripting.executeScript({ target: { tabId }, func: pageClickCreate });
      if (createRes.result && createRes.result.error) throw new Error(createRes.result.error);

      const frameId = await waitForSubframe(tabId);
      if (frameId == null) throw new Error(`modal did not open for "${e.project}"`);

      const [fillRes] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: frameFillEntry,
        args: [e],
      });
      if (fillRes.result && fillRes.result.error) throw new Error(fillRes.result.error);

      await waitForSubframeGone(tabId);
      await waitForEntryVisible(tabId, e.description);
      added++;
    }
    return { added };
  } catch (err) {
    return { error: err.message, added };
  }
}

// ---------- wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  $("loadNames").onclick = loadNames;
  $("saveName").onclick = saveName;
  if ($("openFullView")) $("openFullView").onclick = openFullView;
  $("changeName").onclick = showSetup;
  $("addProject").onclick = submitDraft;
  $("cancelEdit").onclick = clearDraft;
  $("projSelect").onchange = saveDraft;
  $("catSelect").onchange = saveDraft;
  $("descInput").oninput = saveDraft;
  if ($("timeInput")) $("timeInput").oninput = saveDraft;
  if ($("dayPrev")) $("dayPrev").onclick = () => setViewDate(addDaysStr(viewDate, -1));
  if ($("dayNext")) $("dayNext").onclick = () => setViewDate(addDaysStr(viewDate, 1));
  if ($("todayBtn")) $("todayBtn").onclick = () => setViewDate(S.date);
  if ($("viewDateInput")) $("viewDateInput").onchange = (e) => setViewDate(e.target.value);
  $("finalSubmit").onclick = finalSubmit;
  if ($("markSubmitBtn")) $("markSubmitBtn").onclick = () =>
    daySubmitted(viewDate) ? unmarkDaySubmitted(viewDate) : markDaySubmitted(viewDate, "manual");
  // Reflect an auto-mark written by the form-tab watcher while the popup is open.
  if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.submittedDays) {
        S.submittedDays = changes.submittedDays.newValue || {};
        updateSubmittedUI();
      }
      // Push local edits to Drive shortly after any data change. A pull writes
      // the same keys, but gdSync's signature check makes the follow-up a
      // no-op, so there's no pull↔push loop.
      if (changes.entries || changes.history || changes.date || changes.name) gdSyncSoon();
    });
  }
  setupSearchSelect($("projSelect"), $("projList"), () => PROJECTS);
  setupSearchSelect($("nameSelect"), $("nameList"), () => S.names || []);
  init();
});
