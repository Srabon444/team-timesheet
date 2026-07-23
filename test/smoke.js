const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
const jsSrc = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const A = (c, m) => { if (!c) { console.error("  FAIL:", m); fails++; } else console.log("  ok:", m); };

const MOCK_NAMES = ["Ashis Hira", "Prithy Raj Nag", "Debjit Paul"];

// ============================================================
// HARNESS 1 — popup.js driven through mocked chrome + DOM
// ============================================================
async function harness1() {
  console.log("\n== Harness 1: popup UI + storage + orchestration ==");
  const store = {};
  let lastFill = null;
  let reloadCount = 0;
  let queryReturnsExisting = false;
  let tabUpdatedListeners = [];
  const fireTabUpdated = (id, status) => tabUpdatedListeners.forEach((fn) => fn(id, { status }));
  const chrome = {
    storage: { local: {
      get: async (k) => (k === null ? { ...store } : {}),
      set: async (obj) => { Object.assign(store, obj); },
    }},
    tabs: {
      create: async () => ({ id: 1, status: "complete" }),
      get: async () => ({ id: 1, status: "complete" }),
      update: async () => {}, remove: async () => {},
      query: async () => (queryReturnsExisting ? [{ id: 1, status: "complete" }] : []),
      // Fires the onUpdated "complete" event asynchronously (a real reload
      // is never synchronous) so ensureFormTab's event-based wait resolves
      // the same way it would against the real chrome.tabs API.
      reload: async () => { reloadCount++; setTimeout(() => fireTabUpdated(1, "complete"), 5); },
      onUpdated: {
        addListener: (fn) => tabUpdatedListeners.push(fn),
        removeListener: (fn) => { tabUpdatedListeners = tabUpdatedListeners.filter((l) => l !== fn); },
      },
    },
    scripting: { executeScript: async () => [{ result: {} }] }, // fillFormOnPage is stubbed below; harness2 covers real cross-frame automation
  };

  const realForm = fs.readFileSync(path.join(ROOT, "test", "fixtures", "form.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/" });
  const win = dom.window;
  win.chrome = chrome;
  win.matchMedia = win.matchMedia || (() => ({ matches: false }));
  win.fetch = async () => ({ text: async () => realForm });
  let uid = 0;
  win.crypto = { randomUUID: () => "id-" + uid++ };
  const s = win.document.createElement("script");
  s.textContent = jsSrc;
  win.document.body.appendChild(s);
  win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  await sleep(50);
  // finalSubmit()'s own logic (validation/confirm/status) is this harness's
  // concern; the real cross-frame page automation is exercised in harness2.
  let fillFormReturn = { added: 0 };
  win.fillFormOnPage = async (tabId, entries, name) => { lastFill = entries; return fillFormReturn; };
  const $ = (id) => win.document.getElementById(id);
  const vis = (id) => !$(id).classList.contains("hidden");

  A(vis("setup") && !vis("main"), "first run shows setup view");

  // REGRESSION: this is exactly the race that let automation run against a
  // page a moment away from being torn down by its own reload — a tabs.get()
  // poll right after reload() can still read the OLD "complete" status
  // before Chrome flips it to "loading". waitForTabReloadComplete must wait
  // for the real onUpdated event instead, and only for a matching tab id
  // and status "complete" — never resolve early or for the wrong signal.
  {
    let resolved = false;
    const p = win.waitForTabReloadComplete(1).then(() => { resolved = true; });
    await sleep(20);
    A(resolved === false, "waitForTabReloadComplete does not resolve on its own before any onUpdated event");
    fireTabUpdated(2, "complete"); // wrong tab id
    await sleep(20);
    A(resolved === false, "an onUpdated event for a DIFFERENT tab id is ignored");
    fireTabUpdated(1, "loading"); // right tab, wrong status
    await sleep(20);
    A(resolved === false, "an onUpdated event with status other than 'complete' is ignored");
    fireTabUpdated(1, "complete");
    await sleep(20);
    A(resolved === true, "waitForTabReloadComplete resolves once the matching tab id reports status 'complete'");
    await p;
  }
  A(store.dailyLimitHours === 8, "dailyLimitHours default persisted to storage on first init (not just in-memory), so background.js can read it");

  $("loadNames").click();
  await sleep(80);
  A(store.names && store.names.length === 21, "21 names parsed from real form HTML");
  A(store.names.includes("Debjit Paul"), "names persisted incl. Debjit Paul");
  A(JSON.stringify(store.names) === JSON.stringify([...store.names].sort((a, b) => a.localeCompare(b))), "names sorted alphabetically");

  // searchable name combobox: substring match (not just first-letter jump
  // like a native <select>), click-to-select, and Enter-to-select
  $("nameSelect").dispatchEvent(new win.Event("focus"));
  await sleep(10);
  A(win.document.getElementById("nameList").classList.contains("hidden"), "focus alone (e.g. page-load autofocus) does NOT pop the list open");
  $("nameSelect").dispatchEvent(new win.Event("click"));
  await sleep(10);
  A(win.document.querySelectorAll("#nameList .searchItem").length === 21, "clicking an empty search shows all 21 names");
  $("nameSelect").value = "raful"; // mid-word substring of "Ashraful" -- not a prefix
  $("nameSelect").dispatchEvent(new win.Event("input"));
  await sleep(10);
  const midMatches = [...win.document.querySelectorAll("#nameList .searchItem")].map((n) => n.textContent);
  A(midMatches.some((t) => t.includes("Ashraful")), "typing a mid-word substring finds a match (not just first-letter)");
  A(midMatches.length < 21, "substring search actually filters the list down");
  $("nameSelect").value = "ebjit"; // mid-word of "Debjit"
  $("nameSelect").dispatchEvent(new win.Event("input"));
  await sleep(10);
  const row = [...win.document.querySelectorAll("#nameList .searchItem")].find((n) => n.textContent === "Debjit Paul");
  A(!!row, "substring search finds Debjit Paul via mid-word text");
  row.dispatchEvent(new win.Event("mousedown"));
  await sleep(10);
  A($("nameSelect").value === "Debjit Paul", "clicking a search result selects it");
  A(win.document.getElementById("nameList").classList.contains("hidden"), "list closes after selection");

  $("saveName").click();
  await sleep(30);
  A(store.name === "Debjit Paul", "name saved to storage");
  A(vis("main") && !vis("setup"), "main view shown after save");
  A($("whoDate").textContent === store.date && !!store.date, "today's date shown");

  // project searchable combobox: same substring behavior, plus Enter-to-select
  $("projSelect").dispatchEvent(new win.Event("focus"));
  await sleep(10);
  A(win.document.getElementById("projList").classList.contains("hidden"), "focus alone does NOT pop the project list open either");
  $("projSelect").dispatchEvent(new win.Event("click"));
  await sleep(10);
  const projAll = [...win.document.querySelectorAll("#projList .searchItem")].map((n) => n.textContent);
  A(projAll.length === 11, "clicking project search with no filter shows all 11 projects");
  A(JSON.stringify(projAll) === JSON.stringify([...projAll].sort((a, b) => a.localeCompare(b))), "projects list rendered alphabetically sorted");
  $("projSelect").value = "uPO"; // mid-word substring of ZuPOS
  $("projSelect").dispatchEvent(new win.Event("input"));
  await sleep(10);
  const projMatches = [...win.document.querySelectorAll("#projList .searchItem")].map((n) => n.textContent);
  A(projMatches.length === 1 && projMatches[0] === "ZuPOS", "project mid-word substring search finds ZuPOS");
  $("projSelect").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await sleep(10);
  A($("projSelect").value === "ZuPOS", "pressing Enter selects the (only) filtered match");
  A(win.document.getElementById("projList").classList.contains("hidden"), "project list closes after Enter-select");
  $("projSelect").value = "ZuPOS"; // restore for the rest of the test flow below

  $("descInput").value = "   ";
  $("addProject").click();
  await sleep(20);
  A(store.entries === undefined || (store.entries || []).length === 0, "empty description blocked");
  A($("addStatus").textContent.toLowerCase().includes("required"), "shows required error");

  $("projSelect").value = "ZuPOS";
  $("catSelect").value = "Development";
  $("descInput").value = "Build feature X";
  $("addProject").click();
  await sleep(20);
  A(store.entries.length === 1 && store.entries[0].project === "ZuPOS", "project A added");
  A(store.lastCategory === "Development", "lastCategory persisted");
  A(store.lastProject === "ZuPOS", "lastProject persisted");
  A(win.document.querySelectorAll(".entry").length === 1, "one entry rendered");

  // Project select must NOT reset to the first option for the next add —
  // it should still show the just-used project until the user changes it.
  A($("projSelect").value === "ZuPOS", "project select carries over ZuPOS as default for next add (not reset)");

  $("projSelect").value = "VSB"; // user changes it
  $("descInput").value = "Fix bug";
  $("addProject").click();
  await sleep(20);
  A(store.entries.length === 2, "project B added");
  A(store.lastProject === "VSB", "changing project persists the new choice");
  A($("projSelect").value === "VSB", "project select now defaults to the changed value");

  const btnA = win.document.querySelectorAll(".entry")[0].querySelector(".tbtn");
  btnA.click();
  await sleep(20);
  A(store.timer.activeId === store.entries[0].id, "timer A active");
  const btnB = win.document.querySelectorAll(".entry")[1].querySelector(".tbtn");
  btnB.click();
  await sleep(20);
  A(store.timer.activeId === store.entries[1].id, "switching to B makes B active");
  A(store.entries.filter((e) => store.timer.activeId === e.id).length === 1, "only one active timer");

  win.document.querySelectorAll(".entry")[1].querySelector(".tbtn").click();
  await sleep(20);
  A(store.timer.activeId === null, "pause clears active timer");

  const timeInp = win.document.querySelectorAll(".entry")[0].querySelector(".time");
  timeInp.value = "02:30";
  timeInp.dispatchEvent(new win.Event("change"));
  await sleep(20);
  A(store.entries[0].accSec === 9000, "manual time edit -> 2:30 = 9000s");

  // custom in-popup confirm modal (not native window.confirm — that renders
  // cropped/unusable inside a small extension popup)
  lastFill = null;
  $("finalSubmit").click();
  await sleep(30);
  A(!$("confirmOverlay").classList.contains("hidden"), "custom confirm modal shown (no native confirm())");
  A($("confirmMsg").textContent.includes("Submit 2 project"), "modal message summarizes the submission");
  A($("confirmMsg").textContent.length < 400, "modal message is a reasonable length (won't overflow)");
  A($("confirmYes").textContent === "Yes, submit", "Final Submit confirm button reads the default 'Yes, submit'");
  $("confirmNo").click();
  await sleep(30);
  A(lastFill === null, "Cancel in modal -> no form fill");
  A($("confirmOverlay").classList.contains("hidden"), "modal hides after Cancel");

  fillFormReturn = { added: 2 };
  $("finalSubmit").click();
  await sleep(30);
  $("confirmYes").click();
  await sleep(300);
  A(Array.isArray(lastFill) && lastFill.length === 2, "final submit sends 2 entries");
  A(lastFill[0].hhmm === "02:30" && lastFill[1].hhmm === "00:00", "payload carries hh:mm per entry");
  A($("submitStatus").textContent.toLowerCase().includes("added"), "success status shown");
  A($("confirmOverlay").classList.contains("hidden"), "modal hides after Yes");
  // regression guard: user reported cold-start failures fixed by manually
  // reloading; ensureFormTab now auto-reloads once for a brand-NEW tab...
  A(reloadCount === 1, `ensureFormTab reloads once for a newly created tab (got ${reloadCount})`);
  A(store.entries.every((e) => e.submitted), "every entry is marked submitted after a successful Final Submit");

  // BUG FIX regression: clicking Final Submit again with nothing new pending
  // must NOT re-send the already-submitted entries a second time.
  lastFill = null;
  $("finalSubmit").click();
  await sleep(20);
  A(lastFill === null, "Final Submit with everything already submitted does not resubmit anything");
  A($("submitStatus").textContent.toLowerCase().includes("already submitted"), "status explains everything is already submitted");

  // Add ONE new entry -> only that new entry should be sent next time, not
  // the two already-submitted ones. Also re-verifies ensureFormTab now
  // ALWAYS reloads before automation starts, even for a reused tab (user
  // explicitly wants this every time, accepting that it discards any
  // in-progress session-only entries already on that tab — Fillout doesn't
  // persist entries until the real Submit).
  reloadCount = 0;
  queryReturnsExisting = true;
  $("projSelect").value = "Hydroflux";
  $("descInput").value = "Third task";
  $("addProject").click();
  await sleep(20);
  const entryTimes = win.document.querySelectorAll(".entry .time");
  const thirdTimeInp = entryTimes[entryTimes.length - 1];
  thirdTimeInp.value = "00:45";
  thirdTimeInp.dispatchEvent(new win.Event("change"));
  await sleep(20);
  lastFill = null;
  fillFormReturn = { added: 1 };
  $("finalSubmit").click();
  await sleep(30);
  A($("confirmMsg").textContent.includes("Submit 1 project"), "confirm modal counts only the new pending entry, not the already-submitted ones");
  $("confirmYes").click();
  await sleep(300);
  A(Array.isArray(lastFill) && lastFill.length === 1 && lastFill[0].description === "Third task", "second Final Submit re-sends only the NEW entry — no duplicates of the first two");
  A(reloadCount === 1, `ensureFormTab reloads a reused tab too, every time (got ${reloadCount})`);
  queryReturnsExisting = false;

  // delete an entry
  const countBeforeDelete = store.entries.length;
  win.document.querySelector(".entry .del").click();
  await sleep(20);
  $("confirmYes").click();
  await sleep(20);
  A(store.entries.length === countBeforeDelete - 1, "delete removes entry");

  // EDIT an existing entry
  win.document.querySelector(".entry .edit").click();
  await sleep(20);
  A(store.draft && store.draft.editingId === store.entries[0].id, "Edit loads entry into draft");
  A($("addProject").textContent === "Save changes", "add button becomes Save in edit mode");
  A(vis("cancelEdit"), "cancel button visible in edit mode");
  $("descInput").value = "Edited description";
  $("descInput").dispatchEvent(new win.Event("input"));
  await sleep(20);
  A(store.draft.description === "Edited description", "edit draft persists description");
  $("addProject").click();
  await sleep(20);
  A(store.entries[0].description === "Edited description", "save updates the entry");
  A(store.draft === null, "draft cleared after save");
  A($("addProject").textContent === "+ Add Project", "add button reverts after save");
  A(!vis("cancelEdit"), "cancel button hidden after save");

  // CATEGORY COLOR CODING: each rendered entry's category badge gets a
  // distinct background color, and an unrecognized category falls back
  // gracefully instead of rendering blank/uncolored.
  const catEl = win.document.querySelector(".entry .cat");
  A(catEl && catEl.style.background, "category badge has a background color set");
  A(win.categoryColor("Development") !== win.categoryColor("Code Review"), "different categories get different colors");
  A(win.categoryColor("Development") === win.categoryColor("Development"), "same category is always the same color");
  A(!!win.categoryColor("Some Unknown Category"), "an unrecognized category still gets a fallback color, not blank/undefined");

  // PROJECT COLOR CODING: same treatment as category, on the project badge.
  const pnameEl = win.document.querySelector(".entry .pname");
  A(pnameEl && pnameEl.style.background, "project badge has a background color set");
  A(win.projectColor("ZuPOS") !== win.projectColor("VSB"), "different projects get different colors");
  A(win.projectColor("ZuPOS") === win.projectColor("ZuPOS"), "same project is always the same color");
  A(win.projectColor("ZuPOS") !== win.categoryColor("Development"), "project and category palettes don't collide on this pair");
  A(!!win.projectColor("Some Unknown Project"), "an unrecognized project still gets a fallback color, not blank/undefined");

  // DRAFT persistence across popup reopen (half-filled, not added)
  $("descInput").value = "half typed";
  $("descInput").dispatchEvent(new win.Event("input"));
  $("projSelect").value = "Hydroflux";
  $("projSelect").dispatchEvent(new win.Event("change"));
  await sleep(20);
  A(store.draft && store.draft.description === "half typed", "draft saved on input");
  await win.init(); // simulate reopening the popup (re-reads storage)
  await sleep(30);
  A($("descInput").value === "half typed" && $("projSelect").value === "Hydroflux", "draft restored on reopen");

  // daily reset
  store.date = "2000-01-01";
  await win.init();
  await sleep(30);
  A(store.entries.length === 0, "daily reset clears entries");
  A(store.name === "Debjit Paul" && store.lastCategory === "Development", "reset keeps name + lastCategory");
  A(!store.draft, "daily reset clears draft");
  A($("descInput").value === "", "add-form cleared after daily reset");

  // HISTORY ARCHIVING: add an entry on the "old" day, then roll the date
  // forward and confirm it got archived under the outgoing date, not lost.
  $("projSelect").value = "ZuPOS";
  $("catSelect").value = "Development";
  $("descInput").value = "Archived task";
  $("addProject").click();
  await sleep(20);
  const archivedTimeInp = win.document.querySelector(".entry .time");
  archivedTimeInp.value = "01:00";
  archivedTimeInp.dispatchEvent(new win.Event("change"));
  await sleep(20);
  const outgoingDate = store.date;
  const realTodayStr = win.todayStr;
  win.todayStr = () => "2099-01-01"; // simulate a later calendar day arriving, without corrupting the stored date
  await win.init();
  win.todayStr = realTodayStr;
  await sleep(30);
  A(store.history && Array.isArray(store.history[outgoingDate]), `history archived under the outgoing date (${outgoingDate})`);
  A(store.history[outgoingDate][0].description === "Archived task" && store.history[outgoingDate][0].accSec === 3600, "archived entry keeps its description and folded time");
  A(store.entries.length === 0, "entries still clear on rollover after archiving");
  A(store.date === "2099-01-01", "date advances to the new day");

  // first-ever run (no prior S.date at all) must NOT write a bogus history entry
  const store2 = {};
  const chrome2 = { storage: { local: {
    get: async (k) => (k === null ? { ...store2 } : {}),
    set: async (obj) => { Object.assign(store2, obj); },
  } } };
  const dom2 = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/" });
  dom2.window.chrome = chrome2;
  dom2.window.fetch = async () => ({ text: async () => realForm });
  dom2.window.crypto = { randomUUID: () => "id-first" };
  const s2 = dom2.window.document.createElement("script");
  s2.textContent = jsSrc;
  dom2.window.document.body.appendChild(s2);
  dom2.window.document.dispatchEvent(new dom2.window.Event("DOMContentLoaded"));
  await sleep(50);
  A(store2.history && Object.keys(store2.history).length === 0, "first-ever run does not archive a bogus history entry");
  dom2.window.close();

  $("finalSubmit").click();
  await sleep(20);
  A($("submitStatus").textContent.toLowerCase().includes("no projects"), "blocks submit with no entries");

  // CONFIRM-BEFORE-DELETE: default true -> delete must go through the modal
  $("projSelect").value = "ZuPOS";
  $("descInput").value = "Delete-confirm test";
  $("addProject").click();
  await sleep(20);
  const beforeCount = store.entries.length;
  win.document.querySelector(".entry .del").click();
  await sleep(20);
  A(!$("confirmOverlay").classList.contains("hidden"), "delete with confirmBeforeDelete on shows the modal");
  A($("confirmYes").textContent === "Yes, delete", "delete confirm button reads 'Yes, delete', not the generic 'Yes, submit'");
  A(store.entries.length === beforeCount, "entry not yet deleted while modal is open");
  $("confirmNo").click();
  await sleep(20);
  A(store.entries.length === beforeCount, "Cancel in delete modal keeps the entry");
  win.document.querySelector(".entry .del").click();
  await sleep(20);
  $("confirmYes").click();
  await sleep(20);
  A(store.entries.length === beforeCount - 1, "Yes in delete modal removes the entry");

  // confirmBeforeDelete: false -> deletes immediately, no modal
  store.confirmBeforeDelete = false;
  win.S.confirmBeforeDelete = false;
  $("projSelect").value = "ZuPOS";
  $("descInput").value = "No-confirm delete test";
  $("addProject").click();
  await sleep(20);
  const beforeCount2 = store.entries.length;
  win.document.querySelector(".entry .del").click();
  await sleep(20);
  A($("confirmOverlay").classList.contains("hidden"), "delete with confirmBeforeDelete off skips the modal");
  A(store.entries.length === beforeCount2 - 1, "entry deleted immediately when confirmBeforeDelete is off");

  // THEME: resolveTheme + applyTheme + data-theme attribute reflects on load
  A(win.resolveTheme("dark") === "dark" && win.resolveTheme("light") === "light", "resolveTheme passes through explicit dark/light");
  A(win.resolveTheme("system") === "dark" || win.resolveTheme("system") === "light", "resolveTheme resolves system to a concrete value");
  win.applyTheme("light");
  await sleep(10);
  A(win.document.documentElement.dataset.theme === "light", "applyTheme sets data-theme on the document");
  A(store.theme === "light", "applyTheme persists the choice to storage");

  // OPEN FULL VIEW: opens tab.html, or focuses it if already open
  let openedTabUrl = null;
  let focusedTabId = null;
  win.chrome.tabs.query = async ({ url }) => (url && url.includes("tab.html") ? [] : []);
  win.chrome.tabs.create = async (opts) => { openedTabUrl = opts.url; return { id: 2 }; };
  win.chrome.runtime = { getURL: (p) => "chrome-extension://fake-id/" + p };
  $("openFullView").click();
  await sleep(20);
  A(openedTabUrl === "chrome-extension://fake-id/tab.html", "Open full view creates a tab.html tab when none is open");

  win.chrome.tabs.query = async ({ url }) => (url && url.includes("tab.html") ? [{ id: 7 }] : []);
  win.chrome.tabs.update = async (id, opts) => { focusedTabId = id; };
  openedTabUrl = null;
  $("openFullView").click();
  await sleep(20);
  A(openedTabUrl === null && focusedTabId === 7, "Open full view focuses an already-open tab.html tab instead of opening a second one");

  dom.window.close();
}

