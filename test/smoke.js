const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
//* popup.html loads sync-core.js + data.js ahead of popup.js; every harness that injects "popup.js"
//* gets the same stack.
const jsSrc = ["sync-core.js", "data.js", "popup.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n");

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

  // Row time is two selects (hrs/min), same widget as the desktop app —
  // setTime() drives them the way a user picking values would.
  function setTime(rowIdx, hh, mm) {
    const row = win.document.querySelectorAll(".entry")[rowIdx].querySelector(".timepick");
    row.querySelector(".thrs").value = String(hh);
    row.querySelector(".tmins").value = String(mm);
    row.querySelector(".tmins").dispatchEvent(new win.Event("change", { bubbles: true }));
  }
  setTime(0, 2, 30);
  await sleep(20);
  A(store.entries[0].accSec === 9000, "time picker edit -> 2:30 = 9000s");
  //! This is the bug the picker landed with: editTime persisted but never
  //! refreshed the header, so the day total sat at its old value.
  A($("dayTotal").textContent === "02:30", "day total updates as soon as a row's time changes");

  // Entry B needs >=1 minute too, or the under-1-minute submit block (Req 2,
  // tested below on the third entry) would trip on it here instead.
  setTime(1, 0, 1); // exactly 1 minute -> at the block's boundary, not under it
  await sleep(20);
  A(store.entries[1].accSec === 60, "time picker edit -> 0:01 = 60s");
  A($("dayTotal").textContent === "02:31", "day total sums both edited rows");

  // A timer left running overnight lands past 23h, which a fixed 24-option
  // hours list could not represent — it would rewrite the entry on change.
  const overnight = win.document.createElement("div");
  overnight.innerHTML = `<span class="timepick">${win.timePickInnerHTML(26 * 3600 + 15 * 60)}</span>`;
  const opick = overnight.querySelector(".timepick");
  A(opick.querySelector(".thrs").options.length === 27, "hours list grows to fit a 26-hour entry");
  A(win.pickHHMM(opick) === "26:15", "an over-24h time round-trips through the picker unchanged");
  A(win.timePickInnerHTML(0).includes("00 hrs"), "options carry the desktop app's hrs/min labels");
  // syncPickTime is what the tick uses — it must grow the list in place when a
  // timer crosses past the last hour it has an option for.
  win.syncPickTime(opick, 30 * 3600 + 5 * 60);
  A(opick.querySelector(".thrs").options.length === 31, "the live tick grows the hours list in place");
  A(win.pickHHMM(opick) === "30:05", "the grown list selects the new hour");

  // The running row is redrawn every second by the live tick. Editing its time
  // has to keep working after a tick has landed.
  win.document.querySelectorAll(".entry")[0].querySelector(".tbtn").click();
  await sleep(1100); // one full tick of the live clock
  setTime(0, 5, 0);
  await sleep(20);
  A(store.entries[0].accSec === 18000, "a running row's time is still editable after a live tick");
  win.document.querySelectorAll(".entry")[0].querySelector(".tbtn").click();
  await sleep(20);
  setTime(0, 2, 30); // put it back — the submit-payload assertions below expect 02:30
  await sleep(20);
  A(store.entries[0].accSec === 9000, "restored to 2:30 for the assertions that follow");

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
  const archivedPick = win.document.querySelector(".entry .timepick");
  archivedPick.querySelector(".thrs").value = "1";
  archivedPick.querySelector(".thrs").dispatchEvent(new win.Event("change", { bubbles: true }));
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
  //* Back to the real calendar before the tests below; the data layer rolls on every write, so the
  //* fake 2099 day must be settled first or every later add would land under it.
  store.history = {}; store.entries = []; store.date = realTodayStr();
  await win.init();
  await sleep(30);

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
  win.setFormTime("01:00");
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
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
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
    ["prayer.js", "prayer-hadiths.js", "sync-core.js", "data.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n") + "\n";
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
  A($("resetEverything").disabled, "Reset stays disabled until RESET is typed");
  await win.resetEverything();
  await sleep(20);
  A($("confirmOverlay").classList.contains("hidden") && store.entries.length === 1, "calling reset without typing RESET does nothing (checked in the handler, not just the button)");
  $("resetConfirmInput").value = "RESET";
  $("resetConfirmInput").dispatchEvent(new win.Event("input"));
  A(!$("resetEverything").disabled, "typing RESET enables the button");
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
  console.log("\n== Harness 7: sync v2 core (merge, clock, restore) ==");
  const vm = require("vm");
  const ctx = { crypto: require("crypto").webcrypto, Date, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "sync-core.js"), "utf8"), ctx);
  const C = ctx.TTCore;
  const D = "2026-07-20";
  const ids = (st) => (st.days[D] || []).map((e) => e.id).sort().join(",");
  const dev = (id) => C.ensureMeta({ deviceId: id, days: {} });

  // Offline adds on two devices both survive.
  let m = C.merge([{ days: { [D]: [{ id: "A" }] } }, { days: { [D]: [{ id: "B" }] } }]);
  A(ids(m) === "A,B", "entries added on two offline devices both survive the merge");
  A(ids(C.merge([{ days: {} }, { days: { [D]: [{ id: "A" }] } }])) === "A", "an empty side cannot erase the other side's entries");
  A(ids(C.merge([{ days: { [D]: [{ id: "A" }] } }, {}])) === "A", "...in either direction");

  // Deletes stick, and a newer write beats an older tombstone (restore).
  const a = dev("devA");
  const e = C.touch(a, { id: "X", project: "P", description: "v1" });
  C.tombstone(a, "X");
  m = C.merge([{ days: { [D]: [e] }, deletedEntries: a.deletedEntries }, { days: { [D]: [{ ...e }] } }]);
  A(ids(m) === "", "a tombstoned entry is not resurrected by another device's stale copy");
  const restored = C.touch(a, { ...e });
  m = C.merge([{ days: { [D]: [restored] }, deletedEntries: a.deletedEntries }, { days: { [D]: [e] }, deletedEntries: a.deletedEntries }]);
  A(ids(m) === "X", "a restored entry (fresh stamp) beats the tombstone that removed it");

  // Newest edit wins no matter which side is "local", even with a clock running behind.
  const b = dev("devB");
  const old = C.touch(a, { id: "T", description: "old" });
  b.clock = old.updatedAt; // devB has seen A's version...
  const realNow = ctx.Date.now;
  ctx.Date.now = () => old.updatedAt - 3600e3; // ...and its wall clock is an hour behind
  const newer = C.touch(b, { ...old, description: "new" });
  ctx.Date.now = realNow;
  A(newer.updatedAt > old.updatedAt, "a device with a slow clock still stamps later than anything it has seen");
  for (const order of [[old, newer], [newer, old]]) {
    m = C.merge(order.map((x) => ({ days: { [D]: [x] } })));
    A(m.days[D][0].description === "new", "newest edit wins regardless of merge order");
  }

  // Legacy (unstamped) same-id collision picks the same winner everywhere.
  const l1 = { id: "L", description: "x", accSec: 60 }, l2 = { id: "L", description: "y", accSec: 120 };
  A(C.merge([{ days: { [D]: [l1] } }, { days: { [D]: [l2] } }]).days[D][0].accSec === 120 &&
    C.merge([{ days: { [D]: [l2] } }, { days: { [D]: [l1] } }]).days[D][0].accSec === 120,
  "an unstamped legacy collision resolves the same way in both orders (more tracked time wins)");

  // submittedDays: unmark is stamped and beats an older mark; legacy null gets a stamp once.
  const s = dev("devS");
  C.setSubmitted(s, D, "manual");
  const marked = { ...s.submittedDays };
  C.setSubmitted(s, D, null);
  A(!C.isMarked(C.merge([{ submittedDays: marked }, { submittedDays: s.submittedDays }]).submittedDays[D]), "a later unmark beats an earlier mark in both orders");
  A(!C.isMarked(C.merge([{ submittedDays: s.submittedDays }, { submittedDays: marked }]).submittedDays[D]), "...either way round");
  const leg = C.ensureMeta({ deviceId: "z", submittedDays: { [D]: null } });
  A(leg.submittedDays[D] && leg.submittedDays[D].at > 0 && !C.isMarked(leg.submittedDays[D]), "a legacy null unmark is converted to a stamped unmark");

  // Algebra: random states merge the same in any order and grouping, and merging twice changes nothing.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const randState = () => {
    const st = { days: {}, deletedEntries: {}, submittedDays: {} };
    for (let i = 0; i < 6; i++) {
      const date = "2026-07-" + (10 + rnd(3));
      (st.days[date] = st.days[date] || []).push({ id: "e" + rnd(8), description: "d" + rnd(5), accSec: rnd(4) * 60, updatedAt: rnd(5) * 1000, updatedBy: "dev" + rnd(3) });
    }
    if (rnd(2)) st.deletedEntries["e" + rnd(8)] = rnd(5) * 1000 + 500;
    st.submittedDays["2026-07-1" + rnd(3)] = { at: rnd(5), method: rnd(2) ? "auto" : null, by: "dev" + rnd(3) };
    return st;
  };
  let algebraOk = true;
  for (let i = 0; i < 300; i++) {
    const x = randState(), y = randState(), z = randState();
    const s1 = C.sig(C.merge([x, y, z])), s2 = C.sig(C.merge([z, x, y])), s3 = C.sig(C.merge([C.merge([x, y]), z]));
    const s4 = C.sig(C.merge([x, C.merge([y, z])])), s5 = C.sig(C.merge([C.merge([x, y, z]), x, y]));
    if (!(s1 === s2 && s2 === s3 && s3 === s4 && s4 === s5)) { algebraOk = false; break; }
  }
  A(algebraOk, "300 random triples: merge is commutative, associative and idempotent (all devices converge)");

  const junk = C.merge([{ days: { [D]: [{ id: "legacyX" }] }, deletedEntries: { legacyX: "NaN" } }, { deletedEntries: { legacyX: 0 } }]);
  A(ids(junk) === "legacyX", "a junk or zero tombstone never deletes an entry");

  const pd = dev("devP");
  pd.days = { [D]: [{ id: "mine" }] };
  const poisoned = C.merge([C.stateOf(pd), { days: { [D]: [{ id: "p", updatedAt: "Infinity" }] }, clock: 1e20, deletedEntries: { mine: 1e20 } }]);
  pd.clock = Math.max(pd.clock, poisoned.clock);
  const s1 = C.touch(pd, { id: "n1" }).updatedAt, s2 = C.touch(pd, { id: "n2" }).updatedAt;
  A(ids(poisoned).includes("mine") && isFinite(poisoned.clock) && s2 > s1, "absurd times (Infinity, 1e20) in a corrupt file can't poison the clock or delete anything");

  // Restore candidates + apply.
  const cur = { days: { [D]: [{ id: "keep" }] } };
  const backup = { days: { [D]: [{ id: "keep" }, { id: "gone", description: "lost one", accSec: 90 }], "2026-07-01": [{ id: "old" }] } };
  const cands = C.restoreCandidates(cur, backup);
  A(cands.length === 2 && !cands.some((c) => c.entry.id === "keep"), "restore offers only tasks missing now, never ones already here");
  const d = dev("devR");
  d.days = { [D]: [{ id: "keep" }] };
  d.deletedEntries.gone = C.stamp(d);
  const added = C.applyRestore(d, d.days, [cands.find((c) => c.entry.id === "gone")]);
  A(added.length === 1 && C.isLive(added[0].e, d.deletedEntries), "an applied restore is live despite the tombstone that removed it");
  A(C.applyRestore(d, d.days, [cands.find((c) => c.entry.id === "gone")]).length === 0, "restoring the same task twice does not duplicate it");

  // Diff describes a remote delete with its source.
  const before = { days: { [D]: [{ id: "k1", project: "P", description: "gone soon" }] } };
  const after = C.merge([before, { deletedEntries: { k1: 99 }, deletedBy: { k1: "devPhone" } }]);
  const evs = C.diffEvents(C.diff(before, after), "sync", { devPhone: "Android" });
  A(evs.length === 1 && evs[0].type === "removed" && evs[0].reason.includes("Android"), "the log names which device deleted a removed task");
}

