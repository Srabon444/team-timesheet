"use strict";
// Fillout form automation. Loaded by background.js (importScripts), which runs the fill, and by
// popup.html/tab.html, which only share FORM_URL and the injected helpers' names.
//! The fill used to run in the popup, and Chrome closes the popup the moment it loses focus (the
//! form tab activating, a click on the page). That killed the run mid-entry and left a half-filled
//! modal open. The service worker has no such lifetime, so the whole run lives here.

const FORM_URL = "https://techzu.fillout.com/t/uhz6TddCX2us";

// Injected into the form tab after a fill: watches for the "Thank you"
// completion screen and records a REAL submission (method "auto") — the
// popup may be closed by the time the user hits Submit, so this can't rely
// on it. Self-contained: no closure refs (executeScript serializes it).
//! It runs in the form page's world, which can't take the extension's data
//! lock, so the service worker does the write (background.js).
function watchForSubmit(date) {
  if (window.__ttSubmitWatch) return;
  window.__ttSubmitWatch = setInterval(() => {
    try {
      const txt = (document.body.innerText || "").toLowerCase();
      const createGone = ![...document.querySelectorAll("button,[role=button],a,div,span")]
        .some((n) => (n.textContent || "").trim() === "Create" && n.offsetParent !== null);
      if (txt.includes("thank you") && createGone) {
        clearInterval(window.__ttSubmitWatch);
        chrome.runtime.sendMessage({ tt: "markSubmitted", date, method: "auto" });
      }
    } catch (e) {}
  }, 1500);
}

async function ensureFormTab(name) {
  const existing = await chrome.tabs.query({ url: FORM_URL + "*" });
  let tab = existing[0];
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    tab = await chrome.tabs.create({ url: FORM_URL + "?name=" + encodeURIComponent(name), active: true });
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

// dateStr: "YYYY-MM-DD" -> the field displays/accepts DD/MM/YYYY. Confirmed
// live against the real form: the Date widget's own input has
// role=combobox + aria-label="Date" (same react-datepicker pattern as Name's
// react-select, just not a dropdown) — typing the display value + a
// synthetic Enter sets it, same technique as pageSelectName.
function pageSelectDate(dateStr) {
  const [y, m, d] = dateStr.split("-");
  const ddmmyyyy = `${d}/${m}/${y}`;
  const setNative = (el, val) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const input = document.querySelector('input[aria-label="Date"]');
  if (!input) return { error: "Date field not found" };
  if (input.value === ddmmyyyy) return { skipped: true };
  input.focus();
  setNative(input, ddmmyyyy);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  return new Promise((resolve) => {
    setTimeout(() => {
      // Focusing the field opened its calendar popup; Enter commits the
      // typed value but doesn't dismiss it (confirmed live) — close it
      // explicitly so it isn't still floating over the page afterward.
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      input.blur();
      resolve(input.value === ddmmyyyy ? { ok: true } : { error: `could not set date to "${ddmmyyyy}"` });
    }, 300);
  });
}

// Deletes every existing "Timesheet Entries" row for this Name+Date before
// filling, so re-running Final Submit (after locally adding/editing/
// removing entries) is a clean resync instead of appending on top of stale
// data. Ported from the desktop app's fillout-inject.js — the delete
// control's shape isn't documented anywhere, so instead of guessing it,
// this finds each row via its "Edit" text control and picks the LAST other
// clickable element sharing an ancestor with it (climbing a few levels
// since the row wrapper depth isn't fixed either) — reliably the delete "X"
// given the row's left-to-right layout. Confirmed live against this exact
// form, same technique already shipped in the desktop app.
async function pageClearExistingEntries() {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  const countRows = () =>
    [...document.querySelectorAll("a,button,[role=button]")]
      .filter((n) => /^edit$/i.test(norm(n.textContent)) && n.offsetParent !== null).length;
  const before = countRows();
  for (let i = 0; i < 60 && countRows() > 0; i++) {
    const editEl = [...document.querySelectorAll("a,button,[role=button]")]
      .find((n) => /^edit$/i.test(norm(n.textContent)) && n.offsetParent !== null);
    if (!editEl) break;
    let del = document.querySelector('button[aria-label*="delete" i],button[aria-label*="remove" i]');
    let scope = editEl.parentElement;
    for (let depth = 0; depth < 4 && scope && !del; depth++) {
      const candidates = [...scope.querySelectorAll("a,button,[role=button]")].filter(
        (n) =>
          n.offsetParent !== null &&
          n !== editEl &&
          !editEl.contains(n) &&
          !n.contains(editEl) &&
          !/^(edit|create|submit)$/i.test(norm(n.textContent))
      );
      if (candidates.length) del = candidates[candidates.length - 1];
      scope = scope.parentElement;
    }
    if (!del) break; // couldn't identify a delete control — stop rather than risk a wrong click
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => fire(del, t));
    await sleep(400);
    // Some UIs confirm destructive actions with a second click.
    const confirmBtn = [...document.querySelectorAll("button,[role=button]")].find(
      (n) => n.offsetParent !== null && /^(delete|confirm|yes|remove|ok)$/i.test(norm(n.textContent))
    );
    if (confirmBtn) ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => fire(confirmBtn, t));
    await sleep(400);
  }
  return { before, after: countRows() };
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
//! Ready means the Project dropdown has rendered too, not just the description input: typing into
//! a react-select that isn't mounted yet is silently dropped, and the entry fails with "could not
//! select". Kept separate from probeSubform, which also detects the modal closing, where the
//! Project placeholder is already gone once a value is picked.
function probeSubformReady() {
  return !!document.querySelector('input[placeholder="Task Description"]') &&
    [...document.querySelectorAll(".react-select__placeholder")].some((e) => e.textContent.trim() === "Select Project");
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
    //! A frame mid-navigation makes the whole allFrames call reject; that is a retry, not a failed run.
    const results = await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, func: probeSubformReady })
      .catch(() => []);
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
async function fillFormOnPage(tabId, entries, name, date) {
  let added = 0;
  try {
    const [nameRes] = await chrome.scripting.executeScript({ target: { tabId }, func: pageSelectName, args: [name] });
    if (nameRes.result && nameRes.result.error) throw new Error(nameRes.result.error);

    const [dateRes] = await chrome.scripting.executeScript({ target: { tabId }, func: pageSelectDate, args: [date] });
    if (dateRes.result && dateRes.result.error) throw new Error(dateRes.result.error);

    const [clearRes] = await chrome.scripting.executeScript({ target: { tabId }, func: pageClearExistingEntries });
    const clearResult = clearRes && clearRes.result;
    const warning = clearResult && clearResult.after > 0
      ? `${clearResult.after} old entr${clearResult.after === 1 ? "y" : "ies"} could not be auto-cleared — remove manually.`
      : undefined;
    // The entries list does its own async refetch/re-render after each
    // delete (same race already handled below for the entries-list race
    // after a submit) — the LAST deletion's refresh can still be in flight
    // right as the loop below clicks Create for the first entry, landing
    // on a transitional node whose click silently does nothing.
    if (clearResult && clearResult.before > 0) await sleep(800);

    for (const e of entries) {
      const [createRes] = await chrome.scripting.executeScript({ target: { tabId }, func: pageClickCreate });
      if (createRes.result && createRes.result.error) throw new Error(createRes.result.error);

      let frameId = await waitForSubframe(tabId, 8000);
      if (frameId == null) {
        // Retry once — the first click may have landed on a stale node.
        // A fresh Create click recovers cleanly if that's what happened.
        const [retryRes] = await chrome.scripting.executeScript({ target: { tabId }, func: pageClickCreate });
        if (!(retryRes.result && retryRes.result.error)) {
          frameId = await waitForSubframe(tabId, 8000);
        }
      }
      if (frameId == null) throw new Error(`modal did not open for "${e.project}"`);

      const [fillRes] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: frameFillEntry,
        args: [e],
      });
      if (fillRes.result && fillRes.result.error) throw new Error(fillRes.result.error);

      //! A modal that stays open means the entry was NOT saved (a validation message, a slow
      //! save). Going on would fill the next entry into this same modal and count both as added.
      if (!(await waitForSubframeGone(tabId))) {
        throw new Error(`"${e.description}" did not save — its Create form is still open, check it for a message`);
      }
      await waitForEntryVisible(tabId, e.description);
      added++;
    }
    return { added, warning };
  } catch (err) {
    return { error: err.message, added };
  }
}

