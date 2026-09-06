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

  // Entry B needs >=1 minute too, or the under-1-minute submit block (Req 2,
  // tested below on the third entry) would trip on it here instead.
  const timeInpB = win.document.querySelectorAll(".entry")[1].querySelector(".time");
  timeInpB.value = "00:01"; // exactly 1 minute -> at the block's boundary, not under it
  timeInpB.dispatchEvent(new win.Event("change"));
  await sleep(20);
  A(store.entries[1].accSec === 60, "manual time edit -> 0:01 = 60s");

  // custom in-popup confirm modal (not native window.confirm — that renders
  // cropped/unusable inside a small extension popup)
  lastFill = null;
  $("finalSubmit").click();
  await sleep(30);
  A(!$("confirmOverlay").classList.contains("hidden"), "custom confirm modal shown (no native confirm())");
  A($("confirmMsg").textContent.includes("Re-fill Fillout with all 2 project"), "modal message summarizes the submission");
  A($("confirmMsg").textContent.length < 400, "modal message is a reasonable length (won't overflow)");
  A($("confirmYes").textContent === "Yes, submit", "Final Submit confirm button reads the default 'Yes, submit'");
  $("confirmNo").click();
  await sleep(30);
  A(lastFill === null, "Cancel in modal -> no form fill");
  A($("confirmOverlay").classList.contains("hidden"), "modal hides after Cancel");

  let gdBackupCalls = 0;
  win.gdBackupNow = () => { gdBackupCalls++; return Promise.resolve(); };
  fillFormReturn = { added: 2 };
  $("finalSubmit").click();
  await sleep(30);
  $("confirmYes").click();
  await sleep(300);
  A(Array.isArray(lastFill) && lastFill.length === 2, "final submit sends 2 entries");
  A(lastFill[0].hhmm === "02:30" && lastFill[1].hhmm === "00:01", "payload carries hh:mm per entry");
  A($("submitStatus").textContent.toLowerCase().includes("added"), "success status shown");
  A($("confirmOverlay").classList.contains("hidden"), "modal hides after Yes");
  // regression guard: user reported cold-start failures fixed by manually
  // reloading; ensureFormTab now auto-reloads once for a brand-NEW tab...
  A(reloadCount === 1, `ensureFormTab reloads once for a newly created tab (got ${reloadCount})`);
  A(store.entries.every((e) => e.submitted), "every entry is marked submitted after a successful Final Submit");
  A(gdBackupCalls === 1, "a successful Final Submit triggers a dated Drive backup");

  // Full-resync model (matches the desktop app): clicking Final Submit again
  // with NOTHING changed still re-sends every entry — fillFormOnPage clears
  // whatever's already in the real form first, then fills fresh, so this is
  // safe/idempotent rather than a no-op. This is what makes an edit or a
  // removal (tested next) actually reach the real form on the next click,
  // unlike the old "skip anything already submitted" model.
  lastFill = null;
  gdBackupCalls = 0;
  fillFormReturn = { added: 2 };
  $("finalSubmit").click();
  await sleep(30);
  $("confirmYes").click();
  await sleep(300);
  A(Array.isArray(lastFill) && lastFill.length === 2, "Final Submit again with nothing changed re-sends both entries (full resync, not skipped)");
  A(gdBackupCalls === 1, "the resync still triggers a dated Drive backup");

  // Add ONE new entry -> the NEXT Final Submit must resend ALL THREE (full
  // resync), not just the new one. Also re-verifies ensureFormTab now
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
  // Req 2: Final Submit hard-blocks while ANY entry is under 1 minute of RAW
  // elapsed time. That's only reachable via a timer stopped
  // after a few real seconds — the hh:mm field's finest granularity is 1
  // minute, so a manually-typed time can never land under 60s. Poke the raw
  // accSec directly (same shape a barely-run timer would leave behind).
  const thirdEntry = win.S.entries.find((e) => e.description === "Third task");
  thirdEntry.accSec = 30; // rounds UP to "00:01" in hh:mm display -> must still block
  lastFill = null;
  $("finalSubmit").click();
  await sleep(20);
  A($("confirmOverlay").classList.contains("hidden"), "a sub-minute entry blocks Final Submit even though it rounds up to 00:01 on screen");
  A($("submitStatus").textContent.includes("under 1 minute"), "status explains the under-1-minute block");
  A(lastFill === null, "blocked submit never calls fillFormOnPage");

  thirdEntry.accSec = 90; // fix it -> at least 1 minute, unblocks submit
  lastFill = null;
  fillFormReturn = { added: 3 };
  $("finalSubmit").click();
  await sleep(30);
  A($("confirmMsg").textContent.includes("Re-fill Fillout with all 3 project"), "confirm modal counts ALL entries (full resync), not just the new one");
  $("confirmYes").click();
  await sleep(300);
  A(Array.isArray(lastFill) && lastFill.length === 3 && lastFill[2].description === "Third task" && lastFill[2].hhmm === "00:02",
    "Final Submit resends ALL THREE entries (full resync), including the newly added one");
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

  // COPY TASKS (Req 1): checkbox select -> "Copy to (N)" -> date-picker
  // overlay (min = today) -> confirm copies fresh clones (accSec:0, no
  // submitted flag) into the target day. Seed one entry on today's (now
  // rolled-over) live day, since the prior delete tests left it empty.
  $("projSelect").value = "ZuPOS";
  $("catSelect").value = "Development";
  $("descInput").value = "Copy Tasks source";
  $("timeInput").value = "01:00";
  $("addProject").click();
  await sleep(20);
  A(win.document.querySelector(".entry .copyChk") === null, "no checkboxes rendered outside Copy Tasks mode");
  $("copyModeBtn").click();
  await sleep(10);
  A(win.document.querySelector(".entry .copyChk") !== null, "checkbox column appears once Copy Tasks mode is on");
  A($("copyModeBtn").textContent === "Cancel", "Copy Tasks button becomes Cancel while active");
  A($("copyToBtn").classList.contains("hidden"), "Copy to button stays hidden with nothing selected yet");

  const copySrcId = store.entries[0].id;
  const copySrcEntry = { ...store.entries[0] };
  const firstChk = win.document.querySelector(".entry .copyChk");
  firstChk.checked = true;
  firstChk.dispatchEvent(new win.Event("change"));
  await sleep(10);
  A(!$("copyToBtn").classList.contains("hidden"), "Copy to button appears once >=1 entry is selected");
  A($("copyToBtn").textContent === "Copy to (1)", "Copy to button shows the selection count");

  $("copyToBtn").click();
  await sleep(10);
  A(!$("copyToOverlay").classList.contains("hidden"), "Copy to opens the date-picker overlay");
  A($("copyToDate").min === store.date, "date picker's min is today — past dates disabled");

  // Reject a past date even though the native min= already should have —
  // mirrors the FE guard in the handler itself, not just the input attribute.
  $("copyToDate").value = "2000-01-01";
  $("copyToConfirm").click();
  await sleep(10);
  A(!$("copyToOverlay").classList.contains("hidden"), "a past target date is rejected — overlay stays open");
  A($("copyToStatus").textContent.toLowerCase().includes("future"), "status explains the past-date rejection");

  const futureDate = "2099-06-15"; // safely in the future for any test run
  const historyCountBefore = Object.keys(store.history || {}).length;
  $("copyToDate").value = futureDate;
  $("copyToConfirm").click();
  await sleep(20);
  A($("copyToOverlay").classList.contains("hidden"), "overlay closes after a valid copy");
  A($("copyModeBtn").textContent === "Copy Tasks", "Copy Tasks mode exits automatically after a successful copy");
  A(win.document.querySelector(".entry .copyChk") === null, "checkbox column is gone after exiting Copy Tasks mode");
  A(Object.keys(store.history).length === historyCountBefore + 1, "copying to a future date creates that day's history entry");
  A(store.history[futureDate] && store.history[futureDate].length === 1, "exactly one clone landed on the future day");
  const clone = store.history[futureDate][0];
  A(clone.id !== copySrcId, "the clone gets a fresh id, not the source entry's id");
  A(clone.project === copySrcEntry.project && clone.category === copySrcEntry.category && clone.description === copySrcEntry.description,
    "clone carries over project/category/description");
  A(clone.accSec === 0, "clone's time is reset to 0, not copied from the source");
  A(!clone.submitted, "clone is not marked submitted");
  A($("copyStatus").className === "status ok", "success message uses the green 'ok' status style");
  A($("copyStatus").textContent === `✓ Copied 1 task to ${futureDate}.`, "success message shows a checkmark, count, and target date");

  // Copying to TODAY (the default date the picker opens with) appends
  // straight into S.entries instead of S.history. Re-entering Copy Tasks
  // mode also clears the previous success message.
  $("copyModeBtn").click();
  await sleep(10);
  A($("copyStatus").textContent === "", "success message clears when Copy Tasks mode is re-entered");
  win.document.querySelector(".entry .copyChk").checked = true;
  win.document.querySelector(".entry .copyChk").dispatchEvent(new win.Event("change"));
  await sleep(10);
  const entriesCountBefore = store.entries.length;
  $("copyToBtn").click();
  await sleep(10);
  A($("copyToDate").value === store.date, "date picker defaults to today");
  $("copyToConfirm").click();
  await sleep(20);
  A(store.entries.length === entriesCountBefore + 1, "copying to today appends into today's live entries, not history");
  A(store.entries[store.entries.length - 1].accSec === 0, "today-copy clone also resets to 0");

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

  // top-page mock: Name react-select + Date field + Create + a decoy
  // main-form Submit that must NEVER be clicked by the automation.
  topWin.document.body.appendChild(buildReactSelectControl(topWin.document, "Name"));
  // Date field: confirmed live against the real form it LOOKS like a
  // react-select (accessible role=combobox) but is actually a plain typed
  // input identified by aria-label="Date", not wrapped in .react-select__control.
  const dateInput = topWin.document.createElement("input");
  dateInput.setAttribute("aria-label", "Date");
  dateInput.value = "12/08/2026"; // defaults to "today" until the automation sets it
  topWin.document.body.appendChild(dateInput);
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
  const r = await shell.fillFormOnPage(1, entries, "Debjit Paul", "2026-07-20");
  const raceElapsed = Date.now() - raceStart;
  if (r && r.error) console.log("  [debug] fillFormOnPage result:", JSON.stringify(r));
  A(r && r.added === 2 && !r.error, "fillFormOnPage added 2 entries without error");
  A(dateInput.value === "20/07/2026", "fillFormOnPage sets the Date field to the target day (DD/MM/YYYY), not left on today");
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

  const [dateSkipRes] = await chrome.scripting.executeScript({
    target: { tabId: 1 }, func: shell.pageSelectDate, args: ["2026-07-20"],
  });
  A(dateSkipRes.result && dateSkipRes.result.skipped === true, "pageSelectDate skips re-setting an already-correct date");

  // pageClearExistingEntries: the actual upsert mechanism — deletes every
  // pre-existing entry row (found via its "Edit" control, picking the
  // trailing sibling clickable as the delete "X", same technique already
  // shipped in the desktop app) before a resync fill. Build two rows shaped
  // like the real form (an Edit control + a delete control as siblings) and
  // confirm both get removed.
  for (let i = 0; i < 2; i++) {
    const row = topWin.document.createElement("div");
    row.className = "entryRowMarker";
    const editBtn = topWin.document.createElement("button");
    editBtn.textContent = "Edit";
    const delBtn = topWin.document.createElement("button");
    delBtn.textContent = "×";
    delBtn.addEventListener("click", () => row.remove());
    row.appendChild(editBtn);
    row.appendChild(delBtn);
    topWin.document.body.appendChild(row);
  }
  const [clearRes] = await chrome.scripting.executeScript({
    target: { tabId: 1 }, func: shell.pageClearExistingEntries, args: [],
  });
  A(clearRes.result && clearRes.result.before === 2, "pageClearExistingEntries counts existing rows before clearing");
  A(clearRes.result && clearRes.result.after === 0, "pageClearExistingEntries removes every existing row via its Edit control's sibling delete button");
  A(topWin.document.querySelectorAll("div.entryRowMarker").length === 0, "both entry rows are gone from the DOM (deleted, not just visually hidden)");

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
  const alarms = {}; // name -> config
  const notes = [];
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
    // Name-aware: background.js runs two alarms now (the badge tick and the prayer tick), and a
    // single-slot mock let one clear the other.
    alarms: {
      create: (name, cfg) => { alarms[name] = { name, ...cfg }; },
      clear: (name) => { delete alarms[name]; },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    notifications: { create: (id, opts) => { notes.push({ id, ...opts }); } },
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
  // background.js importScripts()es the prayer helpers into its own global scope; concatenating
  // them ahead of it is what that actually does, so the call itself becomes a no-op here.
  const swPreamble =
    fs.readFileSync(path.join(ROOT, "prayer.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(ROOT, "prayer-hadiths.js"), "utf8") + "\n";
  const fn = new Function("chrome", "importScripts", swPreamble + bgSrc + "\n//# sourceURL=background.js");
  fn(chrome, () => {});
  await sleep(20); // let the top-level syncBadge() resolve

  A(badge.text === "OFF" && badge.color === "#64748b", "initial state (no timer) shows OFF/gray");
  A(alarms.tick === undefined, "no alarm scheduled while idle");
  A(badge.title.includes("no timer running"), "idle tooltip says no timer running");

  // start a timer on entry "e1" (ZuPOS), ~5s ago
  store.entries = [{ id: "e1", project: "ZuPOS", accSec: 0 }];
  fireChange({ timer: { activeId: "e1", startedAt: Date.now() - 5000 } });
  await sleep(20);
  A(badge.color === "#16a34a", "timer start -> badge turns green");
  A(alarms.tick && alarms.tick.name === "tick" && alarms.tick.periodInMinutes === 1, "1-minute repeating alarm scheduled");
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
  A(alarms.tick === undefined, "alarm cleared on pause");

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
  A(badge.color === "#16a34a" && alarms.tick !== undefined, "onStartup re-syncs badge + alarm to running state from storage");

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
  const realSubform = fs.readFileSync(path.join(ROOT, "test", "fixtures", "subform.html"), "utf8");
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
  win.fetch = async (url) => ({ text: async () => (String(url).includes("kwgd21pozYus") ? realSubform : "") });
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

  // "Fetch projects & categories" — pulls the live lists from the subform,
  // overriding the hardcoded defaults (Task: keep them from going stale).
  $("loadProjects").click();
  await sleep(80);
  A(store.projects && store.projects.length === 19, "19 projects parsed from real subform HTML");
  A(store.projects.includes("Others") && store.projects[store.projects.length - 1] === "Others", "projects keep the form's native order (catch-all 'Others' stays last, not alphabetized)");
  A(store.categories && store.categories.length === 5, "5 categories parsed from real subform HTML");
  A($("catSelect").options.length === 5 && $("catSelect").options[0].value === "Meeting (General)", "catSelect is repopulated from the freshly fetched categories");
  A(win.currentProjects() === store.projects, "currentProjects() prefers the fetched list over the hardcoded default");

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
// HARNESS 7 — Drive sync merge (pure functions from gdrive.js)
// ============================================================
async function harness7() {
  console.log("\n== Harness 7: Drive sync merge ==");
  const gdSrc = fs.readFileSync(path.join(ROOT, "gdrive.js"), "utf8");
  const ctx = {};
  const vm = require("vm");
  vm.createContext(ctx);
  vm.runInContext(gdSrc, ctx);

  A(ctx.gdTotalEntries({ "2026-07-01": [{}, {}], "2026-07-02": [{}] }) === 3, "gdTotalEntries sums entries across all days");
  A(ctx.gdTotalEntries({}) === 0, "gdTotalEntries of no days is 0");
  A(ctx.gdTotalEntries({ "2026-07-01": [] }) === 0, "gdTotalEntries of an empty day is 0");

  // The actual scenario: phone (offline) added task A, desktop (offline)
  // added task B on the same day — both must survive the merge, not one
  // override the other.
  const phone = { "2026-07-20": [{ id: "A", description: "phone task" }] };
  const desktop = { "2026-07-20": [{ id: "B", description: "desktop task" }] };
  let m = ctx.gdMergeDays(phone, {}, desktop, {});
  A(m.days["2026-07-20"].length === 2, "entries added on two offline devices both survive the merge");
  A(m.days["2026-07-20"].some((e) => e.id === "A") && m.days["2026-07-20"].some((e) => e.id === "B"),
    "merge keeps both devices' entries by id, not just one side");

  // A completely empty side must never erase the other's data — this is
  // the actual incident: Reset (or a bad Restore) emptied one side.
  m = ctx.gdMergeDays({}, {}, { "2026-07-20": [{ id: "A" }] }, {});
  A(m.days["2026-07-20"].length === 1, "an empty local side does not erase Drive's entries");
  m = ctx.gdMergeDays({ "2026-07-20": [{ id: "A" }] }, {}, {}, {});
  A(m.days["2026-07-20"].length === 1, "an empty Drive side does not erase local entries");

  // Deleting an entry (tombstoned) must actually stick, not get resurrected
  // by the other side's stale pre-delete copy.
  m = ctx.gdMergeDays(
    { "2026-07-20": [] }, { A: Date.now() },              // this device deleted A
    { "2026-07-20": [{ id: "A" }] }, {}                     // Drive still has the old copy
  );
  A(!m.days["2026-07-20"], "a tombstoned entry is not resurrected from the other side's stale copy");
  A("A" in m.deleted, "merge carries the tombstone forward");

  // Same id edited on both sides while offline needs a deterministic pick —
  // local wins (documented tie-break, not a "correct" resolution).
  m = ctx.gdMergeDays(
    { "2026-07-20": [{ id: "A", description: "local edit" }] }, {},
    { "2026-07-20": [{ id: "A", description: "drive edit" }] }, {}
  );
  A(m.days["2026-07-20"][0].description === "local edit", "same-id collision deterministically prefers local");
}

// Regression test for the "previous day's entries vanish" bug: tab.html
// keeps its own long-lived copy of popup.js's S — if it's ever left open
// across a day rollover, its in-memory S.history goes stale (it never
// re-runs init()). Before patchHistoryDay(), any write from that stale
// context did `chrome.storage.local.set({ history: S.history })` — a blind
// full-object replace — silently erasing whatever another context (e.g. a
// fresh popup) had just archived. This proves the merge-on-write fix holds.
async function harness8() {
  console.log("\n== Harness 8: history merge-on-write (stale second context) ==");
  const store = {}; // shared backing store simulating the one real chrome.storage.local
  const chromeMock = {
    storage: { local: {
      get: async (k) => (k === null ? { ...store } : {}),
      set: async (obj) => { Object.assign(store, obj); },
    } },
  };
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/" });
  dom.window.chrome = chromeMock;
  dom.window.crypto = { randomUUID: () => "id-x" };
  // jsdom fires its own real DOMContentLoaded asynchronously — racing it
  // against direct calls below would let init() run concurrently and stomp
  // the store. Neuter the listener registration so popup.js's wiring
  // (init()/route()) never fires; only patchHistoryDay itself is under test.
  dom.window.document.addEventListener = () => {};
  const s = dom.window.document.createElement("script");
  s.textContent = jsSrc;
  dom.window.document.body.appendChild(s);
  const win = dom.window;

  // "Context A" (e.g. a fresh popup) archives day X.
  win.S.history = {};
  await win.patchHistoryDay("2026-08-10", [{ id: "e1", description: "day X entry" }]);
  A(store.history["2026-08-10"].length === 1, "context A's archive lands in storage");

  // "Context B" is stale — its in-memory S.history predates day X entirely,
  // same shape a long-open tab.html tab would have — then writes day Y.
  win.S.history = {};
  await win.patchHistoryDay("2026-08-11", [{ id: "e2", description: "day Y entry" }]);
  A(store.history["2026-08-10"] && store.history["2026-08-10"].length === 1,
    "a stale second context writing a DIFFERENT day does not erase day X");
  A(store.history["2026-08-11"] && store.history["2026-08-11"].length === 1,
    "day Y is also present after the second context's write");
  dom.window.close();
}

// ============================================================
// HARNESS 9 — day-submitted marking: tombstones + Final Submit gating
// ============================================================
async function harness9() {
  console.log("\n== Harness 9: mark/unmark tombstones + Final Submit gating ==");
  const store = {};
  const chromeMock = {
    storage: { local: {
      get: async (k) => (k === null ? { ...store } : {}),
      set: async (obj) => { Object.assign(store, obj); },
    } },
  };
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/" });
  dom.window.chrome = chromeMock;
  dom.window.crypto = { randomUUID: () => "id-x" };
  dom.window.document.addEventListener = () => {}; // keep init()/route() out of it — see harness8
  const s = dom.window.document.createElement("script");
  s.textContent = jsSrc;
  dom.window.document.body.appendChild(s);
  const win = dom.window;

  const DAY = "2026-09-04";
  win.S.date = DAY;
  win.S.entries = [{ id: "e1", project: "P", category: "C", description: "d", accSec: 600 }];
  win.S.history = {};
  win.S.submittedDays = {};
  win.S.timer = { activeId: null, startedAt: null };
  win.setViewDate(DAY);

  await win.markDaySubmitted(DAY, "manual");
  A(win.daySubmitted(DAY) === true, "marking a day reports it submitted");
  A(win.document.getElementById("finalSubmit").disabled === true, "Final Submit is disabled while the day is marked");

  await win.unmarkDaySubmitted(DAY);
  A(win.daySubmitted(DAY) === false, "unmarking clears the submitted state");
  A(win.document.getElementById("finalSubmit").disabled === false, "Final Submit is usable again after unmarking");

  // The bug this guards: `delete`-ing the key left nothing for the Drive merge
  // ({...drive, ...local}) to override, so the day came back marked ~2.5s later.
  A(DAY in store.submittedDays, "unmark leaves a tombstone in storage, not a missing key");
  A(store.submittedDays[DAY] === null, "the tombstone is an explicit null");
  const drive = { [DAY]: { at: 1, method: "manual" } };
  const merged = { ...drive, ...store.submittedDays };
  A(merged[DAY] === null, "a Drive copy that still has the day marked cannot resurrect it");

  // A tombstone must never crash the listener that pushes to the dashboard.
  const seen = [];
  win.pushIngest = async (d) => seen.push(["ingest", d]);
  win.pushUnmark = async (d) => seen.push(["unmark", d]);
  let threw = null;
  try {
    for (const [date, info] of Object.entries(store.submittedDays)) {
      if (info) { win.pushIngest(date, info.method); } else if (drive[date]) { win.pushUnmark(date); }
    }
  } catch (e) { threw = e; }
  A(threw === null, "reading a tombstoned day does not throw on info.method");
  A(seen.length === 1 && seen[0][0] === "unmark", "a tombstoned day pushes an unmark, not an ingest");
  dom.window.close();
}

// ============================================================
// HARNESS 10 — prayer times: pure scheduling logic + the notification path
// ============================================================
async function harness10() {
  console.log("\n== Harness 10: prayer reminders ==");
  const vm = require("vm");
  const ctx = { console, Intl, Date, fetch: async () => { throw new Error("no network in tests"); } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "prayer.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "prayer-hadiths.js"), "utf8"), ctx);

  const raw = {
    Fajr: "04:23 (+06)", Sunrise: "05:40 (+06)", Dhuhr: "11:58 (+06)", Asr: "15:27 (+06)",
    Sunset: "18:17 (+06)", Maghrib: "18:17 (+06)", Isha: "19:34 (+06)", Imsak: "04:13 (+06)",
    Midnight: "23:58 (+06)",
  };
  const five = ctx.prayerPickFive(raw);
  A(Object.keys(five).join() === "Fajr,Dhuhr,Asr,Maghrib,Isha", "only the five obligatory prayers are kept");
  A(five.Fajr === "04:23", "the API's \" (+06)\" offset suffix is stripped");
  A(!("Sunrise" in five) && !("Imsak" in five) && !("Midnight" in five), "Sunrise/Imsak/Midnight can never raise a notification");

  A(ctx.prayerToMinutes("04:23") === 263, "hh:mm parses to minutes");
  A(ctx.prayerToMinutes("nonsense") === null, "junk parses to null rather than NaN");

  let r = ctx.prayerDue(five, 15 * 60 + 27, []);
  A(r.due.join() === "Asr", "a prayer fires on its exact minute");
  r = ctx.prayerDue(five, 15 * 60 + 30, []);
  A(r.due.join() === "Asr", "only the just-passed prayer fires");
  A(r.stale.join() === "Fajr,Dhuhr", "prayers well past are marked stale, not fired");
  r = ctx.prayerDue(five, 22 * 60, []);
  A(r.due.length === 0 && r.stale.length === 5, "waking at 22:00 fires nothing instead of five at once");
  r = ctx.prayerDue(five, 15 * 60 + 30, ["Asr"]);
  A(r.due.length === 0, "an already-notified prayer never repeats");

  A(ctx.prayerNext(five, 12 * 60).name === "Asr", "next-prayer lookup skips the ones already passed");
  A(ctx.prayerNext(five, 20 * 60) === null, "after Isha there is no next prayer today");

  A(ctx.prayerStatusLine(five, 12 * 60 + 53) === "Dhuhr 2hr 34min remaining, Asr: 3:27 PM",
    "the status line names the running prayer's time left and the next prayer's clock time");
  A(ctx.prayerStatusLine(five, 2 * 60) === "Fajr: 4:23 AM",
    "before the first prayer the current half and its comma are both dropped");
  A(ctx.prayerStatusLine(five, 21 * 60) === "Isha now",
    "after the last prayer the next half and its comma are both dropped");
  A(ctx.prayerStatusLine(five, 15 * 60) === "Dhuhr 27min remaining, Asr: 3:27 PM",
    "under an hour left drops the hour part");
  A(ctx.prayerStatusLine({}, 12 * 60) === "", "no times at all yields nothing, not a bare comma");
  A(ctx.prayerStatusLine({ Dhuhr: "12:05" }, 0).endsWith("12:05 PM"), "noon renders as 12 PM, not 0 PM");

  const cal = ctx.prayerIndexCalendar([{ date: { gregorian: { date: "01-09-2026" } }, timings: raw }]);
  A(Object.keys(cal)[0] === "2026-09-01", "the API's DD-MM-YYYY date is flipped to YYYY-MM-DD");
  A(Object.keys(ctx.prayerPruneToMonth({ "2026-08-31": 1, "2026-09-01": 2 }, "2026-09")).join() === "2026-09-01",
    "pruning drops other months so the cache can't grow forever");

  const a = ctx.prayerReminderAt(0), b = ctx.prayerReminderAt(1);
  A(a && a.text && a.source && a.text !== b.text, "reminders rotate rather than repeating");
  A(ctx.prayerReminderAt(-1).text === ctx.prayerReminderAt(PRAYER_COUNT_PROBE(ctx) - 1).text, "the rotation wraps on negatives too");
  A(ctx.prayerNotificationText("Asr", a).title === "আসরের ওয়াক্ত হয়েছে", "the notification names the prayer in Bengali");
  A(["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"].every((n) => ctx.prayerNotificationText(n, a).title !== n),
    "every one of the five prayers has a Bengali heading");
  A(ctx.prayerNotificationText("Sunrise", a).title === "Sunrise", "an unmapped name falls back instead of showing undefined");

  // --- the real path: background.js, with a day cached and the clock past Asr ---
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const notes = [];
  const alarms = {};
  const listeners = { alarm: [], changed: [] };
  const store = {
    timer: { activeId: null, startedAt: null },
    entries: [],
    prayer: { enabled: true, city: "Dhaka", country: "Bangladesh", method: 1, school: 1,
              days: { [key]: { Fajr: "00:01", Dhuhr: "00:02", Asr: "00:03", Maghrib: "23:58", Isha: "23:59" } },
              notified: {}, reminderIndex: 0 },
  };
  const chromeMock = {
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
    storage: { local: {
      get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]])) : { [k]: store[k] }),
      set: async (obj) => { Object.assign(store, obj); },
    }, onChanged: { addListener: (fn) => listeners.changed.push(fn) } },
    alarms: { create: (n, c) => { alarms[n] = c; }, clear: (n) => { delete alarms[n]; },
              onAlarm: { addListener: (fn) => listeners.alarm.push(fn) } },
    notifications: { create: (id, o) => notes.push({ id, ...o }) },
    runtime: { onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} } },
  };
  const swPreamble =
    fs.readFileSync(path.join(ROOT, "prayer.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(ROOT, "prayer-hadiths.js"), "utf8") + "\n";
  const bg = new Function("chrome", "importScripts",
    swPreamble + fs.readFileSync(path.join(ROOT, "background.js"), "utf8"));
  bg(chromeMock, () => {});
  await sleep(30);
  A(alarms.prayerTick && alarms.prayerTick.periodInMinutes === 1,
    "an enabled city schedules the 1-minute prayer alarm");

  listeners.alarm.forEach((f) => f({ name: "prayerTick" }));
  await sleep(30);
  // Maghrib/Isha are still ahead; Fajr/Dhuhr/Asr are hours past, so all three are silenced.
  A(notes.length === 0, "prayers hours past are silenced instead of firing a burst");
  A((store.prayer.notified[key] || []).join() === "Fajr,Dhuhr,Asr", "they are still recorded so they can't fire later");

  // Now put one prayer inside the grace window and re-run.
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  store.prayer = { ...store.prayer, days: { [key]: { ...store.prayer.days[key], Maghrib: hhmm } }, notified: {} };
  notes.length = 0;
  listeners.alarm.forEach((f) => f({ name: "prayerTick" }));
  await sleep(30);
  A(notes.length === 1 && notes[0].title === "মাগরিবের ওয়াক্ত হয়েছে", "a prayer that is due right now fires exactly one notification");
  A(!!notes[0].message && notes[0].message.includes("—"), "the notification carries a reminder and its source");

  notes.length = 0;
  listeners.alarm.forEach((f) => f({ name: "prayerTick" }));
  await sleep(30);
  A(notes.length === 0, "the same prayer does not fire again on the next tick");

  // Disabling must stop it dead.
  store.prayer = { ...store.prayer, enabled: false, notified: {} };
  notes.length = 0;
  listeners.alarm.forEach((f) => f({ name: "prayerTick" }));
  await sleep(30);
  A(notes.length === 0, "the toggle switched off means no notifications at all");
}
function PRAYER_COUNT_PROBE(ctx) {
  let n = 1;
  while (ctx.prayerReminderAt(n).text !== ctx.prayerReminderAt(0).text) n++;
  return n;
}

(async () => {
  await harness1();
  await harness2();
  await harness3();
  await harness4();
  await harness5();
  await harness6();
  await harness7();
  await harness8();
  await harness9();
  await harness10();
  console.log(fails === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${fails} FAILURE(S)`);
  process.exit(fails === 0 ? 0 : 1);
})();