// Regression test for the "previous day's entries vanish" bug: a long-open
// tab.html used to write its own stale copy of S over what another window had
// just saved. Every change now goes through TTData.withData (lock + fresh read).
async function harness8() {
  console.log("\n== Harness 8: two windows, one storage — no window erases another's write ==");
  const store = {};
  const locks = makeLocks();
  const w1 = makeDataContext(store, locks);
  const w2 = makeDataContext(store, locks);
  const today = w1.todayStr();
  // Window 1 opened long ago (stale cache); window 2 adds to another day and to today.
  w1.S = await w1.chrome.storage.local.get(null);
  await w2.mutate((d) => { w2.TTData.list(d, "2026-08-10").push({ id: "x1", description: "day X" }); });
  await w2.mutate((d) => { w2.TTData.list(d, today).push({ id: "t1", description: "today from w2" }); });
  await w1.mutate((d) => { w1.TTData.list(d, "2026-08-11").push({ id: "y1", description: "day Y" }); });
  await w1.mutate((d) => { w1.TTData.list(d, today).push({ id: "t2", description: "today from w1" }); });
  A(store.history["2026-08-10"] && store.history["2026-08-11"], "writes to different days from two windows both survive");
  A(store.entries.map((e) => e.id).sort().join(",") === "t1,t2", "adds to today from two windows both survive");
  // Interleaved: both windows start a change at the same moment.
  await Promise.all([
    w1.mutate((d) => { w1.TTData.list(d, today).push({ id: "c1" }); }),
    w2.mutate((d) => { w2.TTData.list(d, today).push({ id: "c2" }); }),
  ]);
  A(["c1", "c2"].every((id) => store.entries.some((e) => e.id === id)), "two simultaneous changes are serialized by the lock, neither lost");
  w1.close(); w2.close();
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
  A(store.submittedDays[DAY].method === null && store.submittedDays[DAY].at > 0, "the tombstone is a stamped unmark");
  const drive = { [DAY]: { at: 1, method: "manual" } };
  const merged = win.TTCore.merge([{ submittedDays: drive }, { submittedDays: store.submittedDays }]);
  A(!win.TTCore.isMarked(merged.submittedDays[DAY]), "a Drive copy that still has the day marked cannot resurrect it");

  // Same branch the storage listener takes for the dashboard push.
  const seen = [];
  for (const [date, info] of Object.entries(store.submittedDays)) {
    if (win.TTCore.isMarked(info)) seen.push(["ingest", date]);
    else if (win.TTCore.isMarked(drive[date])) seen.push(["unmark", date]);
  }
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
  const five = ctx.prayerPickTimes(raw);
  A(Object.keys(five).join() === "Fajr,Dhuhr,Asr,Maghrib,Isha,Sunrise,Sunset,Midnight",
    "the five prayers are kept, plus the boundaries a waqt ends on");
  A(five.Fajr === "04:23", "the API's \" (+06)\" offset suffix is stripped");
  A(!("Imsak" in five) && !("Firstthird" in five), "timings nothing needs are dropped");
  //! The boundaries are stored now, so this has to be enforced where it matters instead.
  A(ctx.prayerDue(five, 5 * 60 + 40, []).due.length === 0 &&
    ctx.prayerDue(five, 23 * 60 + 58, []).due.length === 0,
    "Sunrise/Sunset/Midnight can never raise a notification");
  A(ctx.prayerNext(five, 5 * 60) .name === "Dhuhr", "the next-prayer lookup skips Sunrise");

  //* Waqt ends: Fajr at sunrise (minus the margin), Isha at Islamic midnight, the rest at the
  //* next prayer's start.
  A(ctx.prayerWaqtEnd(five, "Fajr") === 5 * 60 + 30, "Fajr ends 10 minutes before sunrise, not at Dhuhr");
  A(ctx.prayerWaqtEnd(five, "Asr") === 18 * 60 + 7, "Asr ends 10 minutes before Maghrib");
  A(ctx.prayerAsrMakruhStart(five) === 17 * 60 + 57, "Asr turns makruh 20 minutes before Maghrib");
  A(ctx.prayerCurrent(five, 17 * 60 + 50).makruh === false && ctx.prayerCurrent(five, 17 * 60 + 58).makruh === true,
    "the makruh flag is set only inside that window");
  A(ctx.prayerStatusLine(five, 17 * 60 + 58) === "Asr 9min remaining (makruh), Maghrib: 6:17 PM",
    "the status line says makruh when it is");

  //* Asr ends 18:07 here, so the leads land at 17:37 and 17:52.
  A(ctx.prayerEndingWarnings(five, 17 * 60 + 37, []).due.map((d) => d.mark).join() === "Asr:30",
    "the 30-minute expiry warning fires on its minute");
  A(ctx.prayerEndingWarnings(five, 17 * 60 + 45, []).due[0].leftMin === 22,
    "a warning firing late reports the real minutes left, not its lead");
  A(ctx.prayerEndingWarnings(five, 18 * 60 + 10, []).due.length === 0 &&
    ctx.prayerEndingWarnings(five, 18 * 60 + 10, [], 60).due.length === 0,
    "an expired waqt is never warned about, however wide the grace window");
  A(ctx.prayerEndingWarnings(five, 3 * 60, []).due.length === 0, "a prayer that has not started is never warned about");
  A(ctx.prayerEndingWarnings(five, 17 * 60 + 37, ["Asr:30"]).due.length === 0, "a warning already sent never repeats");
  A(ctx.prayerEndingWarnings(five, 17 * 60 + 37, ["Asr"]).due.length === 1 &&
    ctx.prayerDue(five, 15 * 60 + 27, ["Asr:30"]).due.join() === "Asr",
    "start marks and warning marks cannot silence each other");
  A(ctx.prayerEndingWarnings(five, 18 * 60 + 5, []).stale.includes("Asr:30"),
    "a warning long past its window is recorded silently, not fired on wake-up");
  A(ctx.prayerWaqtEnd({ Fajr: "04:23", Sunrise: "04:25" }, "Fajr") === null,
    "a sunrise minutes after Fajr is degenerate data, not a 24-hour waqt");
  A(ctx.prayerWaqtEnd(five, "Isha") === 23 * 60 + 58, "Isha ends at Islamic midnight");
  A(ctx.prayerWaqtEnd({ ...five, Midnight: "00:12" }, "Isha") === 24 * 60 + 12,
    "an Islamic midnight past 00:00 is pushed into the next day instead of reading as expired");
  A(ctx.prayerWaqtEnd({ Fajr: "04:23" }, "Fajr") === null, "an end with no boundary cached is null, not a guess");

  A(ctx.prayerCurrent(five, 4 * 60 + 30).name === "Fajr", "Fajr is current just after it starts");
  A(ctx.prayerCurrent(five, 5 * 60 + 35) === null, "Fajr is over past sunrise — the gap until Dhuhr has no current prayer");
  A(ctx.prayerCurrent(five, 23 * 60 + 59) === null, "Isha is over past Islamic midnight");
  A(ctx.prayerCurrent({ Fajr: "04:23", Dhuhr: "11:58" }, 5 * 60).name === "Fajr",
    "with no boundaries cached it falls back to the next prayer's start rather than expiring early");

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
  A(ctx.prayerStatusLine(five, 21 * 60) === "Isha 2hr 58min remaining",
    "after the last prayer the next half and its comma are both dropped");
  A(ctx.prayerStatusLine(five, 4 * 60 + 30) === "Fajr 1hr remaining, Dhuhr: 11:58 AM",
    "Fajr counts down to sunrise, not to Dhuhr");
  A(ctx.prayerStatusLine(five, 6 * 60) === "Dhuhr: 11:58 AM",
    "in the gap after sunrise only the next prayer is shown");
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
    runtime: { onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} }, onMessage: { addListener: () => {} } },
  };
  const swPreamble =
    ["prayer.js", "prayer-hadiths.js", "sync-core.js", "data.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n") + "\n";
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
  const marks = store.prayer.notified[key] || [];
  A(marks.filter((m) => !m.includes(":")).join() === "Fajr,Dhuhr,Asr",
    "they are still recorded so they can't fire later");
  //! Dhuhr's waqt ended at Asr, hours ago — its expiry warnings must be recorded silently too,
  //! or they fire the moment the machine wakes up.
  A(marks.includes("Dhuhr:30") && marks.includes("Dhuhr:15"),
    "expiry warnings for a waqt long gone are silenced and recorded, not fired");

  // Now put one prayer inside the grace window and re-run.
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  store.prayer = { ...store.prayer, days: { [key]: { ...store.prayer.days[key], Maghrib: hhmm } }, notified: {} };
  notes.length = 0;
  listeners.alarm.forEach((f) => f({ name: "prayerTick" }));
  await sleep(30);
  A(notes.length === 1 && notes[0].title === "মাগরিবের ওয়াক্ত হয়েছে", "a prayer that is due right now fires exactly one notification");
  const shown = ctx.prayerReminderAt(0);

  A(notes[0].message === `${shown.text}\n— ${shown.source}`,
    "the notification carries the whole hadith and its source, not a truncated one");

  //* Expiry warning: Maghrib 25 minutes out puts Asr's end (Maghrib - 10) exactly 15 away.
  const soon = (mins) => {
    const d = new Date(now.getTime() + mins * 60000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  store.prayer = {
    ...store.prayer,
    days: { [key]: { ...store.prayer.days[key], Asr: "00:03", Maghrib: soon(25), Isha: soon(60) } },
    notified: {},
  };
  notes.length = 0;
  listeners.alarm.forEach((f) => f({ name: "prayerTick" }));
  await sleep(30);
  const warn = notes.filter((n) => n.id.startsWith("prayer-end-"));
  A(warn.length === 1, "one expiry warning fires, not one per lead");
  A(warn[0].id.endsWith("Asr:15"), "the 15-minute lead fires; the 30-minute one is already stale");
  A(warn[0].title === "আসরের ওয়াক্ত শেষ হয়ে আসছে", "the warning names the prayer in Bengali");
  A(warn[0].message.startsWith("আর ১৫ মিনিট বাকি"), "it counts the real minutes left, in Bengali digits");
  A(!warn[0].message.includes("—"), "a hurry-up alert carries no hadith");
  notes.length = 0;
  listeners.alarm.forEach((f) => f({ name: "prayerTick" }));
  await sleep(30);
  A(notes.filter((n) => n.id.startsWith("prayer-end-")).length === 0,
    "the same warning does not fire again on the next tick");

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

// ============================================================
// HARNESS 11 — day rollover: future-day migration + stale-window adoption,
// and a stale window's write applied to fresh storage (TTData.withData).
// ============================================================
// Regression tests for two bugs traced from the same root cause (no
// re-read-before-write on `entries`, unlike patchHistoryDay which already
// merges): (1) confirmCopyTo() stashes a future date's entries under
// S.history[thatDate] -- the ONLY way a future date gets entries, since
// day-nav caps at S.date -- and the day-rollover in init() used to just
// reset S.entries to [], leaving that data orphaned in history forever;
// (2) a second stale window (popup + tab.html, or two tab.html windows)
// blindly overwrote `entries` in storage, silently erasing the other
// window's adds/edits.
async function harness11() {
  console.log("\n== Harness 11: day rollover + live-entries merge-on-write ==");
  const store = {};
  const chromeMock = {
    storage: { local: {
      get: async (k) => (k === null ? { ...store } : Object.fromEntries((Array.isArray(k) ? k : [k]).map((x) => [x, store[x]]))),
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

  // --- Part A: a "Copy to" future date must migrate into S.entries once it arrives ---
  store.date = "2026-09-14";
  store.entries = [];
  store.history = { "2026-09-15": [{ id: "c1", project: "ZuPOS", category: "Development", description: "copied", accSec: 0 }] };
  win.S.date = "2026-09-14";
  win.S.entries = [];
  win.S.history = { "2026-09-15": store.history["2026-09-15"] };
  win.S.timer = { activeId: null, startedAt: null };
  const realTodayStr = win.todayStr;
  win.todayStr = () => "2026-09-15";
  const rolledA = await win.rollDayIfNeeded();
  A(rolledA === true, "rollDayIfNeeded reports it rolled");
  A(store.entries.length === 1 && store.entries[0].id === "c1", "a future-dated copy migrates into live entries once its date arrives");
  A(!store.history["2026-09-15"], "the migrated day is removed from history, not left duplicated");
  A(store.date === "2026-09-15", "date advances to the arrived day");

  // A day with nothing pre-stashed still resets to empty, same as before.
  win.todayStr = () => "2026-09-16";
  const rolledA2 = await win.rollDayIfNeeded();
  A(rolledA2 === true && store.entries.length === 0, "a day with no future-dated stash just resets to empty, as before");

  // No-op on the common case (S.date already == today).
  const rolledNoop = await win.rollDayIfNeeded();
  A(rolledNoop === false, "rollDayIfNeeded is a no-op once S.date already matches today");

  // --- Part B: another context already rolled over (and added) -- adopt it, don't reset to empty ---
  store.date = "2026-09-17";
  store.entries = [{ id: "other-context-add", project: "VSB", category: "Development", description: "added elsewhere", accSec: 60 }];
  store.timer = { activeId: null, startedAt: null };
  win.S.date = "2026-09-16"; // this context's stale in-memory view, one day behind
  win.S.entries = [];
  win.S.history = {};
  win.todayStr = () => "2026-09-17";
  const rolledB = await win.rollDayIfNeeded();
  A(rolledB === true, "rollDayIfNeeded rolls this stale context forward too");
  A(store.entries.length === 1 && store.entries[0].id === "other-context-add",
    "adopts the other context's already-live entries instead of blowing them away with an empty reset");
  win.todayStr = realTodayStr;

  // --- Part C: a stale window's change is applied to fresh storage, not its own old copy ---
  win.todayStr = () => "2026-09-20";
  store.date = "2026-09-20";
  store.entries = [
    { id: "e1", project: "ZuPOS", category: "Development", description: "one", accSec: 100 },
    { id: "e2", project: "ZuPOS", category: "Development", description: "two", accSec: 200 },
  ];
  store.deletedEntries = {};
  win.viewDate = "2026-09-20";
  win.S.entries = [store.entries[0]]; // stale cache missing e2
  await win.mutate((d) => { d.days["2026-09-20"].push({ id: "e3", project: "ZuPOS", category: "Development", description: "three", accSec: 300 }); });
  A(store.entries.map((e) => e.id).sort().join(",") === "e1,e2,e3",
    "a stale window's add keeps the OTHER window's entry (e2) and still adds its own (e3)");
  win.S.confirmBeforeDelete = false;
  await win.deleteEntry("e3");
  A(!store.entries.some((e) => e.id === "e3"), "a delete removes the entry from storage");
  A("e3" in store.deletedEntries, "the tombstone is persisted");
  win.todayStr = realTodayStr;

  dom.window.close();
}

// ============================================================
// HARNESS 12 — day rollover self-heals a window left open across midnight,
// without requiring a manual close/reopen (checkDayRollover via
// visibilitychange), and without yanking a deliberately-browsed past day.
// ============================================================
async function harness12() {
  console.log("\n== Harness 12: live self-heal on visibilitychange ==");
  const store = {};
  const chromeMock = {
    storage: { local: {
      get: async (k) => (k === null ? { ...store } : Object.fromEntries((Array.isArray(k) ? k : [k]).map((x) => [x, store[x]]))),
      set: async (obj) => { Object.assign(store, obj); },
    } },
  };
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/" });
  const win = dom.window;
  win.chrome = chromeMock;
  win.matchMedia = () => ({ matches: false });
  win.fetch = async () => ({ text: async () => "" });
  win.crypto = { randomUUID: () => "id-h12" };
  const s = win.document.createElement("script");
  s.textContent = jsSrc;
  win.document.body.appendChild(s);

  store.name = "Debjit Paul";
  store.date = "2026-09-20";
  store.entries = [{ id: "e1", project: "ZuPOS", category: "Development", description: "yesterday's task", accSec: 3600 }];
  store.timer = { activeId: null, startedAt: null };
  win.todayStr = () => "2026-09-20"; // freeze "today" for the initial load itself
  win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  await sleep(50);

  const $ = (id) => win.document.getElementById(id);
  A($("whoDate").textContent === "2026-09-20", "loads showing the day it was opened on");

  // Simulate the wall clock moving on while the tab just sits open (no
  // setInterval tick in this test — the visibilitychange path must be
  // independently sufficient, since Chrome throttles timers in hidden tabs).
  win.todayStr = () => "2026-09-21";
  Object.defineProperty(win.document, "hidden", { value: false, configurable: true });
  win.document.dispatchEvent(new win.Event("visibilitychange"));
  await sleep(30);

  A(store.date === "2026-09-21", "storage rolls to the new day on visibilitychange, no manual reopen needed");
  A(store.history["2026-09-20"] && store.history["2026-09-20"][0].id === "e1", "yesterday's entry is archived, not dropped");
  A($("whoDate").textContent === "2026-09-21", "the open window's own view updates live to the new day");
  A(store.entries.length === 0, "today starts empty (nothing was stashed for it)");

  // A user deliberately browsing a past day must not get yanked back to
  // "today" by this background check.
  win.setViewDate("2026-09-10");
  await sleep(20);
  win.todayStr = () => "2026-09-22";
  win.document.dispatchEvent(new win.Event("visibilitychange"));
  await sleep(30);
  A(store.date === "2026-09-22", "the day still rolls over in the background while browsing history");
  A(win.viewDate === "2026-09-10", "browsing a past day is not yanked back to 'today' by the background check");

  dom.window.close();
}

// ============================================================
// Shared helpers for the sync v2 harnesses: a shared-storage mock (structured-clone semantics),
// a Web Locks mock shared by one device's windows, and an in-memory Google Drive.
// ============================================================
function makeSharedStorageMock(store) {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    get: async (k) => (k === null ? clone(store) : Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in store).map((x) => [x, clone(store[x])]))),
    set: async (obj) => { Object.assign(store, clone(obj)); },
  };
}
function makeLocks() {
  const chains = {};
  return {
    request: (name, fn) => {
      const run = (chains[name] || Promise.resolve()).then(() => fn());
      chains[name] = run.then(() => {}, () => {});
      return run;
    },
  };
}
function makeDataContext(store, locks, htmlSrc) {
  const dom = new JSDOM(htmlSrc || html, { runScripts: "dangerously", url: "https://localhost/" });
  const win = dom.window;
  win.chrome = { identity: {}, runtime: {}, storage: { local: makeSharedStorageMock(store) } };
  win.matchMedia = () => ({ matches: false });
  if (locks) Object.defineProperty(win.navigator, "locks", { value: locks });
  win.document.addEventListener = () => {}; // keep init()/route() out of it — see harness8
  const scripts = htmlSrc ? [jsSrc, "gdrive.js", "tab.js"] : [jsSrc, "gdrive.js"];
  for (const src of scripts) {
    const el = win.document.createElement("script");
    el.textContent = src === jsSrc ? jsSrc : fs.readFileSync(path.join(ROOT, src), "utf8");
    win.document.body.appendChild(el);
  }
  // Stub AFTER the scripts evaluate — gdrive.js's own declarations would clobber earlier stubs.
  win.gdToken = async () => "faketoken";
  win.pushIngest = async () => {};
  win.S = { entries: [], history: {}, timer: { activeId: null, startedAt: null }, submittedDays: {}, deletedEntries: {} };
  win.viewDate = win.todayStr();
  return win;
}
// In-memory Drive v3 covering exactly the calls sync-core.js makes. hooks.onDownload(file, who)
// can block to interleave two devices; files carry parents so duplicate folders can be tested.
function makeDrive(hooks) {
  let files = [];
  let n = 0;
  const now = () => new Date(Date.now() + n).toISOString();
  const parseMultipart = (body) => {
    const chunks = body.split(/--ttb[0-9a-f]+/).map((c) => c.trim()).filter((c) => c && c !== "--");
    const meta = JSON.parse(chunks[0].slice(chunks[0].indexOf("{")));
    const content = chunks[1].slice(chunks[1].indexOf("{"), chunks[1].lastIndexOf("}") + 1);
    return { meta, content };
  };
  const ok = (body) => ({ ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body });
  const fetchFor = (who) => async (url, opts) => {
    opts = opts || {};
    const u = new URL(url);
    if (u.pathname === "/drive/v3/files" && (!opts.method || opts.method === "GET")) {
      const q = u.searchParams.get("q") || "";
      const nameMatch = q.match(/name='([^']*)'/);
      const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
      const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]);
      const list = files.filter((f) => !!f.isFolder === wantFolder && !f.trashed &&
        (!nameMatch || f.name === nameMatch[1]) && (!parents.length || parents.includes(f.parent)));
      return ok({ files: list.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, createdTime: f.createdTime })) });
    }
    if (u.pathname === "/drive/v3/files" && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      const f = { id: "fo" + ++n, name: body.name, isFolder: true, createdTime: now(), modifiedTime: now() };
      files.push(f);
      return ok({ id: f.id });
    }
    if (u.pathname === "/upload/drive/v3/files" && opts.method === "POST") {
      const { meta, content } = parseMultipart(opts.body);
      const f = { id: "f" + ++n, name: meta.name, parent: meta.parents[0], content, createdTime: now(), modifiedTime: now() };
      files.push(f);
      return ok({ id: f.id, name: f.name });
    }
    const upd = u.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/);
    if (upd && opts.method === "PATCH") {
      const f = files.find((x) => x.id === upd[1]);
      f.content = opts.body; f.modifiedTime = now(); n++;
      return ok({ id: f.id, name: f.name });
    }
    const dl = u.pathname.match(/^\/drive\/v3\/files\/(.+)$/);
    if (dl && u.searchParams.get("alt") === "media") {
      const f = files.find((x) => x.id === dl[1]);
      const text = f ? f.content : "";
      if (hooks && hooks.onDownload) await hooks.onDownload(f, who);
      return ok(text);
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };
  return {
    fetchFor,
    files: () => files,
    byName: (name) => files.find((f) => f.name === name),
    put: (f) => files.push({ createdTime: now(), modifiedTime: now(), ...f }),
    json: (name) => JSON.parse(files.find((f) => f.name === name).content),
  };
}
// One "device" = one storage + one window with popup.js + gdrive.js, talking to the shared Drive.
function makeDevice(drive, name, entries) {
  const store = { name: "Tester", date: undefined, entries: [], history: {}, submittedDays: {}, deletedEntries: {}, timer: { activeId: null, startedAt: null } };
  const w = makeDataContext(store, makeLocks());
  store.date = w.todayStr();
  store.entries = (entries || []).map((e) => ({ project: "P", category: "C", accSec: 60, ...e }));
  w.fetch = drive.fetchFor(name);
  return { store, w, name, today: store.date, ids: () => store.entries.map((e) => e.id).sort().join(",") };
}

