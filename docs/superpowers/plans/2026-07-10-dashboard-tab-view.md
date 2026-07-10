# Dashboard + Tab View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tab-accessible view (Today/Dashboard/Settings) to the Daily Timesheet Auto-Filler Chrome extension, sharing live data with the existing popup, per `docs/superpowers/specs/2026-07-10-dashboard-tab-view-design.md`.

**Architecture:** `popup.js` stays unmodified except for small, additive data-model/behavior hooks (history archiving, confirm-before-delete, theme application). `tab.html` includes `popup.js` verbatim for its Today section (same element IDs), then loads a new `tab.js` for sidebar nav, Dashboard, and Settings. `background.js` gains a daily-limit notification check alongside its existing badge sync.

**Tech Stack:** Plain HTML/CSS/JS, Manifest V3, `chrome.storage.local`, `chrome.notifications` (new), Node + jsdom for tests (no build step, no framework — matches the existing project).

## Global Constraints

- No build step, no bundler, no npm dependencies shipped in the extension itself (jsdom is a **test-only** devDependency, never loaded by the extension).
- `popup.js` must not be functionally modified for anything tab-specific — only additive (history archive, confirm-before-delete gate, theme apply) that also benefits the popup itself.
- Every destructive action (delete entry, reset everything) goes through the existing `showConfirm()` modal — never the native `window.confirm()`.
- All new storage keys get safe defaults applied in `popup.js`'s `init()`, the single shared entry point both popup and tab call.
- Every task ends by running `node test/smoke.js` from the repo root and confirming `SMOKE: ALL PASS`, then committing.

---

### Task 1: Move the smoke-test suite into the repo

The entire regression suite (95+ assertions covering timers, storage, search comboboxes, cross-frame form automation, and the badge) currently lives only in an ephemeral `/tmp` scratchpad — it has already been wiped once this session. Every later task in this plan extends this suite, so it must be durable and runnable from a fresh clone first.

**Files:**
- Create: `package.json` (repo root)
- Create: `test/smoke.js`
- Create: `test/fixtures/form.html`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `node test/smoke.js` — exit 0 and prints `SMOKE: ALL PASS` on success, exit 1 and prints `SMOKE: N FAILURE(S)` otherwise. All later tasks add `A(condition, message)` assertions to this file inside the existing `harnessN()` functions or new ones.

- [ ] **Step 1: Fetch a static copy of the live form for the name-parsing test fixture**

The existing suite fetches `https://techzu.fillout.com/t/uhz6TddCX2us` live over the network during tests, which is slow, flaky, and hits a real company's server on every run. Save a static snapshot instead:

```bash
curl -s -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36" \
  'https://techzu.fillout.com/t/uhz6TddCX2us' -o /home/ashraful/Personal/connect-team-form-fillup/test/fixtures/form.html
```
(Create the `test/fixtures/` directory first if `curl -o` doesn't auto-create it: `mkdir -p test/fixtures`.)

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "connect-team-form-fillup",
  "version": "1.0.0",
  "private": true,
  "description": "Daily Timesheet Auto-Filler — Chrome extension",
  "scripts": {
    "test": "node test/smoke.js"
  },
  "devDependencies": {
    "jsdom": "^29.1.1"
  }
}
```

- [ ] **Step 3: Install the test-only dependency**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm install
```

- [ ] **Step 4: Create `test/smoke.js`**

Copy the existing scratchpad suite verbatim, with two path fixes: `ROOT` becomes relative to the repo (not a hardcoded scratchpad path), and the form fixture is read from `test/fixtures/form.html` instead of the scratchpad's `form.html`.

```javascript
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
      reload: async () => { reloadCount++; },
    },
    scripting: { executeScript: async () => [{ result: {} }] }, // fillFormOnPage is stubbed below; harness2 covers real cross-frame automation
  };

  const realForm = fs.readFileSync(path.join(ROOT, "test", "fixtures", "form.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/" });
  const win = dom.window;
  win.chrome = chrome;
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

  $("loadNames").click();
  await sleep(80);
  A(store.names && store.names.length === 21, "21 names parsed from real form HTML");
  A(store.names.includes("Debjit Paul"), "names persisted incl. Debjit Paul");
  A(JSON.stringify(store.names) === JSON.stringify([...store.names].sort((a, b) => a.localeCompare(b))), "names sorted alphabetically");

  // searchable name combobox: substring match (not just first-letter jump
  // like a native <select>), click-to-select, and Enter-to-select
  $("nameSelect").dispatchEvent(new win.Event("focus"));
  await sleep(10);
  A(win.document.querySelectorAll("#nameList .searchItem").length === 21, "focusing an empty search shows all 21 names");
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
  const projAll = [...win.document.querySelectorAll("#projList .searchItem")].map((n) => n.textContent);
  A(projAll.length === 11, "focusing project search with no filter shows all 11 projects");
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

  // ...but must NOT reload a REUSED tab — that could hold in-progress
  // session-only entries (Fillout doesn't persist them until real Submit).
  reloadCount = 0;
  queryReturnsExisting = true;
  lastFill = null;
  $("finalSubmit").click();
  await sleep(30);
  $("confirmYes").click();
  await sleep(300);
  A(reloadCount === 0, `ensureFormTab does NOT reload a reused/existing tab (got ${reloadCount})`);
  queryReturnsExisting = false;

  // delete an entry
  win.document.querySelector(".entry .del").click();
  await sleep(20);
  A(store.entries.length === 1, "delete removes entry");

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

  $("finalSubmit").click();
  await sleep(20);
  A($("submitStatus").textContent.toLowerCase().includes("no projects"), "blocks submit with no entries");

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
      local: { get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]])) : { [k]: store[k] }) },
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

(async () => {
  await harness1();
  await harness2();
  await harness3();
  await harness4();
  console.log(fails === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${fails} FAILURE(S)`);
  process.exit(fails === 0 ? 0 : 1);
})();
```

- [ ] **Step 5: Add `node_modules` to `.gitignore`**

```bash
cat /home/ashraful/Personal/connect-team-form-fillup/.gitignore
```

Append `node_modules/` (keep the existing `.claude/` line):

```
.claude/
node_modules/
```

- [ ] **Step 6: Run the suite from the repo and confirm it passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: ends with `SMOKE: ALL PASS` (95 `ok:` lines, 0 `FAIL:` lines).

- [ ] **Step 7: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add package.json package-lock.json test/ .gitignore
git commit -m "Move smoke-test suite into the repo, off a static form fixture"
```