// ---------- run a whole fill (service worker) ----------
//* job = { date, name, entries: [{ id, project, category, description, hhmm }] }. Progress goes to
//* storage "fillStatus" so any window (or one opened later) shows it.
let fillRunning = false;
async function fillStatus(st) {
  await chrome.storage.local.set({ fillStatus: { ...st, at: Date.now() } });
}
async function startFill(job) {
  //! Clicking Final Submit again while a run is going used to start a second run on the same tab,
  //! which reloaded the form under the first one.
  if (fillRunning) return { busy: true };
  fillRunning = true;
  const { date, name, entries } = job;
  let out;
  try {
    await fillStatus({ date, running: true, text: "Opening form…" });
    const tabId = await ensureFormTab(name);
    await fillStatus({ date, running: true, text: `Filling ${entries.length} entr${entries.length === 1 ? "y" : "ies"}…` });
    out = (await fillFormOnPage(tabId, entries, name, date)) || {};
    // fillFormOnPage processes entries in order and stops at the first failure, so the first
    // `added` of them are the ones that went in.
    const added = out.added || 0;
    if (added > 0) {
      const sentIds = entries.slice(0, added).map((e) => e.id);
      await TTData.withData((d) => {
        for (const id of sentIds) {
          const e = TTData.find(d, date, id);
          if (e && !e.submitted) { e.submitted = true; TTCore.touch(d, e); }
        }
        TTData.log(d, [{ type: "filled-form", date, entries: sentIds.length }]);
      });
      // Dated Drive snapshot at the moment entries are marked submitted; skipped quietly when
      // Drive isn't connected.
      if (typeof gdBackupNow === "function") gdBackupNow(false).catch(() => {});
      // Leave a watcher in the form tab that marks the day submitted on the "Thank you" screen.
      try { await chrome.scripting.executeScript({ target: { tabId }, func: watchForSubmit, args: [date] }); } catch (e) {}
    }
    const text = out.error
      ? `Stopped: ${out.error} (${added} added)`
      : `Done — ${added} entries added.` + (out.warning ? ` ⚠ ${out.warning}` : "") + " Review & Submit manually.";
    out = { ...out, added, text, cls: out.error || out.warning ? "err" : "ok" };
  } catch (err) {
    out = { error: err.message, added: 0, text: "Error: " + err.message, cls: "err" };
  } finally {
    fillRunning = false;
  }
  await fillStatus({ date, running: false, text: out.text, cls: out.cls }).catch(() => {});
  //* The user is watching the form tab, not the extension, so a stop has to reach them there.
  if (out.error && chrome.notifications) {
    chrome.notifications.create("fill-stopped", {
      type: "basic", iconUrl: "icons/icon128.png", title: "Timesheet fill stopped", message: out.text,
    });
  }
  return out;
}