// ============================================================
// HARNESS 13 — dated backups: skipped when nothing changed, never empty
// ============================================================
async function harness13() {
  console.log("\n== Harness 13: dated Drive backups ==");
  const drive = makeDrive();
  const dev = makeDevice(drive, "A", [{ id: "e1", description: "one", accSec: 3600 }]);
  const dated = () => drive.files().filter((f) => /^timesheet-\d/.test(f.name));
  A((await dev.w.gdBackupNow(true)) === true && dated().length === 1, "first backup with real data writes one dated snapshot");
  A((await dev.w.gdBackupNow(true)) === false && dated().length === 1, "backing up again with nothing changed is skipped");
  await dev.w.mutate((d) => { dev.w.TTData.list(d, d.date).push({ id: "e2", description: "two" }); });
  A((await dev.w.gdBackupNow(true)) === true, "a real change after a skip is backed up");
  const latest = dated().sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))[0];
  A(JSON.parse(latest.content).days[dev.today].some((e) => e.id === "e2"), "the newest snapshot holds the change");
  A(/-[0-9a-f-]{6}\.json$/.test(latest.name), "snapshot names carry a device suffix, so two devices never collide on a name");
  const empty = makeDevice(makeDrive(), "E", []);
  let threw = false;
  try { await empty.w.gdBackupNow(true); } catch (e) { threw = true; }
  A(threw, "an empty device never writes an empty snapshot");
  dev.w.close(); empty.w.close();
}