// ============================================================
// HARNESS 2 — fillFormOnPage cross-frame orchestration against a
// react-select + real-iframe-shaped mock (matches the live Fillout DOM
// confirmed via headless Chrome: Create opens a genuine subform <iframe>
// with its own document, react-select controls use .react-select__control /
// .react-select__placeholder / input[role=combobox] / .react-select__single-value).
// ============================================================
function buildReactSelectControl(doc, placeholder) {
  const control = doc.createElement("div");
  control.className = "react-select__control";
  const ph = doc.createElement("div");
  ph.className = "react-select__placeholder";
  ph.textContent = placeholder;
  const input = doc.createElement("input");
  input.setAttribute("role", "combobox");
  control.appendChild(ph);
  control.appendChild(input);
  let typed = "";
  input.addEventListener("input", () => { typed = input.value; });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    control.querySelector(".react-select__placeholder")?.remove();
    control.querySelector(".react-select__single-value")?.remove();
    const sv = doc.createElement("div");
    sv.className = "react-select__single-value";
    sv.textContent = typed;
    control.appendChild(sv);
  });
  return control;
}
function runFuncInWindow(w, fn, args) {
  const wrapped = new w.Function("args", `return (${fn.toString()}).apply(null, args);`);
  return wrapped(args);
}

async function harness2() {
  console.log("\n== Harness 2: fillFormOnPage cross-frame orchestration vs real-shaped mock ==");

  const topDom = new JSDOM(`<body></body>`, { runScripts: "dangerously" });
  const topWin = topDom.window;
  const patchOffsetParent = (w) => {
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get() { return this.isConnected && this.style.display !== "none" ? (this.parentNode || w.document.body) : null; },
    });
    // jsdom doesn't implement innerText (returns undefined) — pageEntryVisible
    // (real popup.js code) relies on it, so shim it to textContent for the mock.
    Object.defineProperty(w.HTMLElement.prototype, "innerText", {
      configurable: true,
      get() { return this.textContent; },
    });
  };
  patchOffsetParent(topWin);

  let subWin = null;      // set when "Create" opens the subform (mirrors the real <iframe>)
  const filled = [];      // entries the mock subform Submit actually received
  let mainSubmitClicked = false;
  let createClicks = 0;

  function buildSubWindow() {
    const d = new JSDOM(`<body></body>`, { runScripts: "dangerously" });
    patchOffsetParent(d.window);
    const doc = d.window.document;
    doc.body.appendChild(buildReactSelectControl(doc, "Select Project"));
    doc.body.appendChild(buildReactSelectControl(doc, "Select Work Category"));
    const desc = doc.createElement("input"); desc.placeholder = "Task Description"; doc.body.appendChild(desc);
    const time = doc.createElement("input"); time.placeholder = "Hours Clocked (hh:mm)"; time.value = "00:00"; doc.body.appendChild(time);
    const submit = doc.createElement("button"); submit.textContent = "Submit"; doc.body.appendChild(submit);
    submit.addEventListener("click", () => {
      filled.push({
        project: doc.querySelectorAll(".react-select__single-value")[0]?.textContent,
        category: doc.querySelectorAll(".react-select__single-value")[1]?.textContent,
        description: desc.value,
        time: time.value,
      });
      const descText = desc.value;
      subWin = null; // subform closes -> back to main list, matches real Fillout behavior
      // Mirrors the real Fillout race confirmed live: the entries list does its
      // own async refresh after the modal closes, so the new entry's text only
      // becomes visible a bit later — waitForEntryVisible must actually wait for it.
      setTimeout(() => {
        const p = topWin.document.createElement("div");
        p.textContent = descText;
        topWin.document.body.appendChild(p);
      }, 150);
    });
    return d.window;
  }

  // top-page mock: Name react-select + Create + a decoy main-form Submit
  // that must NEVER be clicked by the automation.
  topWin.document.body.appendChild(buildReactSelectControl(topWin.document, "Name"));
  const create = topWin.document.createElement("div");
  create.textContent = "Create";
  create.addEventListener("click", () => { createClicks++; subWin = buildSubWindow(); });
  topWin.document.body.appendChild(create);
  const mainSubmit = topWin.document.createElement("button"); // FORBIDDEN
  mainSubmit.textContent = "Submit";
  mainSubmit.addEventListener("click", () => { mainSubmitClicked = true; });
  topWin.document.body.appendChild(mainSubmit);

  // popup.js's own fillFormOnPage/waitForSubframe/waitForSubframeGone call
  // chrome.scripting.executeScript — mock it to run the REAL extracted
  // function source against whichever real document (top or sub) it targets,
  // exactly mirroring Chrome's per-frame execution semantics.
  const chrome = {
    scripting: {
      executeScript: async ({ target, func, args }) => {
        args = args || [];
        if (target.allFrames) {
          const out = [{ frameId: 0, result: await runFuncInWindow(topWin, func, args) }];
          if (subWin) out.push({ frameId: 99, result: await runFuncInWindow(subWin, func, args) });
          return out;
        }
        if (target.frameIds) {
          const w = target.frameIds[0] === 0 ? topWin : subWin;
          return [{ frameId: target.frameIds[0], result: await runFuncInWindow(w, func, args) }];
        }
        return [{ frameId: 0, result: await runFuncInWindow(topWin, func, args) }];
      },
    },
  };

  // load the real popup.js so fillFormOnPage/pageSelectName/pageClickCreate/
  // probeSubform/frameFillEntry are the actual shipped functions, unmodified.
  const shellDom = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/" });
  const shell = shellDom.window;
  // init()/DOMContentLoaded wiring runs regardless — give it harmless stubs
  // so it doesn't throw; this harness only exercises fillFormOnPage itself.
  chrome.storage = { local: { get: async () => ({}), set: async () => {} } };
  chrome.tabs = {
    query: async () => [], create: async () => ({ id: 1, status: "complete" }),
    get: async () => ({ status: "complete" }), update: async () => {},
  };
  shell.chrome = chrome;
  shell.fetch = async () => ({ text: async () => "" });
  const s = shell.document.createElement("script");
  s.textContent = jsSrc;
  shell.document.body.appendChild(s);
  await sleep(20);

  const entries = [
    { project: "ZuPOS", category: "Development", description: "task one", hhmm: "02:30" },
    { project: "VSB", category: "Code Review", description: "task two", hhmm: "01:15" },
  ];
  const raceStart = Date.now();
  const r = await shell.fillFormOnPage(1, entries, "Debjit Paul");
  const raceElapsed = Date.now() - raceStart;
  if (r && r.error) console.log("  [debug] fillFormOnPage result:", JSON.stringify(r));
  A(r && r.added === 2 && !r.error, "fillFormOnPage added 2 entries without error");
  // regression guard for the reported "worked once, then Create silently did
  // nothing on retry" bug: confirmed live that Fillout's entries list does an
  // async refresh after the modal closes, so fillFormOnPage must wait for
  // each entry's text to actually appear (mock delays it by 150ms) before
  // clicking Create again — if this ever regresses to zero wait, this fails.
  A(raceElapsed >= 300, `fillFormOnPage waited for the entries-list race (took ${raceElapsed}ms, expected >=300ms for 2 entries)`);
  A(filled.length === 2, "real subform mock captured 2 submitted entries");
  A(filled[0].project === "ZuPOS" && filled[0].category === "Development", "entry 1 project+category filled via type+Enter");
  A(filled[0].description === "task one" && filled[0].time === "02:30", "entry 1 description+time filled");
  A(filled[1].project === "VSB" && filled[1].time === "01:15", "entry 2 filled");
  A(mainSubmitClicked === false, "main form Submit was NEVER clicked (frameFillEntry runs in a separate document)");
  A(createClicks === 2, "Create clicked once per entry");
  A(subWin === null, "subform closed after the final entry");

  // second run in the same top window: Name already shows the correct value
  // -> pageSelectName must skip re-selecting it (no flicker/reselect).
  const nameCombo = topWin.document.querySelector(".react-select__single-value");
  A(nameCombo && nameCombo.textContent === "Debjit Paul", "Name shows the selected value after run 1");
  const [skipRes] = await chrome.scripting.executeScript({
    target: { tabId: 1 }, func: shell.pageSelectName, args: ["Debjit Paul"],
  });
  A(skipRes.result && skipRes.result.skipped === true, "pageSelectName skips reselecting an already-correct name");

  topDom.window.close();
  shellDom.window.close();
}