---

### Task 2: History archiving on day rollover

**Files:**
- Modify: `popup.js:37-51` (the `init()` function)
- Test: `test/smoke.js` (extend `harness1`)

**Interfaces:**
- Consumes: existing `S`, `foldActive()`, `todayStr()`, `chrome.storage.local`.
- Produces: `S.history` — `{ [date]: entries[] }`, each entry's `accSec` fully folded (no live timer math needed to read it later). Later tasks (Dashboard math, Reset Everything) read/clear `S.history` by this exact key name and shape.

- [ ] **Step 1: Add the failing assertions to `test/smoke.js`**

Insert into `harness1`, right after the existing "daily reset" block (after the `A($("descInput").value === "", ...)` line and before the final-submit-blocked check):

```javascript
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
  store.date = "2099-01-01"; // force the next init() to see a date rollover
  await win.init();
  await sleep(30);
  A(store.history && Array.isArray(store.history[outgoingDate]), `history archived under the outgoing date (${outgoingDate})`);
  A(store.history[outgoingDate][0].description === "Archived task" && store.history[outgoingDate][0].accSec === 3600, "archived entry keeps its description and folded time");
  A(store.entries.length === 0, "entries still clear on rollover after archiving");

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
```

- [ ] **Step 2: Run the suite and confirm these new assertions fail**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: FAIL on `history archived under the outgoing date` (and the two assertions after it) — `store.history` is `undefined` since `init()` doesn't write it yet.

- [ ] **Step 3: Implement history archiving in `popup.js`**

Replace the `init()` function (`popup.js:37-51`):

```javascript
async function init() {
  S = await chrome.storage.local.get(null);
  S.entries = S.entries || [];
  S.timer = S.timer || { activeId: null, startedAt: null };
  S.history = S.history || {};
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
  route();
}
```

- [ ] **Step 4: Run the suite and confirm everything passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: `SMOKE: ALL PASS`.

- [ ] **Step 5: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add popup.js test/smoke.js
git commit -m "Archive each day's entries into history on date rollover"
```

---

### Task 3: Confirm-before-delete setting

**Files:**
- Modify: `popup.js:37-52` (`init()` — add default), `popup.js:263-268` (`deleteEntry`)
- Test: `test/smoke.js` (extend `harness1`)

**Interfaces:**
- Consumes: `showConfirm(message)` (already exists, `popup.js:151`).
- Produces: `S.confirmBeforeDelete` (boolean, default `true`). `deleteEntry(id)` behavior: awaits confirmation first when the flag is true (or unset), skips straight to deleting when explicitly `false`.

- [ ] **Step 1: Add the failing assertions to `test/smoke.js`**

Insert into `harness1`, right before the final `dom.window.close();` line:

```javascript
  // CONFIRM-BEFORE-DELETE: default true -> delete must go through the modal
  $("projSelect").value = "ZuPOS";
  $("descInput").value = "Delete-confirm test";
  $("addProject").click();
  await sleep(20);
  const beforeCount = store.entries.length;
  win.document.querySelector(".entry .del").click();
  await sleep(20);
  A(!$("confirmOverlay").classList.contains("hidden"), "delete with confirmBeforeDelete on shows the modal");
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
  S.confirmBeforeDelete = false;
  $("projSelect").value = "ZuPOS";
  $("descInput").value = "No-confirm delete test";
  $("addProject").click();
  await sleep(20);
  const beforeCount2 = store.entries.length;
  win.document.querySelector(".entry .del").click();
  await sleep(20);
  A($("confirmOverlay").classList.contains("hidden"), "delete with confirmBeforeDelete off skips the modal");
  A(store.entries.length === beforeCount2 - 1, "entry deleted immediately when confirmBeforeDelete is off");
```

- [ ] **Step 2: Run the suite and confirm these new assertions fail**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: FAIL on `delete with confirmBeforeDelete on shows the modal` — current `deleteEntry` deletes immediately, no modal ever appears.

- [ ] **Step 3: Add the default in `init()`**

In `popup.js`, inside `init()`, alongside the existing `S.history = S.history || {};` line, add:

```javascript
  S.confirmBeforeDelete = S.confirmBeforeDelete === undefined ? true : S.confirmBeforeDelete;
```

- [ ] **Step 4: Gate `deleteEntry` on the setting**

Replace `deleteEntry` (`popup.js:263-268`):

```javascript
async function deleteEntry(id) {
  if (S.confirmBeforeDelete !== false) {
    if (!(await showConfirm("Delete this project entry?"))) return;
  }
  if (S.timer.activeId === id) S.timer = { activeId: null, startedAt: null };
  S.entries = S.entries.filter((x) => x.id !== id);
  await persist();
  render();
}
```

- [ ] **Step 5: Run the suite and confirm everything passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: `SMOKE: ALL PASS`.

- [ ] **Step 6: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add popup.js test/smoke.js
git commit -m "Add confirm-before-delete setting, on by default"
```

---

### Task 4: Daily-limit notification

**Files:**
- Modify: `manifest.json:6` (permissions)
- Modify: `background.js`
- Modify: `popup.js` (`init()` — defaults for `dailyLimitHours`/`warnedDate`)
- Test: `test/smoke.js` (extend `harness3`)

**Interfaces:**
- Consumes: `chrome.storage.onChanged`, `chrome.notifications.create` (new).
- Produces: `S.dailyLimitHours` (number, default `8`), `S.warnedDate` (string date or `null`). `background.js` exposes `checkDailyLimit()` (async, no args — reads storage itself), called on every `entries`/`timer` storage change and on `onInstalled`/`onStartup`.

- [ ] **Step 1: Add the `notifications` permission**

In `manifest.json`, change line 6:

```json
  "permissions": ["storage", "scripting", "tabs", "alarms", "notifications"],
```

- [ ] **Step 2: Add the failing assertions to `test/smoke.js`**

Insert into `harness3`, right before the final `A(badge.color === "#16a34a" && alarmCfg !== null, ...)` block's closing (i.e. append at the end of `harness3`, before its closing `}`):

```javascript
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
```

- [ ] **Step 3: Run the suite and confirm these new assertions fail**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: FAIL on `notification fires once when crossing the daily limit` — `background.js` doesn't call `chrome.notifications.create` at all yet, and the mock `chrome` object in `harness3` has no `notifications` handling wired into the `entries`-change path (`fireChange` currently only triggers listeners; `background.js`'s listener currently ignores `changes.entries`).