// ============================================================
// HARNESS 14 — issue #2 end to end: several devices, one Drive, adversarial timing.
// Each case failed on the pre-v2 code (reproduced before the fix).
// ============================================================
async function harness14() {
  console.log("\n== Harness 14: multi-device sync (issue #2) ==");
  // 1. An entry added while this device's own sync is waiting on the network survives, and reaches Drive.
  {
    const drive = makeDrive();
    const b = makeDevice(drive, "B", [{ id: "fromB" }]);
    await b.w.gdSync(false);
    const a = makeDevice(drive, "A", [{ id: "a1" }]);
    const aw2 = makeDataContext(a.store, null); // a second window on device A
    let added = false;
    const base = drive.fetchFor("A");
    a.w.fetch = async (url, opts) => {
      const r = await base(url, opts);
      if (!added && url.includes("alt=media")) {
        added = true;
        await aw2.mutate((d) => { aw2.TTData.list(d, d.date).push({ id: "addedDuringSync", description: "typed mid-sync" }); });
      }
      return r;
    };
    await a.w.gdSync(false);
    A(a.store.entries.some((e) => e.id === "addedDuringSync"), "an entry added while a sync is in flight is still there afterwards");
    await a.w.gdSync(false);
    const devFile = drive.files().find((f) => f.name.startsWith("device-") && JSON.parse(f.content).deviceId === a.store.deviceId);
    A(devFile && JSON.parse(devFile.content).days[a.today].some((e) => e.id === "addedDuringSync"), "...and it reaches Drive on the next sync");
    A(a.store.entries.some((e) => e.id === "fromB"), "the other device's entry is merged in too");
    aw2.close(); a.w.close(); b.w.close();
  }
  // 2. Two devices syncing at the same instant: nobody's data is lost on Drive.
  {
    const drive = makeDrive();
    const seed = makeDevice(drive, "S", [{ id: "seed" }]);
    await seed.w.gdSync(false);
    let release; const gate = new Promise((r) => (release = r)); let waiting = 0;
    drive.fetchFor = ((orig) => orig)(drive.fetchFor);
    const a = makeDevice(drive, "A", [{ id: "onlyA" }]);
    const b = makeDevice(drive, "B", [{ id: "onlyB" }]);
    const hold = (dev) => { const f = dev.w.fetch; dev.w.fetch = async (u, o) => { const r = await f(u, o); if (u.includes("alt=media") && waiting < 2) { if (++waiting === 2) release(); await gate; } return r; }; };
    hold(a); hold(b);
    await Promise.all([a.w.gdSync(false), b.w.gdSync(false)]);
    const c = makeDevice(drive, "C", []);
    await c.w.gdSync(false);
    A(c.ids() === "onlyA,onlyB,seed", "a fresh device sees both devices' entries after they synced at the same instant (" + c.ids() + ")");
    await a.w.gdSync(false); await b.w.gdSync(false);
    A(a.ids() === "onlyA,onlyB,seed" && b.ids() === a.ids(), "both racing devices converge to the same data");
    seed.w.close(); a.w.close(); b.w.close(); c.w.close();
  }
  // 3. A newer edit on one device wins over another device's stale copy, and everyone converges.
  {
    const drive = makeDrive();
    const a = makeDevice(drive, "A", [{ id: "t1", description: "old text" }]);
    await a.w.gdSync(false);
    const b = makeDevice(drive, "B", []);
    await b.w.gdSync(false);
    A(b.store.entries[0].description === "old text", "sanity: device B pulled the entry");
    await a.w.mutate((d) => { const e = a.w.TTData.find(d, d.date, "t1"); e.description = "new text"; a.w.TTCore.touch(d, e); });
    await a.w.gdSync(false);
    await b.w.gdSync(false); // B syncs with its now-stale copy
    await a.w.gdSync(false);
    A(a.store.entries[0].description === "new text" && b.store.entries[0].description === "new text", "the newer edit wins on both devices (no revert, no divergence)");
    a.w.close(); b.w.close();
  }
  // 4. Delete → restore via the picker brings the task back everywhere, and it stays back.
  {
    const drive = makeDrive();
    const a = makeDevice(drive, "A", [{ id: "keep" }, { id: "lost", description: "deleted by mistake" }]);
    await a.w.gdSync(false);
    const b = makeDevice(drive, "B", []);
    await b.w.gdSync(false);
    const backup = JSON.parse(drive.byName(drive.files().find((f) => f.name.startsWith("device-")).name).content);
    a.w.S.confirmBeforeDelete = false; a.w.viewDate = a.today;
    await a.w.deleteEntry("lost");
    await a.w.gdSync(false); await b.w.gdSync(false);
    A(!b.store.entries.some((e) => e.id === "lost"), "sanity: the delete reached device B");
    const cands = a.w.TTCore.restoreCandidates(a.w.TTCore.stateOf(a.w.TTData.toDoc(a.store)), backup);
    A(cands.length === 1 && cands[0].entry.id === "lost", "the restore picker offers exactly the deleted task");
    await a.w.mutate((d) => { a.w.TTCore.applyRestore(d, d.days, cands); });
    await a.w.gdSync(false); await b.w.gdSync(false); await a.w.gdSync(false);
    A(a.store.entries.some((e) => e.id === "lost") && b.store.entries.some((e) => e.id === "lost"), "the restored task is back on both devices after syncing (the tombstone no longer wins)");
    a.w.close(); b.w.close();
  }
  // 5. Reset on one device propagates as deletes, and a recovery point can bring things back.
  {
    const drive = makeDrive();
    const a = makeDevice(drive, "A", [{ id: "r1" }, { id: "r2" }]);
    await a.w.gdSync(false);
    const b = makeDevice(drive, "B", []);
    await b.w.gdSync(false);
    await a.w.mutate((d) => { for (const l of Object.values(d.days)) for (const e of l) a.w.TTCore.tombstone(d, e.id); d.days = {}; });
    await a.w.gdSync(false); await b.w.gdSync(false);
    A(b.store.entries.length === 0, "a reset on one device removes the tasks on the other device too");
    const rp = b.store.recoveryPoints && b.store.recoveryPoints[b.store.recoveryPoints.length - 1];
    A(rp && a.w.TTCore.counts(rp.env).entries === 2, "the device that lost tasks to a sync kept a recovery point first");
    const log = b.store.ttLog || [];
    A(log.filter((e) => e.type === "removed").length === 2 && log.some((e) => e.type === "removed" && /deleted on Chrome extension/.test(e.reason)),
      "the activity log records each removed task and which device deleted it");
    a.w.close(); b.w.close();
  }
  // 6. A corrupt file on Drive is skipped and logged, never treated as "empty".
  {
    const drive = makeDrive();
    const a = makeDevice(drive, "A", [{ id: "k" }]);
    await a.w.gdSync(false);
    const folder = drive.files().find((f) => f.isFolder).id;
    drive.put({ id: "bad1", name: "device-broken.json", parent: folder, content: "{ not json" });
    await a.w.gdSync(false);
    A(a.store.entries.some((e) => e.id === "k"), "a corrupt device file does not remove anything");
    A((a.store.ttLog || []).some((e) => e.type === "sync-bad-file" && e.file === "device-broken.json"), "the corrupt file is named in the activity log");
    a.w.close();
  }
  // 7. Two "Team Timesheet Backups" folders (two devices connected at once): data from both is read.
  {
    const drive = makeDrive();
    const env = (id) => JSON.stringify({ app: "team-timesheet", v: 2, deviceId: id, days: { "2026-01-05": [{ id: "in-" + id, updatedAt: 5, updatedBy: id }] } });
    drive.put({ id: "F1", name: "Team Timesheet Backups", isFolder: true });
    drive.put({ id: "F2", name: "Team Timesheet Backups", isFolder: true });
    drive.put({ id: "d1", name: "device-x.json", parent: "F1", content: env("x") });
    drive.put({ id: "d2", name: "device-y.json", parent: "F2", content: env("y") });
    const a = makeDevice(drive, "A", []);
    await a.w.gdSync(false);
    const hist = a.store.history["2026-01-05"] || [];
    A(hist.some((e) => e.id === "in-x") && hist.some((e) => e.id === "in-y"), "entries in both duplicate folders are merged");
    a.w.close();
  }
  // 8. Old-version client: its latest.json is read (nothing it adds is lost), and it is flagged.
  {
    const drive = makeDrive();
    const a = makeDevice(drive, "A", [{ id: "v2task" }]);
    await a.w.gdSync(false);
    const mirror = drive.json("timesheet-latest.json");
    A(mirror.days[a.today].some((e) => e.id === "v2task"), "the compatibility timesheet-latest.json is kept up to date for old clients");
    const f = drive.byName("timesheet-latest.json");
    const old = { app: "team-timesheet", v: 1, exportedAt: Date.now() + 5000, days: { ...mirror.days, [a.today]: [...mirror.days[a.today], { id: "fromOldClient", description: "old app" }] } };
    f.content = JSON.stringify(old);
    await a.w.gdSync(false);
    A(a.store.entries.some((e) => e.id === "fromOldClient"), "an entry written by an old-version client is merged in");
    A(!!a.store.gdLegacyClientAt, "an old-version client writing to Drive is detected (Settings warns to update it)");
    a.w.close();
  }
  // 8b. The mirror already matches on this device's first v2 sync (nothing to write) — an old
  //     client writing afterwards must still be detected.
  {
    const drive = makeDrive();
    const a = makeDevice(drive, "A", [{ id: "same" }]);
    const legacy = { app: "team-timesheet", v: 1, exportedAt: Date.now() - 60000, days: { [a.today]: [{ id: "same", project: "P", category: "C", description: "", accSec: 60 }] } };
    drive.put({ id: "F0", name: "Team Timesheet Backups", isFolder: true });
    drive.put({ id: "L0", name: "timesheet-latest.json", parent: "F0", content: JSON.stringify(legacy) });
    await a.w.gdSync(false);
    A(!a.store.gdLegacyClientAt, "a pre-existing old-format mirror is not itself flagged");
    const f = drive.byName("timesheet-latest.json");
    f.content = JSON.stringify({ ...legacy, exportedAt: Date.now() + 5000, days: { [a.today]: [...legacy.days[a.today], { id: "oldAppAdd" }] } });
    await a.w.gdSync(false);
    A(!!a.store.gdLegacyClientAt && a.store.entries.some((e) => e.id === "oldAppAdd"), "a later write by an old client is flagged and its entry merged");
    a.w.close();
  }
  // 8c. Popup and full view on the SAME device both start a sync at once (shared Web Lock).
  {
    const drive = makeDrive();
    const locks = makeLocks();
    const store = { name: "T", entries: [], history: {}, submittedDays: {}, deletedEntries: {}, timer: { activeId: null, startedAt: null } };
    const w1 = makeDataContext(store, locks), w2 = makeDataContext(store, locks);
    store.date = w1.todayStr();
    w1.fetch = drive.fetchFor("A"); w2.fetch = drive.fetchFor("A");
    await w1.mutate((d) => { w1.TTData.list(d, d.date).push({ id: "p1" }); });
    await Promise.all([w1.gdSync(false), w2.gdSync(false), w2.mutate((d) => { w2.TTData.list(d, d.date).push({ id: "p2" }); })]);
    await w1.gdSync(false);
    const own = drive.files().filter((f) => f.name === `device-${store.deviceId}.json`);
    A(own.length === 1, "two windows syncing at once still write exactly one device file");
    A(["p1", "p2"].every((id) => JSON.parse(own[0].content).days[store.date].some((e) => e.id === id)), "and it holds both windows' entries");
    w1.close(); w2.close();
  }
  // 9. Concurrent timers on the same task (decision: last fold wins, conflict is logged).
  {
    const drive = makeDrive();
    const a = makeDevice(drive, "A", [{ id: "run", accSec: 0 }]);
    await a.w.gdSync(false);
    const b = makeDevice(drive, "B", []);
    await b.w.gdSync(false);
    await a.w.mutate((d) => { d.timer = { activeId: "run", startedAt: Date.now() - 60000 }; });
    await b.w.mutate((d) => { const e = b.w.TTData.find(d, d.date, "run"); e.accSec = 600; b.w.TTCore.touch(d, e); });
    await b.w.gdSync(false); await a.w.gdSync(false);
    A((a.store.ttLog || []).some((e) => e.type === "timer-conflict"), "a remote change to a task whose timer runs here is logged as a conflict");
    A(a.store.timer.activeId === "run", "the local timer keeps running on the updated task");
    a.w.close(); b.w.close();
  }
}