// ============================================================
// HARNESS 3 — background.js live badge (alarms + storage.onChanged)
// ============================================================
async function harness3() {
  console.log("\n== Harness 3: background.js live badge/tooltip ==");
  const bgSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  let badge = { text: null, color: null, title: null };
  let alarmCfg = null; // null = cleared
  const listeners = { changed: [], installed: [], startup: [], alarm: [] };
  let store = { timer: { activeId: null, startedAt: null }, entries: [] };
  const chrome = {
    action: {
      setBadgeText: ({ text }) => { badge.text = text; },
      setBadgeBackgroundColor: ({ color }) => { badge.color = color; },
      setTitle: ({ title }) => { badge.title = title; },
    },
    storage: {
      local: {
        get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]])) : { [k]: store[k] }),
        set: async (obj) => { Object.assign(store, obj); },
      },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) },
    },
    alarms: {
      create: (name, cfg) => { alarmCfg = { name, ...cfg }; },
      clear: () => { alarmCfg = null; },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    runtime: {
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    },
  };
  // simulates a real chrome.storage.local.set: mutates store, fires onChanged
  const fireChange = (patch) => {
    Object.assign(store, patch);
    const changes = Object.fromEntries(Object.keys(patch).map((k) => [k, { newValue: patch[k] }]));
    listeners.changed.forEach((f) => f(changes, "local"));
  };
  const fn = new Function("chrome", bgSrc + "\n//# sourceURL=background.js");
  fn(chrome);
  await sleep(20); // let the top-level syncBadge() resolve

  A(badge.text === "OFF" && badge.color === "#64748b", "initial state (no timer) shows OFF/gray");
  A(alarmCfg === null, "no alarm scheduled while idle");
  A(badge.title.includes("no timer running"), "idle tooltip says no timer running");

  // start a timer on entry "e1" (ZuPOS), ~5s ago
  store.entries = [{ id: "e1", project: "ZuPOS", accSec: 0 }];
  fireChange({ timer: { activeId: "e1", startedAt: Date.now() - 5000 } });
  await sleep(20);
  A(badge.color === "#16a34a", "timer start -> badge turns green");
  A(alarmCfg && alarmCfg.name === "tick" && alarmCfg.periodInMinutes === 1, "1-minute repeating alarm scheduled");
  A(/^\d+m$/.test(badge.text), "under an hour -> badge shows minutes, e.g. 0m");
  A(badge.title.includes("ZuPOS") && badge.title.startsWith("Running:"), "tooltip names the running project");

  // simulate an alarm tick with over an hour elapsed -> hour-precision badge
  store.entries[0].accSec = 3661; // 1h01m01s
  listeners.alarm.forEach((f) => f({ name: "tick" }));
  await sleep(20);
  A(badge.text === "1h", ">=1h elapsed -> badge collapses to whole hours (e.g. 1h)");
  A(/01:0\d:\d\d/.test(badge.title), "tooltip shows full hh:mm:ss detail");

  // an alarm event for a different name is ignored
  badge.text = "1h";
  listeners.alarm.forEach((f) => f({ name: "someOtherAlarm" }));
  A(badge.text === "1h", "unrelated alarm name ignored");

  // pause -> activeId null
  fireChange({ timer: { activeId: null, startedAt: null } });
  await sleep(20);
  A(badge.text === "OFF" && badge.color === "#64748b", "timer pause -> badge back to OFF/gray");
  A(alarmCfg === null, "alarm cleared on pause");

  // unrelated storage key change (no "timer" in patch) -> badge untouched
  badge.text = "OFF";
  const changesNoTimer = { entries: { newValue: [] } };
  listeners.changed.forEach((f) => f(changesNoTimer, "local"));
  await sleep(10);
  A(badge.text === "OFF", "storage change without a timer key does not re-sync badge");

  // service worker restart while a timer was already running (onStartup re-syncs)
  store.timer = { activeId: "e1", startedAt: Date.now() };
  store.entries[0].accSec = 0;
  badge = { text: null, color: null, title: null };
  await Promise.all(listeners.startup.map((f) => f()));
  await sleep(20);
  A(badge.color === "#16a34a" && alarmCfg !== null, "onStartup re-syncs badge + alarm to running state from storage");

  // DAILY LIMIT NOTIFICATION
  const notifications = [];
  chrome.notifications = { create: (id, opts) => { notifications.push({ id, opts }); } };
  store.dailyLimitHours = 1; // 1 hour, easy to cross in the test
  store.warnedDate = null;
  store.date = "2026-07-10";
  store.entries = [{ id: "e1", project: "ZuPOS", accSec: 0 }];
  store.timer = { activeId: null, startedAt: null };

  // under the limit -> no notification
  fireChange({ entries: [{ id: "e1", project: "ZuPOS", accSec: 1800 }] }); // 30 min
  await sleep(20);
  A(notifications.length === 0, "no notification while under the daily limit");

  // crosses the limit -> fires exactly once
  fireChange({ entries: [{ id: "e1", project: "ZuPOS", accSec: 3700 }] }); // 61 min > 1h limit
  await sleep(20);
  A(notifications.length === 1, "notification fires once when crossing the daily limit");
  A(store.warnedDate === store.date, "warnedDate recorded after firing");

  // still over the limit on a later change same day -> does not fire again
  fireChange({ entries: [{ id: "e1", project: "ZuPOS", accSec: 4000 }] });
  await sleep(20);
  A(notifications.length === 1, "notification does not repeat the same day");

  // new day -> warnedDate no longer matches -> can fire again
  store.date = "2026-07-11";
  store.warnedDate = "2026-07-10";
  fireChange({ entries: [{ id: "e1", project: "ZuPOS", accSec: 4000 }] });
  await sleep(20);
  A(notifications.length === 2, "notification can fire again on a new day");

  // A timer left silently RUNNING can cross the limit with no storage write
  // happening at that exact moment — the 1-minute alarm tick must catch it
  // too, not just storage.onChanged.
  store.date = "2026-07-12";
  store.warnedDate = null;
  store.entries = [{ id: "e1", project: "ZuPOS", accSec: 0 }];
  store.timer = { activeId: "e1", startedAt: Date.now() - 61 * 60 * 1000 }; // running 61 min, no accSec yet
  listeners.alarm.forEach((f) => f({ name: "tick" }));
  await sleep(20);
  A(notifications.length === 3, "alarm tick alone catches a live-running timer crossing the limit, without any storage.onChanged firing");
}