- [ ] **Step 4: Implement `checkDailyLimit` in `background.js`**

Replace the whole file:

```javascript
"use strict";
// Keeps the toolbar badge reflecting timer state even when the popup is
// closed. Event-driven (storage.onChanged) for start/stop; chrome.alarms
// (min 1min granularity, survives service-worker suspension) ticks the
// elapsed-time display while a timer runs. Also fires a once-per-day OS
// notification when today's tracked time crosses the configured limit.

const ALARM = "tick";
const pad = (n) => String(n).padStart(2, "0");

function idle() {
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
  chrome.action.setTitle({ title: "Daily Timesheet — no timer running" });
}

async function running() {
  const { timer, entries } = await chrome.storage.local.get(["timer", "entries"]);
  if (!timer || !timer.activeId) return idle();
  const entry = (entries || []).find((e) => e.id === timer.activeId);
  const sec = Math.floor((entry ? entry.accSec || 0 : 0) + (Date.now() - timer.startedAt) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  // ponytail: whole-hour precision once >=1h, exact minutes under an hour — badge is ~4 chars max
  chrome.action.setBadgeText({ text: h >= 1 ? `${h}h` : `${m}m` });
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  const hhmmss = `${pad(h)}:${pad(m)}:${pad(sec % 60)}`;
  chrome.action.setTitle({ title: `Running: ${entry ? entry.project : "?"} — ${hhmmss}` });
}

async function syncBadge() {
  const { timer } = await chrome.storage.local.get("timer");
  if (timer && timer.activeId) {
    chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    await running();
  } else {
    chrome.alarms.clear(ALARM);
    idle();
  }
}

async function checkDailyLimit() {
  const { entries, timer, dailyLimitHours, warnedDate, date } = await chrome.storage.local.get(
    ["entries", "timer", "dailyLimitHours", "warnedDate", "date"]
  );
  if (!dailyLimitHours) return; // not configured yet
  let totalSec = (entries || []).reduce((sum, e) => sum + (e.accSec || 0), 0);
  if (timer && timer.activeId && timer.startedAt) {
    totalSec += (Date.now() - timer.startedAt) / 1000;
  }
  if (totalSec >= dailyLimitHours * 3600 && warnedDate !== date) {
    chrome.notifications.create("daily-limit", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Daily limit reached",
      message: `You've tracked ${dailyLimitHours}+ hour(s) today.`,
    });
    await chrome.storage.local.set({ warnedDate: date });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.timer) syncBadge();
  if (changes.timer || changes.entries) checkDailyLimit();
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) running(); });
chrome.runtime.onInstalled.addListener(() => { syncBadge(); checkDailyLimit(); });
chrome.runtime.onStartup.addListener(() => { syncBadge(); checkDailyLimit(); });
syncBadge(); // service worker (re)start while a timer was already running
```

- [ ] **Step 5: Add `dailyLimitHours`/`warnedDate` defaults in `popup.js`'s `init()`**

Alongside the `S.confirmBeforeDelete` default added in Task 3, add:

```javascript
  S.dailyLimitHours = S.dailyLimitHours || 8;
  S.warnedDate = S.warnedDate === undefined ? null : S.warnedDate;
```

- [ ] **Step 6: Run the suite and confirm everything passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: `SMOKE: ALL PASS`.

- [ ] **Step 7: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add manifest.json background.js popup.js test/smoke.js
git commit -m "Fire an OS notification once per day when the tracked-time limit is crossed"
```

---

### Task 5: Theme system (CSS custom properties + toggle plumbing)

**Files:**
- Create: `theme.css`
- Modify: `popup.css` (replace hardcoded colors with `var(...)`)
- Modify: `popup.html` (link `theme.css` before `popup.css`)
- Modify: `popup.js` (`init()` default + new `applyTheme`/`resolveTheme` functions, called from `init()`)
- Test: `test/smoke.js` (extend `harness1`)

**Interfaces:**
- Produces: `resolveTheme(theme)` — pure function, `"dark"|"light"` in, `"dark"|"light"` out (`"system"` resolved via `matchMedia`). `applyTheme(theme)` — sets `document.documentElement.dataset.theme` and persists `S.theme`. Task 9 (Settings) calls `applyTheme` when the user picks a theme button.

- [ ] **Step 1: Create `theme.css`**

```css
:root {
  --bg-page: #0f172a;
  --bg-surface: #1e293b;
  --bg-surface-2: #334155;
  --bg-surface-hover: #273449;
  --border-color: #334155;
  --text-primary: #e2e8f0;
  --text-secondary: #cbd5e1;
  --text-muted: #94a3b8;
  --text-on-accent: #ffffff;
  --accent: #3b82f6;
  --accent-hover: #2563eb;
  --accent-light: #60a5fa;
  --danger: #dc2626;
  --danger-hover: #b91c1c;
  --danger-light: #f87171;
  --success: #4ade80;
  --overlay-bg: rgba(0, 0, 0, 0.6);
}
:root[data-theme="light"] {
  --bg-page: #f8fafc;
  --bg-surface: #ffffff;
  --bg-surface-2: #e2e8f0;
  --bg-surface-hover: #f1f5f9;
  --border-color: #cbd5e1;
  --text-primary: #0f172a;
  --text-secondary: #334155;
  --text-muted: #64748b;
  --text-on-accent: #ffffff;
  --accent: #3b82f6;
  --accent-hover: #2563eb;
  --accent-light: #2563eb;
  --danger: #dc2626;
  --danger-hover: #b91c1c;
  --danger-light: #dc2626;
  --success: #16a34a;
  --overlay-bg: rgba(15, 23, 42, 0.35);
}
```

- [ ] **Step 2: Link `theme.css` in `popup.html`**

In `popup.html`, change the `<head>` (currently just `popup.css`):

```html
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="theme.css">
  <link rel="stylesheet" href="popup.css">
</head>
```

- [ ] **Step 3: Replace hardcoded colors in `popup.css` with `var(...)`**

Replace the whole file:

```css
* { box-sizing: border-box; }
body {
  margin: 0;
  width: 340px;
  font: 13px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--bg-page);
  color: var(--text-primary);
}
.wrap { padding: 14px; }
.hidden { display: none !important; }
h1 { font-size: 18px; margin: 0 0 8px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin: 16px 0 6px; }
.muted { color: var(--text-muted); }
.small { font-size: 11px; }
.req { color: var(--danger-light); }

label { display: block; margin: 8px 0 3px; font-size: 12px; color: var(--text-secondary); }
select, input[type=text], input[type=time] {
  width: 100%;
  padding: 7px 9px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
}
select:focus, input:focus { outline: none; border-color: var(--accent); }

.btn {
  width: 100%;
  margin-top: 10px;
  padding: 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
}
.btn:hover { background: var(--bg-surface-hover); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }
.btn.primary:hover { background: var(--accent-hover); }
.btn.danger { background: var(--danger); border-color: var(--danger); color: var(--text-on-accent); margin-top: 16px; }
.btn.danger:hover { background: var(--danger-hover); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.link { background: none; border: none; color: var(--accent-light); cursor: pointer; font-size: 12px; padding: 0; }

.topbar { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 8px; border-bottom: 1px solid var(--bg-surface); }
.who { font-weight: 600; font-size: 14px; }

.status { min-height: 14px; margin: 6px 0 0; font-size: 11px; color: var(--text-muted); }
.status.err { color: var(--danger-light); }
.status.ok { color: var(--success); }

.entries { display: flex; flex-direction: column; gap: 6px; }
.entry {
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px;
}
.entry.active { border-color: var(--accent); }
.entry .row1 { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.entry .pname { font-weight: 600; }
.entry .cat { font-size: 11px; color: var(--text-muted); }
.entry .desc { font-size: 11px; color: var(--text-secondary); margin-top: 2px; word-break: break-word; }
.entry .row2 { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.entry .time { width: 74px; text-align: center; font-variant-numeric: tabular-nums; }
.entry .tbtn {
  width: 30px; height: 28px; padding: 0;
  border: 1px solid var(--border-color); border-radius: 6px;
  background: var(--bg-page); color: var(--text-primary); cursor: pointer; font-size: 13px;
}
.entry .tbtn.playing { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }
.entry .live { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 12px; color: var(--success); min-width: 70px; text-align: right; }
.entry.active .live::before { content: "\25CF"; margin-right: 5px; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0.15; } }
.entry .acts { display: flex; align-items: center; gap: 10px; }
.entry .edit { color: var(--accent-light); background: none; border: none; cursor: pointer; font-size: 12px; padding: 0; }
.entry .del { color: var(--danger-light); background: none; border: none; cursor: pointer; font-size: 15px; }

.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  z-index: 100;
}
.confirmBox {
  width: 100%;
  max-width: 100%;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 14px;
  box-sizing: border-box;
}
.confirmBox p {
  margin: 0 0 12px;
  white-space: pre-line;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.5;
}
.confirmActions { display: flex; gap: 8px; }
.confirmActions .btn { width: auto; flex: 1; margin-top: 0; }

.searchWrap { position: relative; }
.searchList {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  max-height: 180px;
  overflow-y: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  z-index: 50;
}
.searchItem { padding: 7px 9px; cursor: pointer; font-size: 13px; }
.searchItem.hi, .searchItem:hover { background: var(--bg-surface-2); }
```

- [ ] **Step 4: Add the failing assertions to `test/smoke.js`**

Insert into `harness1`, right before the final `dom.window.close();`:

```javascript
  // THEME: resolveTheme + applyTheme + data-theme attribute reflects on load
  A(win.resolveTheme("dark") === "dark" && win.resolveTheme("light") === "light", "resolveTheme passes through explicit dark/light");
  A(win.resolveTheme("system") === "dark" || win.resolveTheme("system") === "light", "resolveTheme resolves system to a concrete value");
  win.applyTheme("light");
  await sleep(10);
  A(win.document.documentElement.dataset.theme === "light", "applyTheme sets data-theme on the document");
  A(store.theme === "light", "applyTheme persists the choice to storage");
```

Also add a `matchMedia` stub to harness1's JSDOM setup, right after the existing `win.chrome = chrome;` line (jsdom doesn't implement `matchMedia`, and `resolveTheme("system")` needs it):

```javascript
  win.matchMedia = win.matchMedia || (() => ({ matches: false }));
```

- [ ] **Step 5: Run the suite and confirm these new assertions fail**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: FAIL — `win.resolveTheme`/`win.applyTheme` are not functions yet.

- [ ] **Step 6: Add `resolveTheme`/`applyTheme` to `popup.js` and call from `init()`**

Add these two functions near the top of `popup.js`, right after the `hhmmToSec` function (before the `// ---------- storage / state ----------` comment):

```javascript
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
```

In `init()`, add the default alongside the other new defaults, and apply it:

```javascript
  S.theme = S.theme || "dark";
```

and, right before the closing `route();` line of `init()`, add:

```javascript
  document.documentElement.dataset.theme = resolveTheme(S.theme);
```

(Note: this sets the attribute directly rather than calling `applyTheme` here, since `applyTheme` also re-persists to storage — on load we only need to *read* the stored value and reflect it, not write it back.)

- [ ] **Step 7: Run the suite and confirm everything passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: `SMOKE: ALL PASS`.

- [ ] **Step 8: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add theme.css popup.css popup.html popup.js test/smoke.js
git commit -m "Add theme system: CSS custom properties + applyTheme/resolveTheme"
```

---

### Task 6: Tab shell — sidebar nav, Today section, empty Dashboard/Settings panels

**Files:**
- Create: `tab.html`
- Create: `tab.css`
- Create: `tab.js`
- Test: `test/smoke.js` (new `harness5`)

**Interfaces:**
- Consumes: `popup.js`'s existing globals (`$`, `S`, `route`, `init`, `showSetup`, `showMain`, etc.) — `tab.html` loads `popup.js` before `tab.js`, same document, same global scope.
- Produces: `showPanel(name)` — `"today"|"dashboard"|"settings"`, toggles the three `<section>`s. Later tasks (7, 8, 9) fill in `#panelDashboard`/`#panelSettings` content and call `renderDashboard()`/`renderSettings()` from inside `showPanel`.

- [ ] **Step 1: Create `tab.html`**

The Today panel's `#setup`/`#main` markup is copied verbatim from `popup.html` (same IDs), so `popup.js` drives it unchanged. Dashboard and Settings panels get placeholder content for now — filled in by Tasks 7–9.

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Daily Timesheet</title>
  <link rel="stylesheet" href="theme.css">
  <link rel="stylesheet" href="popup.css">
  <link rel="stylesheet" href="tab.css">