// ============================================================
// HARNESS 15 — full-view restore picker (✓ / ✗ per task) + recovery list + activity log
// ============================================================
async function harness15() {
  console.log("\n== Harness 15: restore picker UI ==");
  const tabHtml = fs.readFileSync(path.join(ROOT, "tab.html"), "utf8");
  const store = { name: "Tester", entries: [], history: {}, submittedDays: {}, deletedEntries: {}, timer: { activeId: null, startedAt: null } };
  const w = makeDataContext(store, makeLocks(), tabHtml);
  store.date = w.todayStr();
  store.entries = [{ id: "here", project: "P", category: "C", description: "already here", accSec: 60 }];
  w.S = await w.chrome.storage.local.get(null);
  const backup = { app: "team-timesheet", v: 1, days: { [store.date]: [
    { id: "here", project: "P", category: "C", description: "already here", accSec: 60 },
    { id: "m1", project: "ZuPOS", category: "Development", description: "missing one", accSec: 3600 },
    { id: "m2", project: "VSB", category: "Meeting (General)", description: "missing two", accSec: 1800 },
  ] } };
  const $ = (id) => w.document.getElementById(id);
  const pending = w.openRestorePicker(backup, "test backup");
  await sleep(10);
  const rows = [...w.document.querySelectorAll("#restoreList .rRow")];
  A(!$("restoreOverlay").classList.contains("hidden") && rows.length === 2, "the picker lists only the two missing tasks");
  A(rows[0].querySelector(".rTime").textContent === "01:00" && rows[0].textContent.includes("missing one"), "each row shows the task and its time");
  rows[0].querySelector(".rYes").click();
  w.document.querySelectorAll("#restoreList .rRow")[1].querySelector(".rNo").click();
  A($("restoreApply").textContent === "Add 1 task(s)", "the apply button counts only ✓ tasks");
  await w.applyRestorePick(); // DOMContentLoaded wiring is neutered in these harnesses
  const res = await pending;
  A(res.added === 1 && store.entries.some((e) => e.id === "m1") && !store.entries.some((e) => e.id === "m2"), "✓ adds the task, ✗ leaves it out");
  A(store.entries.some((e) => e.id === "here"), "nothing already present is removed or replaced");
  A((store.recoveryPoints || []).length === 1, "a recovery point is saved before the restore");
  const again = w.openRestorePicker(backup, "test backup");
  await sleep(5);
  A(w.document.querySelectorAll("#restoreList .rRow").length === 1, "reopening offers only what's still missing (m2)");
  w.closeRestorePicker({ cancelled: true });
  await again;
  const cancelled = w.openRestorePicker({ days: { [store.date]: [{ id: "zz", description: "x" }] } }, "x");
  await sleep(5);
  w.closeRestorePicker({ cancelled: true });
  A((await cancelled).cancelled && !store.entries.some((e) => e.id === "zz"), "Cancel adds nothing");
  w.S = await w.chrome.storage.local.get(null);
  w.renderActivityLog();
  A($("activityLog").textContent.includes("restore") && $("activityLog").textContent.includes("missing one"), "the activity log shows the restore and the task it added");
  w.renderRecovery();
  A(w.document.querySelectorAll("#recoveryList .gdFile").length === 1, "the recovery point is listed in Settings");
  w.close();
}