// ============================================================
// HARNESS 4 — pageFormReady logic + guard against a fixed-sleep regression
// ============================================================
async function harness4() {
  console.log("\n== Harness 4: cold-load readiness fix ==");

  // Regression guard: this exact bug ("worked on reload, not on first load")
  // was a fixed `sleep(1200)` racing real page-hydration time on cold loads
  // (confirmed live: cold ~1.3s+, warm ~0.8s). ensureFormTab must poll for
  // real readiness instead of guessing a constant.
  A(!/await sleep\(1200\)/.test(jsSrc), "ensureFormTab no longer uses a fixed 1200ms guess");
  A(jsSrc.includes("waitForFormReady"), "ensureFormTab waits for real page readiness");

  const start = jsSrc.indexOf("function pageFormReady");
  const end = jsSrc.indexOf("async function waitForFormReady");
  const src = jsSrc.slice(start, end);
  A(start > 0 && end > start, "extracted pageFormReady from source");

  const dom = new JSDOM(`<body></body>`, { runScripts: "dangerously" });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() { return this.isConnected && this.style.display !== "none" ? (this.parentNode || win.document.body) : null; },
  });
  win.eval(src);

  A(win.pageFormReady() === false, "not ready on a blank page (nothing rendered yet)");

  const ph = win.document.createElement("div");
  ph.className = "react-select__placeholder";
  ph.textContent = "Name";
  win.document.body.appendChild(ph);
  A(win.pageFormReady() === true, "ready once the Name placeholder exists (fresh/cold load case)");
  ph.remove();
  A(win.pageFormReady() === false, "not ready again once placeholder removed");

  const sv = win.document.createElement("div");
  sv.className = "react-select__single-value";
  sv.textContent = "Md Ashraful Islam";
  win.document.body.appendChild(sv);
  A(win.pageFormReady() === true, "ready once Name already shows a selected value (reused-tab case)");
  sv.remove();

  const create = win.document.createElement("div");
  create.textContent = "Create";
  win.document.body.appendChild(create);
  A(win.pageFormReady() === true, "ready once the Create button exists (fallback signal)");

  dom.window.close();
}