</head>
<body>
  <div class="shell">
    <nav class="sidebar">
      <div class="brand">Daily Timesheet</div>
      <button class="navBtn active" id="navToday" data-panel="today">Today</button>
      <button class="navBtn" id="navDashboard" data-panel="dashboard">Dashboard</button>
      <button class="navBtn" id="navSettings" data-panel="settings">Settings</button>
    </nav>

    <main class="content">
      <section id="panelToday" class="panel">
        <div class="wrap">

          <!-- SETUP VIEW (first run: no name saved) -->
          <section id="setup" class="view hidden">
            <h1>Setup</h1>
            <p class="muted">Load the name list from the form, then pick yours.</p>
            <button id="loadNames" class="btn">Load names from form</button>
            <div id="setupPicker" class="hidden">
              <label>Your name</label>
              <div class="searchWrap">
                <input id="nameSelect" type="text" autocomplete="off" placeholder="Type to search...">
                <div id="nameList" class="searchList hidden"></div>
              </div>
              <button id="saveName" class="btn primary">Save</button>
            </div>
            <p id="setupStatus" class="status"></p>
          </section>

          <!-- MAIN VIEW -->
          <section id="main" class="view hidden">
            <div class="topbar">
              <div>
                <div class="who" id="whoName">—</div>
                <div class="muted small" id="whoDate">—</div>
              </div>
              <button id="changeName" class="link">change</button>
            </div>

            <h2>Add project</h2>
            <div class="addform">
              <label>Project</label>
              <div class="searchWrap">
                <input id="projSelect" type="text" autocomplete="off" placeholder="Type to search...">
                <div id="projList" class="searchList hidden"></div>
              </div>
              <label>Work Category</label>
              <select id="catSelect"></select>
              <label>Description <span class="req">*</span></label>
              <input id="descInput" type="text" placeholder="Task description">
              <button id="addProject" class="btn primary">+ Add Project</button>
              <button id="cancelEdit" class="btn hidden">Cancel</button>
              <p id="addStatus" class="status"></p>
            </div>

            <h2>Today's projects</h2>
            <div id="entries" class="entries"></div>
            <p id="emptyMsg" class="muted small">No projects yet.</p>

            <button id="finalSubmit" class="btn danger">Final Submit</button>
            <p id="submitStatus" class="status"></p>
          </section>

        </div>
      </section>

      <section id="panelDashboard" class="panel hidden">
        <!-- filled in by Task 7/8 -->
      </section>

      <section id="panelSettings" class="panel hidden">
        <!-- filled in by Task 9 -->
      </section>
    </main>
  </div>

  <!-- Custom confirm modal — shared with popup.js's showConfirm() -->
  <div id="confirmOverlay" class="overlay hidden">
    <div class="confirmBox">
      <p id="confirmMsg"></p>
      <div class="confirmActions">
        <button id="confirmNo" class="btn">Cancel</button>
        <button id="confirmYes" class="btn danger">Yes, submit</button>
      </div>
    </div>
  </div>

  <script src="popup.js"></script>
  <script src="tab.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `tab.css`**

```css
body { width: auto; max-width: none; } /* popup.css sets a 340px popup width; a tab is full-width */

.shell { display: flex; min-height: 100vh; }
.sidebar {
  width: 200px;
  flex: none;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-color);
  padding: 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.brand { font-weight: 600; font-size: 14px; padding: 0 8px 16px; }
.navBtn {
  text-align: left;
  padding: 8px 10px;
  border-radius: 6px;
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
}
.navBtn:hover { background: var(--bg-surface-hover); }
.navBtn.active { background: var(--accent); color: var(--text-on-accent); }

.content { flex: 1; padding: 24px; max-width: 900px; }
.panel .wrap { padding: 0; max-width: 420px; } /* Today panel keeps the popup's comfortable form width */

.statTiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
.statTile {
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
}
.statTile .label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
.statTile .value { font-size: 20px; font-weight: 600; margin-top: 4px; }
.statTile .sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

.breakdownRow { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
.breakdownRow .name { width: 120px; flex: none; color: var(--text-secondary); }
.breakdownRow .bar { flex: 1; height: 8px; background: var(--bg-surface-2); border-radius: 4px; overflow: hidden; }
.breakdownRow .bar > span { display: block; height: 100%; background: var(--accent); }
.breakdownRow .amount { width: 60px; flex: none; text-align: right; color: var(--text-muted); }

.settingsRow { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border-color); }
.settingsRow .label { font-size: 13px; }
.settingsRow .desc { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.dangerZone { margin-top: 24px; padding: 12px; border: 1px solid var(--danger); border-radius: 8px; }
```

- [ ] **Step 3: Create `tab.js` with nav wiring only (Dashboard/Settings render calls are no-ops for now, filled in by later tasks)**

```javascript
"use strict";
// Loaded after popup.js in tab.html — reuses its globals ($, S, route, init,
// showSetup, showMain, etc.) directly; do not redeclare `$` or `S` here.

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
```

- [ ] **Step 4: Add a smoke test for the tab shell — new `harness5` in `test/smoke.js`**

Add this function after `harness4` (before the final `(async () => { ... })();` block):

```javascript
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

  dom.window.close();
}
```

Update the final IIFE to also run it:

```javascript
(async () => {
  await harness1();
  await harness2();
  await harness3();
  await harness4();
  await harness5();
  console.log(fails === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${fails} FAILURE(S)`);
  process.exit(fails === 0 ? 0 : 1);
})();
```

- [ ] **Step 5: Run the suite and confirm it passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: `SMOKE: ALL PASS`.

- [ ] **Step 6: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add tab.html tab.css tab.js test/smoke.js
git commit -m "Add tab shell: sidebar nav + Today panel reusing popup.js"
```

---

### Task 7: Dashboard math (pure functions)

**Files:**
- Modify: `tab.js` (add pure functions, no rendering yet)
- Test: `test/smoke.js` (new `harness6`)