// ============================================================
// HARNESS 16 — the service worker records the form tab's "submitted" mark
// (the Fillout page can't take the data lock) and ignores junk messages.
// ============================================================
async function harness16() {
  console.log("\n== Harness 16: service-worker submitted mark ==");
  const store = { date: "2026-09-27", entries: [{ id: "e1", project: "P", category: "C", description: "d", accSec: 60 }], history: {}, submittedDays: {} };
  let onMessage = null;
  const noop = () => {};
  const chromeMock = {
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
    storage: { local: makeSharedStorageMock(store), onChanged: { addListener: noop } },
    alarms: { create: noop, clear: noop, onAlarm: { addListener: noop } },
    notifications: { create: noop },
    runtime: { onInstalled: { addListener: noop }, onStartup: { addListener: noop }, onMessage: { addListener: (fn) => { onMessage = fn; } } },
  };
  const pre = ["prayer.js", "prayer-hadiths.js", "sync-core.js", "data.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n") + "\n";
  new Function("chrome", "importScripts", pre + fs.readFileSync(path.join(ROOT, "background.js"), "utf8"))(chromeMock, () => {});
  await sleep(20);
  A(typeof onMessage === "function", "the worker listens for the form tab's message");
  onMessage({ tt: "markSubmitted", date: "not-a-date" });
  onMessage({ tt: "somethingElse", date: "2026-09-26" });
  onMessage(null);
  await sleep(30);
  A(Object.keys(store.submittedDays).length === 0, "junk or unknown messages write nothing");
  onMessage({ tt: "markSubmitted", date: "2026-09-26", method: "auto" });
  await sleep(30);
  const info = store.submittedDays["2026-09-26"];
  A(info && info.method === "auto" && info.at > 0 && info.by === store.deviceId, "a real mark is stamped by this device");
  A((store.ttLog || []).some((e) => e.type === "mark-submitted" && e.via === "form tab"), "the mark is in the activity log");
  A(store.entries.length === 1 && store.entries[0].id === "e1", "marking does not disturb the day's entries");
}

//! A harness awaiting a promise that never settles lets Node exit early with code 0 and no summary
//! line — that must read as a failure, not a pass.
let finished = false;
process.on("exit", () => { if (!finished) { console.error("\nSMOKE: DID NOT FINISH (a harness hung)"); process.exitCode = 1; } });
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
  await harness11();
  await harness12();
  await harness13();
  await harness14();
  await harness15();
  await harness16();
  finished = true;
  console.log(fails === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${fails} FAILURE(S)`);
  process.exit(fails === 0 ? 0 : 1);
})();