// ============================================================
// HARNESS 5 — tab.html shell: sidebar nav + Today section reuses popup.js
// ============================================================
async function harness5() {
  console.log("\n== Harness 5: tab shell nav + Today section reuse ==");
  const tabHtml = fs.readFileSync(path.join(ROOT, "tab.html"), "utf8");
  const tabJsSrc = fs.readFileSync(path.join(ROOT, "tab.js"), "utf8");
  const store = {};
  const chrome = {
    storage: { local: {
      get: async (k) => (k === null ? { ...store } : {}),
      set: async (obj) => { Object.assign(store, obj); },
    }},
    tabs: { query: async () => [], create: async () => ({ id: 1, status: "complete" }), get: async () => ({ status: "complete" }), update: async () => {} },
    scripting: { executeScript: async () => [{ result: {} }] },
  };
  const dom = new JSDOM(tabHtml, { runScripts: "dangerously", url: "https://localhost/" });
  const win = dom.window;
  win.chrome = chrome;
  win.matchMedia = () => ({ matches: false });
  win.fetch = async () => ({ text: async () => "" });
  win.crypto = { randomUUID: () => "id-tab" };
  const s1 = win.document.createElement("script");
  s1.textContent = jsSrc; // popup.js
  win.document.body.appendChild(s1);
  const s2 = win.document.createElement("script");
  s2.textContent = tabJsSrc;
  win.document.body.appendChild(s2);
  win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  await sleep(50);

  const $ = (id) => win.document.getElementById(id);
  A(!$("panelToday").classList.contains("hidden"), "Today panel visible by default");
  A($("panelDashboard").classList.contains("hidden"), "Dashboard panel hidden by default");
  A(!$("setup").classList.contains("hidden"), "Today panel's setup view shows (popup.js's route() runs unmodified in the tab)");

  $("navDashboard").click();
  await sleep(10);
  A($("panelToday").classList.contains("hidden"), "clicking Dashboard nav hides Today panel");
  A(!$("panelDashboard").classList.contains("hidden"), "clicking Dashboard nav shows Dashboard panel");
  A($("navDashboard").classList.contains("active"), "Dashboard nav button marked active");
  A(!$("navToday").classList.contains("active"), "Today nav button no longer active");

  $("navSettings").click();
  await sleep(10);
  A(!$("panelSettings").classList.contains("hidden"), "clicking Settings nav shows Settings panel");

  $("navToday").click();
  await sleep(10);
  A(!$("panelToday").classList.contains("hidden"), "clicking Today nav returns to Today panel");

  // DASHBOARD RENDERING: seed one entry, open Dashboard, confirm it reflects
  $("navToday").click();
  await sleep(10);
  $("loadNames") && ($("loadNames").click(), await sleep(80)); // no-op if already past setup
  if (!win.document.getElementById("main").classList.contains("hidden") === false) {
    // still on setup (no names loaded in this harness) — set name directly via storage + reinit
  }
  store.name = "Debjit Paul";
  store.date = win.todayStr(); // the "live" day, or init()'s daily reset archives this seed away
  store.entries = [{ id: "e1", project: "ZuPOS", category: "Development", description: "x", accSec: 3600 }];
  store.timer = { activeId: null, startedAt: null };
  await win.init();
  await sleep(20);

  $("navDashboard").click();
  await sleep(20);
  A($("tileToday").textContent === "01:00", "Today tile reflects today's tracked time");
  A($("weekChart").children.length === 7, "week chart renders 7 day columns");
  A($("byProjectList").textContent.includes("ZuPOS"), "by-project breakdown lists ZuPOS");
  A($("byCategoryList").textContent.includes("Development"), "by-category breakdown lists Development");
  const catBar = win.document.querySelector("#byCategoryList .breakdownRow .bar > span");
  // jsdom normalizes hex -> rgb() on style read-back, so compare both sides
  // through the same normalization rather than the raw hex string.
  const expectedCatColor = win.document.createElement("div");
  expectedCatColor.style.background = win.categoryColor("Development");
  A(catBar && catBar.style.background === expectedCatColor.style.background, "Dashboard's by-category bar is colored per-category, not a generic accent color");

  const prevLabel = $("weekLabel").textContent;
  $("weekPrev").click();
  await sleep(20);
  A($("weekLabel").textContent !== prevLabel, "clicking the previous-week arrow changes the visible week");
  $("weekNext").click();
  await sleep(20);
  A($("weekLabel").textContent === prevLabel, "clicking next returns to the original week");

  // SETTINGS: daily limit, confirm-before-delete, theme, reset everything
  $("navSettings").click();
  await sleep(20);
  A($("dailyLimitSelect").value === "8", "daily limit select reflects the default (8h)");
  A($("confirmDeleteToggle").checked === true, "confirm-before-delete checkbox reflects the default (on)");

  $("dailyLimitSelect").value = "4";
  $("dailyLimitSelect").dispatchEvent(new win.Event("change"));
  await sleep(20);
  A(store.dailyLimitHours === 4, "changing the daily limit select persists it");

  $("confirmDeleteToggle").checked = false;
  $("confirmDeleteToggle").dispatchEvent(new win.Event("change"));
  await sleep(20);
  A(store.confirmBeforeDelete === false, "unchecking confirm-before-delete persists it off");

  $("themeLight").click();
  await sleep(20);
  A(store.theme === "light", "clicking Light persists the theme");
  A(win.document.documentElement.dataset.theme === "light", "clicking Light applies data-theme immediately");

  // name picker in Settings updates S.name and refreshes the Today panel
  store.names = ["Debjit Paul", "Ashis Hira"];
  win.S.names = store.names;
  $("settingsNameInput").dispatchEvent(new win.Event("focus"));
  $("settingsNameInput").dispatchEvent(new win.Event("click"));
  await sleep(10);
  const settingsRow = [...win.document.querySelectorAll("#settingsNameList .searchItem")].find((n) => n.textContent === "Ashis Hira");
  A(!!settingsRow, "Settings name picker lists names from S.names");
  settingsRow.dispatchEvent(new win.Event("mousedown"));
  await sleep(20);
  A(store.name === "Ashis Hira", "picking a name in Settings updates the saved name");

  // reset everything — goes through showConfirm, clears data, keeps name
  store.entries = [{ id: "e9", project: "ZuPOS", category: "Development", description: "keep-or-not", accSec: 100 }];
  store.history = { "2026-07-01": [{ id: "old", project: "VSB", category: "Development", accSec: 500 }] };
  await win.init();
  await sleep(20);
  $("resetEverything").click();
  await sleep(20);
  A(!$("confirmOverlay").classList.contains("hidden"), "Reset everything shows the confirm modal (never native confirm())");
  A($("confirmYes").textContent === "Yes, reset", "reset confirm button reads 'Yes, reset', not the generic 'Yes, submit'");
  $("confirmYes").click();
  await sleep(20);
  A(store.entries.length === 0, "reset clears entries");
  A(store.history && Object.keys(store.history).length === 0, "reset clears history");
  A(store.dailyLimitHours === 8, "reset restores the default daily limit");
  A(store.confirmBeforeDelete === true, "reset restores confirm-before-delete to on");
  A(store.theme === "dark", "reset restores the default theme");
  A(store.name === "Ashis Hira", "reset KEEPS the name");

  dom.window.close();
}