**Interfaces:**
- Consumes: nothing external — pure functions operating on a `daysMap` shape `{ [date]: [{project, category, description, accSec}, ...] }`.
- Produces (exact names/signatures later tasks depend on):
  - `dayTotal(entries)` → number (seconds)
  - `trackedTotal(daysMap)` → number (seconds)
  - `activeDayCount(daysMap)` → number
  - `dailyAverage(daysMap)` → number (seconds, `0` if no active days)
  - `busiestDay(daysMap)` → `{ date, total } | null`
  - `byProject(daysMap)` → `{ [project]: totalSeconds }`
  - `byCategory(daysMap)` → `{ [category]: totalSeconds }`
  - `mondayOf(dateStr)` → `"YYYY-MM-DD"` (the Monday of the week containing `dateStr`)
  - `weekDates(mondayStr)` → array of 7 `"YYYY-MM-DD"` strings, Mon..Sun
  - `weekTotals(daysMap, mondayStr)` → array of 7 `{ date, total }`
  - `buildDaysMap()` → NOT pure (reads `S.history`/`S.entries`/`elapsedSec` from `popup.js`) — merges archived history with today's live-resolved entries: `{ ...S.history, [S.date]: S.entries.map(e => ({ ...e, accSec: elapsedSec(e) })) }`

- [ ] **Step 1: Add the failing test — new `harness6` in `test/smoke.js`**

Add after `harness5` (before the final IIFE):

```javascript
// ============================================================
// HARNESS 6 — Dashboard math (pure functions) against a synthetic fixture
// ============================================================
async function harness6() {
  console.log("\n== Harness 6: dashboard math ==");
  const tabJsSrc = fs.readFileSync(path.join(ROOT, "tab.js"), "utf8");
  const ctx = {};
  // pure functions have no DOM/chrome dependency — eval directly into a plain object
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
```

Update the final IIFE:

