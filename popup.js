"use strict";

const FORM_URL = "https://techzu.fillout.com/t/uhz6TddCX2us";
const PROJECTS = ["Bookland ERP", "Builder Alliance", "Dr Cool", "Hydroflux", "NewERP",
  "Prowork", "Rina CRM", "SME Taskhub", "VSB", "Worksite Mini ERP", "ZuPOS"];
const CATEGORIES = ["Meeting (General)", "Meeting (Technical)", "Development",
  "Code Review", "Miscellaneous"];

let S = {}; // { name, names, date, lastCategory, entries[], timer:{activeId,startedAt} }
let tick = null;

// ---------- utils ----------
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

// ---------- storage / state ----------
async function persist() {
  await chrome.storage.local.set({ entries: S.entries, timer: S.timer });
}
async function init() {
  S = await chrome.storage.local.get(null);
  S.entries = S.entries || [];
  S.timer = S.timer || { activeId: null, startedAt: null };
  const today = todayStr();
  if (S.date !== today) {
    // daily reset: clear projects + timer + draft, keep name/names/lastCategory
    S.entries = [];
    S.timer = { activeId: null, startedAt: null };
    S.draft = null;
    S.date = today;
    await chrome.storage.local.set({ entries: [], timer: S.timer, draft: null, date: today });
  }
  route();
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
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  const sec = hhmmToSec(str);
  e.accSec = sec;
  if (S.timer.activeId === id) S.timer.startedAt = Date.now(); // rebase running timer
  persist();
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
  fillSelect($("catSelect"), CATEGORIES);
  refreshAddForm();
  render();
  $("projSelect").focus();
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
  const editing = !!(d && d.editingId);
  $("addProject").textContent = editing ? "Save changes" : "+ Add Project";
  $("cancelEdit").classList.toggle("hidden", !editing);
}
function saveDraft() {
  S.draft = {
    project: $("projSelect").value,
    category: $("catSelect").value,
    description: $("descInput").value,
    editingId: (S.draft && S.draft.editingId) || null,
  };
  chrome.storage.local.set({ draft: S.draft });
}
function startEdit(id) {
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  S.draft = { project: e.project, category: e.category, description: e.description, editingId: id };
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
function showConfirm(message) {
  return new Promise((resolve) => {
    $("confirmMsg").textContent = message;
    $("confirmOverlay").classList.remove("hidden");
    const done = (result) => {
      $("confirmOverlay").classList.add("hidden");
      $("confirmYes").onclick = null;
      $("confirmNo").onclick = null;
      resolve(result);
    };
    $("confirmYes").onclick = () => done(true);
    $("confirmNo").onclick = () => done(false);
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
  input.addEventListener("focus", () => { beforeFocus = input.value; input.select(); render(""); });
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

// ---------- render entries ----------
function render() {
  const box = $("entries");
  box.innerHTML = "";
  $("emptyMsg").classList.toggle("hidden", S.entries.length > 0);
  for (const e of S.entries) {
    const active = S.timer.activeId === e.id;
    const div = document.createElement("div");
    div.className = "entry" + (active ? " active" : "");
    div.innerHTML = `
      <div class="row1">
        <div>
          <span class="pname"></span>
          <div class="cat"></div>
        </div>
        <div class="acts">
          <button class="edit" title="Edit">Edit</button>
          <button class="del" title="Delete">&times;</button>
        </div>
      </div>
      <div class="desc"></div>
      <div class="row2">
        <button class="tbtn ${active ? "playing" : ""}">${active ? "❚❚" : "▶"}</button>
        <input class="time" type="text" value="${secToHHMM(elapsedSec(e))}">
        <span class="live">${active ? secToHHMMSS(elapsedSec(e)) : ""}</span>
      </div>`;
    div.querySelector(".pname").textContent = e.project;
    div.querySelector(".cat").textContent = e.category;
    div.querySelector(".desc").textContent = e.description;
    div.querySelector(".tbtn").onclick = () => (active ? pauseTimer() : startTimer(e.id));
    div.querySelector(".edit").onclick = () => startEdit(e.id);
    div.querySelector(".del").onclick = () => deleteEntry(e.id);
    const ti = div.querySelector(".time");
    ti.onchange = () => editTime(e.id, ti.value);
    box.appendChild(div);
  }
  startTick();
}
async function deleteEntry(id) {
  if (S.timer.activeId === id) S.timer = { activeId: null, startedAt: null };
  S.entries = S.entries.filter((x) => x.id !== id);
  await persist();
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
  const editingId = S.draft && S.draft.editingId;
  if (editingId) {
    const e = S.entries.find((x) => x.id === editingId);
    if (e) { e.project = project; e.category = cat; e.description = desc; } // keep accSec/timer
  } else {
    S.entries.push({ id: crypto.randomUUID(), project, category: cat, description: desc, accSec: 0 });
  }
  S.lastProject = project;
  S.lastCategory = cat;
  S.draft = null;
  await chrome.storage.local.set({ entries: S.entries, lastProject: project, lastCategory: cat, draft: null });
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

// ---------- final submit ----------
async function finalSubmit() {
  const st = $("submitStatus");
  st.className = "status";
  if (!S.entries.length) {
    st.className = "status err";
    st.textContent = "No projects to submit.";
    return;
  }
  foldActive();
  await persist();
  render();
  const payload = S.entries.map((e) => ({
    project: e.project,
    category: e.category,
    description: e.description,
    hhmm: secToHHMM(elapsedSec(e)),
  }));
  if (payload.every((e) => hhmmToSec(e.hhmm) === 0)) {
    st.className = "status err";
    st.textContent = "All projects are 00:00 — start a timer first.";
    return;
  }
  const zeros = payload.filter((e) => hhmmToSec(e.hhmm) === 0).length;
  const msg = `Submit ${payload.length} project(s) to the timesheet form?` +
    (zeros ? `\n${zeros} have 00:00 time.` : "") +
    `\n\nThis fills entries only — it will NOT click the form's final Submit.`;
  if (!(await showConfirm(msg))) return;

  st.textContent = "Opening form…";
  try {
    const tabId = await ensureFormTab();
    st.textContent = "Filling entries…";
    const out = await fillFormOnPage(tabId, payload, S.name);
    if (out && out.error) {
      st.className = "status err";
      st.textContent = "Stopped: " + out.error + (out.added != null ? ` (${out.added} added)` : "");
    } else {
      st.className = "status ok";
      st.textContent = `Done — ${out ? out.added : payload.length} entries added. Review & Submit manually.`;
    }
  } catch (err) {
    st.className = "status err";
    st.textContent = "Error: " + err.message;
  }
}

async function ensureFormTab() {
  const existing = await chrome.tabs.query({ url: FORM_URL + "*" });
  let tab = existing[0];
  let isNewTab = false;
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    tab = await chrome.tabs.create({ url: FORM_URL + "?name=" + encodeURIComponent(S.name), active: true });
    isNewTab = true;
  }
  await waitTabComplete(tab.id);
  // A fixed sleep here used to guess how long the React app takes to
  // actually become interactive after the tab reports "complete". Confirmed
  // live: on a cold load (first visit, or cleared storage/cache) that can
  // take 1.3s+, longer than any fixed guess reliably covers, while a warm
  // reload is much faster — which is exactly why "first time doesn't work,
  // reload it does" was happening. Poll for real readiness instead.
  await waitForFormReady(tab.id);
  if (isNewTab) {
    // Belt-and-suspenders per user report: even with the readiness poll
    // above, a brand-new cold tab can still be subtly half-hydrated. One
    // reload (now hitting a warm cache) plus re-waiting reproduces exactly
    // the "reload fixed it" workaround automatically. Skipped for a REUSED
    // tab — that may hold in-progress session-only entries a reload would
    // wipe (Fillout entries aren't persisted until the real Submit).
    await chrome.tabs.reload(tab.id);
    await waitTabComplete(tab.id);
    await waitForFormReady(tab.id);
  }
  return tab.id;
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
  $("changeName").onclick = showSetup;
  $("addProject").onclick = submitDraft;
  $("cancelEdit").onclick = clearDraft;
  $("projSelect").onchange = saveDraft;
  $("catSelect").onchange = saveDraft;
  $("descInput").oninput = saveDraft;
  $("finalSubmit").onclick = finalSubmit;
  setupSearchSelect($("projSelect"), $("projList"), () => PROJECTS);
  setupSearchSelect($("nameSelect"), $("nameList"), () => S.names || []);
  init();
});