// ============================================================
// HARNESS 6 — Dashboard math (pure functions) against a synthetic fixture
// ============================================================
async function harness6() {
  console.log("\n== Harness 6: dashboard math ==");
  const tabJsSrc = fs.readFileSync(path.join(ROOT, "tab.js"), "utf8");
  const ctx = {};
  // pure functions have no DOM/chrome dependency — eval directly into a plain object.
  // tab.js still has a top-level document.addEventListener(...) call (Task 6's nav wiring),
  // which runs immediately on eval — stub `document` so that doesn't throw before the
  // pure function declarations (hoisted above it) land on ctx. Also stub `pad`, a popup.js
  // global that mondayOf/weekDates rely on (popup.js isn't loaded in this isolated context).
  ctx.document = { addEventListener: () => {} };
  ctx.pad = (n) => String(n).padStart(2, "0");
  const vm = require("vm");
  vm.createContext(ctx);
  vm.runInContext(tabJsSrc, ctx);

  const fixture = {
    "2026-07-06": [{ project: "ZuPOS", category: "Development", accSec: 3600 }],          // Mon, 1h
    "2026-07-07": [],                                                                      // Tue, nothing
    "2026-07-08": [{ project: "ZuPOS", category: "Development", accSec: 1800 },
                    { project: "VSB", category: "Code Review", accSec: 1800 }],            // Wed, 1h total
    "2026-07-09": [{ project: "VSB", category: "Meeting (General)", accSec: 7200 }],       // Thu, 2h (busiest)
    "2026-07-10": [{ project: "ZuPOS", category: "Development", accSec: 900 }],            // Fri, 15m
  };

  A(ctx.dayTotal(fixture["2026-07-08"]) === 3600, "dayTotal sums a day's entries");
  A(ctx.dayTotal([]) === 0, "dayTotal of an empty day is 0");

  A(ctx.trackedTotal(fixture) === 3600 + 0 + 3600 + 7200 + 900, "trackedTotal sums every day");

  A(ctx.activeDayCount(fixture) === 4, "activeDayCount counts only days with entries (Tue excluded)");

  A(ctx.dailyAverage(fixture) === Math.round((3600 + 3600 + 7200 + 900) / 4), "dailyAverage divides by active days, not calendar days");
  A(ctx.dailyAverage({}) === 0, "dailyAverage of no data is 0, not NaN");

  const busiest = ctx.busiestDay(fixture);
  A(busiest && busiest.date === "2026-07-09" && busiest.total === 7200, "busiestDay finds the highest-total day");

  const byProj = ctx.byProject(fixture);
  A(byProj["ZuPOS"] === 3600 + 1800 + 900, "byProject sums across all days for one project");
  A(byProj["VSB"] === 1800 + 7200, "byProject sums a second project independently");

  const byCat = ctx.byCategory(fixture);
  A(byCat["Development"] === 3600 + 1800 + 900, "byCategory sums across all days for one category");
  A(byCat["Meeting (General)"] === 7200, "byCategory sums a second category independently");

  A(ctx.mondayOf("2026-07-10") === "2026-07-06", "mondayOf finds the Monday of a Friday's week");
  A(ctx.mondayOf("2026-07-06") === "2026-07-06", "mondayOf on a Monday returns itself");

  const dates = ctx.weekDates("2026-07-06");
  A(dates.length === 7 && dates[0] === "2026-07-06" && dates[6] === "2026-07-12", "weekDates returns Mon..Sun");

  const totals = ctx.weekTotals(fixture, "2026-07-06");
  A(totals.length === 7 && totals[0].total === 3600 && totals[4].total === 900 && totals[5].total === 0, "weekTotals maps each day of the week to its total, 0 for days outside the fixture");
}