```javascript
(async () => {
  await harness1();
  await harness2();
  await harness3();
  await harness4();
  await harness5();
  await harness6();
  console.log(fails === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${fails} FAILURE(S)`);
  process.exit(fails === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run and confirm these fail**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: FAIL — none of `dayTotal`/`trackedTotal`/etc. exist in `tab.js` yet.

- [ ] **Step 3: Implement the pure functions in `tab.js`**

Add these functions to `tab.js`, above the `showPanel` function:

```javascript
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
```

(`pad` and `S`/`elapsedSec` come from `popup.js`, already loaded first in `tab.html` — do not redeclare them.)

- [ ] **Step 4: Run and confirm everything passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: `SMOKE: ALL PASS`.

- [ ] **Step 5: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add tab.js test/smoke.js
git commit -m "Add dashboard math: totals, averages, busiest day, by-project/category"
```

---

### Task 8: Dashboard rendering (chart + tiles + breakdowns)

**Files:**
- Modify: `tab.html` (`#panelDashboard` content)
- Modify: `tab.js` (add `renderDashboard`, `weekOffset` state, nav wiring)
- Test: `test/smoke.js` (extend `harness5`)

**Interfaces:**
- Consumes: `buildDaysMap`, `weekTotals`, `mondayOf`, `dailyAverage`, `trackedTotal`, `busiestDay`, `byProject`, `byCategory`, `dayTotal` (Task 7), `secToHHMM` (from `popup.js`).
- Produces: `renderDashboard()` — called by `showPanel("dashboard")` (already wired in Task 6's `tab.js`).

**Before writing the chart markup/colors, invoke the `dataviz` skill** — this project renders a bar chart and several colored stat/breakdown elements, which is exactly the trigger condition for that skill. Follow its color/contrast guidance for the bar chart and breakdown bars rather than picking colors ad hoc.

- [ ] **Step 1: Invoke the dataviz skill for the chart/breakdown color and layout guidance, then fill in `#panelDashboard` in `tab.html`**

Replace the placeholder comment inside `<section id="panelDashboard" class="panel hidden">` in `tab.html`:

```html
      <section id="panelDashboard" class="panel hidden">
        <h1>Dashboard</h1>

        <div class="weekNav">
          <button id="weekPrev" class="btn" style="width:auto">&lt;</button>
          <span id="weekLabel" class="muted"></span>
          <button id="weekNext" class="btn" style="width:auto">&gt;</button>
        </div>
        <div id="weekChart" class="weekChart"></div>

        <div class="statTiles">
          <div class="statTile"><div class="label">Today</div><div class="value" id="tileToday">00:00</div></div>
          <div class="statTile"><div class="label">Tracked Total</div><div class="value" id="tileTotal">00:00</div></div>
          <div class="statTile"><div class="label">Daily Average</div><div class="value" id="tileAvg">00:00</div><div class="sub" id="tileAvgSub"></div></div>
          <div class="statTile"><div class="label">Busiest Day</div><div class="value" id="tileBusiest">—</div><div class="sub" id="tileBusiestSub"></div></div>
        </div>

        <h2>By project</h2>
        <div id="byProjectList"></div>

        <h2>By category</h2>
        <div id="byCategoryList"></div>
      </section>
```

- [ ] **Step 2: Add chart/tile CSS to `tab.css`**

Append:

```css
.weekNav { display: flex; align-items: center; gap: 12px; margin: 12px 0 8px; }
.weekChart { display: flex; align-items: flex-end; gap: 8px; height: 140px; padding: 8px 0; border-bottom: 1px solid var(--border-color); }
.weekChart .col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.weekChart .bar { width: 100%; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
.weekChart .col.today .bar { background: var(--success); }
.weekChart .dow { font-size: 11px; color: var(--text-muted); }
```

- [ ] **Step 3: Add the failing assertions to `test/smoke.js`**

Extend `harness5` (`test/smoke.js`), right before its final `dom.window.close();`:

```javascript
  // DASHBOARD RENDERING: seed one entry, open Dashboard, confirm it reflects
  $("navToday").click();
  await sleep(10);
  $("loadNames") && ($("loadNames").click(), await sleep(80)); // no-op if already past setup
  if (!win.document.getElementById("main").classList.contains("hidden") === false) {
    // still on setup (no names loaded in this harness) — set name directly via storage + reinit
  }
  store.name = "Debjit Paul";
  store.date = "2026-07-10";
  store.entries = [{ id: "e1", project: "ZuPOS", category: "Development", description: "x", accSec: 3600 }];
  store.timer = { activeId: null, startedAt: null };
  await win.init();
  await sleep(20);

  $("navDashboard").click();
  await sleep(20);
  A($("tileToday").textContent === "01:00", "Today tile reflects today's tracked time");
  A($("weekChart").children.length === 7, "week chart renders 7 day columns");
  A($("byProjectList").textContent.includes("ZuPOS"), "by-project breakdown lists ZuPOS");

  const prevLabel = $("weekLabel").textContent;
  $("weekPrev").click();
  await sleep(20);
  A($("weekLabel").textContent !== prevLabel, "clicking the previous-week arrow changes the visible week");
  $("weekNext").click();
  await sleep(20);
  A($("weekLabel").textContent === prevLabel, "clicking next returns to the original week");
```

- [ ] **Step 4: Run and confirm these new assertions fail**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: FAIL — `renderDashboard` doesn't exist, tiles/chart never populate.

- [ ] **Step 5: Implement `renderDashboard` in `tab.js`**

Add near the top of `tab.js`, after the pure functions from Task 7:

```javascript
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

  const renderBreakdown = (containerId, totalsMap) => {
    const container = document.getElementById(containerId);
    container.innerHTML = "";
    const entries = Object.entries(totalsMap).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    for (const [name, secs] of entries) {
      const row = document.createElement("div");
      row.className = "breakdownRow";
      row.innerHTML = `<div class="name"></div><div class="bar"><span></span></div><div class="amount"></div>`;
      row.querySelector(".name").textContent = name;
      row.querySelector(".bar > span").style.width = `${(secs / max) * 100}%`;
      row.querySelector(".amount").textContent = secToHHMM(secs);
      container.appendChild(row);
    }
  };
  renderBreakdown("byProjectList", byProject(daysMap));
  renderBreakdown("byCategoryList", byCategory(daysMap));
}
```

Wire the week-nav buttons in `tab.js`'s `DOMContentLoaded` handler (add to the existing listener body from Task 6):

```javascript
  document.getElementById("weekPrev").onclick = () => { weekOffset--; renderDashboard(); };
  document.getElementById("weekNext").onclick = () => { weekOffset++; renderDashboard(); };
```

- [ ] **Step 6: Run and confirm everything passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: `SMOKE: ALL PASS`.

- [ ] **Step 7: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add tab.html tab.css tab.js test/smoke.js
git commit -m "Render the Dashboard: weekly chart, stat tiles, by-project/category breakdowns"
```

---

### Task 9: Settings page (name, daily limit, confirm-before-delete, theme, reset everything)

**Files:**
- Modify: `tab.html` (`#panelSettings` content)
- Modify: `tab.js` (`renderSettings`, `resetEverything`, wiring)
- Test: `test/smoke.js` (extend `harness5`)

**Interfaces:**
- Consumes: `setupSearchSelect`, `showConfirm`, `applyTheme`, `S`, `route` (all from `popup.js`).
- Produces: `renderSettings()` (called by `showPanel("settings")`, already wired in Task 6), `resetEverything()`.

- [ ] **Step 1: Fill in `#panelSettings` in `tab.html`**

```html
      <section id="panelSettings" class="panel hidden">
        <h1>Settings</h1>

        <div class="settingsRow" style="display:block">
          <label>Your name</label>
          <div class="searchWrap">
            <input id="settingsNameInput" type="text" autocomplete="off" placeholder="Type to search...">
            <div id="settingsNameList" class="searchList hidden"></div>
          </div>
        </div>

        <div class="settingsRow">
          <div>
            <div class="label">Daily limit</div>
            <div class="desc">Get notified once when you cross this many hours in a day.</div>
          </div>
          <select id="dailyLimitSelect" style="width:auto">
            <option value="4">4 hours</option>
            <option value="6">6 hours</option>
            <option value="8">8 hours</option>
            <option value="10">10 hours</option>
          </select>
        </div>

        <div class="settingsRow">
          <div>
            <div class="label">Confirm before deleting</div>
            <div class="desc">Require a confirmation click before deleting a project entry.</div>
          </div>
          <input type="checkbox" id="confirmDeleteToggle">
        </div>

        <div class="settingsRow">
          <div>
            <div class="label">Theme</div>
          </div>
          <div>
            <button class="btn" id="themeDark" style="width:auto">Dark</button>
            <button class="btn" id="themeLight" style="width:auto">Light</button>
            <button class="btn" id="themeSystem" style="width:auto">System</button>
          </div>
        </div>

        <div class="dangerZone">
          <div class="label">Reset everything</div>
          <div class="desc">Deletes all tasks, history, and settings. Cannot be undone. Your name is kept.</div>
          <button id="resetEverything" class="btn danger" style="width:auto">Reset</button>
        </div>
      </section>
```

- [ ] **Step 2: Add the failing assertions to `test/smoke.js`**

Extend `harness5`, right before its final `dom.window.close();` (after the Dashboard assertions from Task 8):

```javascript
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
  S.names = store.names;
  $("settingsNameInput").dispatchEvent(new win.Event("focus"));
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
  $("confirmYes").click();
  await sleep(20);
  A(store.entries.length === 0, "reset clears entries");
  A(store.history && Object.keys(store.history).length === 0, "reset clears history");
  A(store.dailyLimitHours === 8, "reset restores the default daily limit");
  A(store.confirmBeforeDelete === true, "reset restores confirm-before-delete to on");
  A(store.theme === "dark", "reset restores the default theme");
  A(store.name === "Ashis Hira", "reset KEEPS the name");
```

- [ ] **Step 3: Run and confirm these new assertions fail**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: FAIL — `renderSettings`/`resetEverything` don't exist yet, Settings controls aren't wired.

- [ ] **Step 4: Implement `renderSettings`, `resetEverything`, and wiring in `tab.js`**

Add after `renderDashboard` (from Task 8):

```javascript
function renderSettings() {
  document.getElementById("dailyLimitSelect").value = String(S.dailyLimitHours || 8);
  document.getElementById("confirmDeleteToggle").checked = S.confirmBeforeDelete !== false;
  document.getElementById("settingsNameInput").value = S.name || "";
}

async function resetEverything() {
  const msg = "Delete all tasks, history, and settings? This cannot be undone. Your name is kept.";
  if (!(await showConfirm(msg))) return;
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
```

Extend `tab.js`'s `DOMContentLoaded` handler (add to the existing listener from Tasks 6/8):

```javascript
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
```

- [ ] **Step 5: Run and confirm everything passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: `SMOKE: ALL PASS`.

- [ ] **Step 6: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add tab.html tab.js test/smoke.js
git commit -m "Add Settings page: name, daily limit, confirm-before-delete, theme, reset everything"
```

---

### Task 10: "Open full view" link in the popup

**Files:**
- Modify: `popup.html` (add the link/button)
- Modify: `popup.css` (small layout tweak for the topbar, if needed)
- Modify: `popup.js` (wiring)
- Test: `test/smoke.js` (extend `harness1`)

**Interfaces:**
- Consumes: `chrome.tabs.query`/`chrome.tabs.create`/`chrome.tabs.update` (same pattern as `ensureFormTab`), `chrome.runtime.getURL`.
- Produces: `openFullView()` — no return value depended on by other tasks.

- [ ] **Step 1: Add the button to `popup.html`**

In the `.topbar` div (inside `#main`), add the link next to the existing "change" button:

```html
            <div class="topbar">
              <div>
                <div class="who" id="whoName">—</div>
                <div class="muted small" id="whoDate">—</div>
              </div>
              <div>
                <button id="openFullView" class="link">Open full view ⤢</button>
                <button id="changeName" class="link">change</button>
              </div>
            </div>
```

- [ ] **Step 2: Add the failing assertion to `test/smoke.js`**

Extend `harness1`, right before its final `dom.window.close();`:

```javascript
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
```

- [ ] **Step 3: Run and confirm this fails**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: FAIL — `#openFullView` has no click handler yet.

- [ ] **Step 4: Implement `openFullView` in `popup.js` and wire it**

Add near `ensureFormTab` (same file, same pattern):

```javascript
async function openFullView() {
  const url = chrome.runtime.getURL("tab.html");
  const existing = await chrome.tabs.query({ url: url + "*" });
  if (existing[0]) {
    await chrome.tabs.update(existing[0].id, { active: true });
  } else {
    await chrome.tabs.create({ url, active: true });
  }
}
```

Add to the `DOMContentLoaded` wiring block:

```javascript
  $("openFullView").onclick = openFullView;
```

- [ ] **Step 5: Run and confirm everything passes**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup && npm test
```
Expected: `SMOKE: ALL PASS`.

- [ ] **Step 6: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add popup.html popup.js test/smoke.js
git commit -m "Add 'Open full view' link from the popup to the tab view"
```

---

### Task 11: Manual QA pass + README update

No live external site is touched by this feature (Dashboard/Settings/tab view are pure local UI), so this task is a manual click-through of the unpacked extension rather than browser automation against a real site — the way `ensureFormTab`/`fillFormOnPage` were verified earlier in this project's history.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Reload the unpacked extension**

`chrome://extensions` → the Daily Timesheet Auto-Filler card → reload icon.

- [ ] **Step 2: Manual checklist**

Work through each and confirm the observed behavior matches:

1. Click the extension icon (popup) → click **Open full view ⤢** → a new tab opens showing the sidebar (Today/Dashboard/Settings).
2. In the tab's **Today** panel, add a project, start its timer. Switch to the **popup** — confirm the same entry and running timer appear there too (shared storage).
3. In **Dashboard**, confirm the **Today** tile matches the running total, the weekly chart shows today's bar, and `<`/`>` navigate weeks without erroring on weeks with no data.
4. In **Settings**, lower the daily limit to a value already exceeded by today's tracked time — confirm an OS notification appears within a few seconds (may need to also toggle the timer/add an entry to trigger the `storage.onChanged` check).
5. Toggle **Confirm before deleting** off, delete an entry from the Today panel — confirm it deletes immediately, no modal. Toggle it back on — deleting now asks for confirmation.
6. Click each theme button (Dark/Light/System) — confirm colors update immediately in the tab, and reopen the popup — confirm it picked up the same theme.
7. Add a couple of entries, then use **Reset everything** — confirm the confirm modal appears (not a native browser dialog), and after confirming, entries/history/settings are back to defaults but your name is still set (no re-setup prompt).
8. Let a day roll over (or manually edit `chrome.storage.local`'s `date` key via the extensions DevTools console to an old date, then reopen) — confirm yesterday's entries now show up in the Dashboard's history-derived stats instead of vanishing.

- [ ] **Step 3: Update `README.md`**

Add a new section after the existing "Use" section, and update the "Files" table:

```markdown
## Dashboard & Settings (tab view)

Click **Open full view ⤢** in the popup (next to "change") to open a full
browser tab with three sections, sharing live data with the popup:

- **Today** — the same add-project/timer/Final Submit flow as the popup, just
  in a wider layout.
- **Dashboard** — a Mon–Sun weekly chart (browse past weeks with `<`/`>`),
  stat tiles (today / all-time total / daily average / busiest day), and
  time breakdowns by project and by work category. Past days are kept in a
  history log so these stats survive the daily reset that otherwise clears
  the working entry list.
- **Settings** — change your name, set a daily hour limit (fires a one-time
  OS notification when crossed), toggle confirm-before-delete, switch
  Dark/Light/System theme, or reset everything (keeps your name).
```

In the "Files" table, add:

```markdown
| `tab.html` / `tab.css` / `tab.js` | Full tab view: sidebar nav, Dashboard, Settings. Reuses `popup.js` verbatim for the Today section. |
| `theme.css` | CSS custom properties (dark default, light override), consumed by both `popup.css` and `tab.css` |
| `test/` | Node + jsdom regression suite (`npm test`) |
```

- [ ] **Step 4: Commit**

```bash
cd /home/ashraful/Personal/connect-team-form-fillup
git add README.md
git commit -m "Document the Dashboard/Settings tab view in the README"
```

---

## Self-Review Notes

- **Spec coverage:** history archiving (Task 2), confirm-before-delete (Task 3), daily-limit notification (Task 4), theme (Task 5), tab shell/Today reuse (Task 6), Dashboard math + rendering (Tasks 7–8), Settings incl. reset-everything (Task 9), popup link (Task 10), manual QA + docs (Task 11). All spec sections have a task.
- **Type consistency:** `buildDaysMap()`/`dayTotal`/`trackedTotal`/`activeDayCount`/`dailyAverage`/`busiestDay`/`byProject`/`byCategory`/`mondayOf`/`weekDates`/`weekTotals` names match exactly between their definition (Task 7) and every consumer (Tasks 8, 9's test assertions). `resolveTheme`/`applyTheme` (Task 5) match their usage in Task 9's theme buttons and Task 9's `resetEverything`.
- **Deviation from the spec worth flagging to the user:** the spec described "the one canonical name-picker" living only in Settings, with Today linking there when no name is set. Task 6 instead keeps the Today panel's setup flow exactly as in `popup.js` (so `popup.js` truly stays unmodified and `route()`/`showSetup()` need no tab-specific override), and Task 9 adds a **second**, independently-wired name search box in Settings for *changing* an already-set name. Functionally equivalent for the user (name only needs setting once, via either surface), but technically two widget instances rather than one shared component.