// ============================================================
// HARNESS 7 — Drive sync wipe-guard (pure functions from gdrive.js)
// ============================================================
async function harness7() {
  console.log("\n== Harness 7: Drive sync wipe-guard ==");
  const gdSrc = fs.readFileSync(path.join(ROOT, "gdrive.js"), "utf8");
  const ctx = {};
  const vm = require("vm");
  vm.createContext(ctx);
  vm.runInContext(gdSrc, ctx);

  A(ctx.gdTotalEntries({ "2026-07-01": [{}, {}], "2026-07-02": [{}] }) === 3, "gdTotalEntries sums entries across all days");
  A(ctx.gdTotalEntries({}) === 0, "gdTotalEntries of no days is 0");
  A(ctx.gdTotalEntries({ "2026-07-01": [] }) === 0, "gdTotalEntries of an empty day is 0");

  // The actual incident: local went empty (Reset/bad Restore) and would push
  // over a Drive copy that still has data — must be guarded.
  A(ctx.gdShouldGuardWipe(true, 0, 340) === true, "pushing empty local over a non-empty Drive is guarded");
  A(ctx.gdShouldGuardWipe(false, 340, 0) === true, "pulling empty Drive over a non-empty local is guarded");
  // Ordinary edits (including ones that delete entries) must never be blocked.
  A(ctx.gdShouldGuardWipe(true, 12, 340) === false, "pushing fewer (but non-zero) entries is NOT guarded");
  A(ctx.gdShouldGuardWipe(true, 0, 0) === false, "both sides already empty is NOT guarded");
  A(ctx.gdShouldGuardWipe(false, 0, 0) === false, "both sides empty on the pull direction is NOT guarded either");
}

(async () => {
  await harness1();
  await harness2();
  await harness3();
  await harness4();
  await harness5();
  await harness6();
  await harness7();
  console.log(fails === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${fails} FAILURE(S)`);
  process.exit(fails === 0 ? 0 : 1);
})();
