// The auto-fill script injected into the Fillout window (top frame), ported
// from the Chrome extension's verified automation (pageFormReady,
// pageSelectName, pageClickCreate, frameFillEntry, entries-list race wait).
//
// Two structural changes vs the extension:
//
// 1. SAME-ORIGIN IFRAME, NOT FRAME IDS. The "Create" entry form is an iframe
//    on the same origin (techzu.fillout.com), so this top-frame script
//    reaches it directly via iframe.contentDocument — the extension only
//    needed chrome.scripting frameIds because content scripts are isolated
//    per frame. Cross-realm rule: value setters and Event constructors MUST
//    come from the iframe's own window (contentWindow.HTMLInputElement...),
//    not the parent's, or React inside the iframe won't see the changes.
//
// 2. PROGRESS VIA document.title. The injected script can't use Tauri IPC
//    (remote origin), so it reports "TT_STATE:{json}" through the window
//    title, which the Rust side polls and relays to the main window. A keep
//    interval re-asserts the title so the page's own title updates can't
//    swallow a report between polls.
async function runner(entries, name) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = (s) => {
    try {
      const str = "TT_STATE:" + JSON.stringify(s);
      document.title = str;
      if (window.__ttKeep) clearInterval(window.__ttKeep);
      window.__ttKeep = setInterval(() => { document.title = str; }, 500);
    } catch {}
  };
  // Visible on-page feedback — document.title changes aren't seen by the
  // user directly, only polled by the app, so completion/failure also gets
  // a banner inside the Fillout window itself.
  const banner = (text, ok) => {
    try {
      let el = document.getElementById("__tt_banner");
      if (!el) {
        el = document.createElement("div");
        el.id = "__tt_banner";
        el.style.cssText =
          "position:fixed;top:0;left:0;right:0;z-index:999999;padding:10px 16px;" +
          "font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;text-align:center;color:#fff;";
        document.body.appendChild(el);
      }
      el.style.background = ok ? "#16a34a" : "#dc2626";
      el.textContent = text;
    } catch {}
  };
  const waitFor = async (fn, t = 15000) => {
    const s0 = Date.now();
    while (Date.now() - s0 < t) {
      try { const v = fn(); if (v) return v; } catch {}
      await sleep(200);
    }
    return null;
  };
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  let added = 0;
  const addedIds = [];
  const fail = (msg) => {
    banner("✗ Stopped: " + msg, false);
    report({ error: msg, added, addedIds });
  };

  // Delete whatever is already in the top-level "Timesheet Entries" list for
  // this Name+Date before filling, so re-running Final Submit (e.g. after
  // closing the window mid-fill) is a clean resync instead of piling up
  // duplicates.
  //
  // The delete control's text/markup isn't known in advance, so instead of
  // guessing its shape, this finds each row via its "Edit" control and picks
  // the LAST other clickable element sharing an ancestor with it (climbing
  // up to a few levels, since the row wrapper depth isn't known either) —
  // that's reliably the delete "X" given the row's left-to-right layout.
  // If a confirm step appears after clicking delete, it's clicked too.
  // Returns how many entries were present before this ran, and how many
  // are left afterward, so a caller can surface a warning instead of
  // silently piling up duplicates when clearing doesn't fully work.
  const countEntryRows = () =>
    [...document.querySelectorAll("a,button,[role=button]")]
      .filter((n) => /^edit$/i.test(norm(n.textContent)) && n.offsetParent !== null).length;

  const clearExistingEntries = async () => {
    const before = countEntryRows();
    for (let i = 0; i < 60 && countEntryRows() > 0; i++) {
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
      for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
        del.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      }
      await sleep(400);
      // Some UIs confirm destructive actions with a second click.
      const confirmBtn = [...document.querySelectorAll("button,[role=button]")].find(
        (n) => n.offsetParent !== null && /^(delete|confirm|yes|remove|ok)$/i.test(norm(n.textContent))
      );
      if (confirmBtn) {
        for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
          confirmBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
        }
      }
      await sleep(400);
    }
    return { before, after: countEntryRows() };
  };

  // react-select: type the value into the combobox input, synthetic Enter.
  // Same as a human using its built-in search — verified against this exact
  // form with synthetic (untrusted) events. doc/win select the realm.
  const selectReact = async (doc, win, placeholder, value) => {
    const ph = [...doc.querySelectorAll(".react-select__placeholder")]
      .find((e) => norm(e.textContent) === placeholder && e.offsetParent !== null);
    if (!ph) throw new Error('dropdown "' + placeholder + '" not found');
    const control = ph.closest(".react-select__control");
    const input = control.querySelector("input[role=combobox]");
    input.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    input.focus();
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    await sleep(450);
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(350);
    const sv = control.querySelector(".react-select__single-value");
    if (!sv || norm(sv.textContent) !== value) {
      throw new Error('could not select "' + value + '" for "' + placeholder + '"');
    }
  };

  const findSubdoc = () => {
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const d = f.contentDocument;
        if (d && d.querySelector('input[placeholder="Task Description"]')) {
          return { doc: d, win: f.contentWindow };
        }
      } catch {}
    }
    return null;
  };

  try {
    // Immediate visible proof the script was injected and is running, so a
    // stuck window is distinguishable from "injection never happened".
    banner("⏳ Auto-fill starting… waiting for the form to load", true);
    report({ phase: "waiting-for-form", added });
    const ready = await waitFor(() => {
      const hasPh = [...document.querySelectorAll(".react-select__placeholder")]
        .some((e) => norm(e.textContent) === "Name" && e.offsetParent !== null);
      const hasSv = document.querySelectorAll(".react-select__single-value").length > 0;
      const hasCreate = [...document.querySelectorAll("button,[role=button],a,div,span")]
        .some((n) => norm(n.textContent) === "Create" && n.children.length === 0 && n.offsetParent !== null);
      return hasPh || hasSv || hasCreate;
    }, 25000);
    if (!ready) return fail("form never became ready");

    // Name: skip the dropdown dance if it already shows the right name.
    const already = [...document.querySelectorAll(".react-select__single-value")]
      .find((e) => norm(e.textContent) === name);
    if (!already) await selectReact(document, window, "Name", name);
    report({ phase: "name-selected", added });

    report({ phase: "clearing-entries", added });
    const clearResult = await clearExistingEntries();
    const clearWarning =
      clearResult.after > 0
        ? clearResult.after + " old entr" + (clearResult.after === 1 ? "y" : "ies") + " could not be auto-cleared — remove manually."
        : "";

    for (const e of entries) {
      const createBtn = await waitFor(() => {
        const all = [...document.querySelectorAll("button,[role=button],a,div,span")]
          .filter((n) => norm(n.textContent) === "Create" && n.children.length === 0 && n.offsetParent !== null);
        return all[0] || null;
      }, 12000);
      if (!createBtn) return fail('Create button not found for "' + e.project + '"');
      for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
        createBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      }

      const sub = await waitFor(findSubdoc, 15000);
      if (!sub) return fail('entry form did not open for "' + e.project + '"');
      await sleep(300);

      const setByPlaceholder = (placeholder, value) => {
        const inp = [...sub.doc.querySelectorAll("input,textarea")].find((i) => i.placeholder === placeholder);
        if (!inp) throw new Error('input "' + placeholder + '" not found');
        const proto = inp.tagName === "TEXTAREA"
          ? sub.win.HTMLTextAreaElement.prototype
          : sub.win.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(inp, value);
        inp.dispatchEvent(new sub.win.Event("input", { bubbles: true }));
        inp.dispatchEvent(new sub.win.Event("change", { bubbles: true }));
      };

      await selectReact(sub.doc, sub.win, "Select Project", e.project);
      await selectReact(sub.doc, sub.win, "Select Work Category", e.category);
      setByPlaceholder("Task Description", e.description);
      setByPlaceholder("Hours Clocked (hh:mm)", e.hhmm);
      await sleep(200);

      // The ONLY Submit ever clicked lives inside the entry-form iframe —
      // the main form's Submit is in the top document and is never touched.
      const submitBtn = [...sub.doc.querySelectorAll("button,[role=button]")]
        .find((b) => norm(b.textContent) === "Submit");
      if (!submitBtn) return fail("entry form Submit button not found");
      for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
        submitBtn.dispatchEvent(new sub.win.MouseEvent(t, { bubbles: true, cancelable: true }));
      }

      await waitFor(() => !findSubdoc(), 15000);
      // Entries-list refresh race (confirmed live on this form): the list
      // re-fetches after the subform closes; clicking Create again before
      // the new entry's text is visible can hit a dead transitional node.
      await waitFor(() => document.body.innerText.includes(e.description), 12000);
      await sleep(500);

      added++;
      addedIds.push(e.id);
      report({ phase: "progress", added, addedIds });
    }

    const doneMsg =
      "✓ Added " + added + " entr" + (added === 1 ? "y" : "ies") + ". Review them, then click the form's Submit yourself." +
      (clearWarning ? " ⚠ " + clearWarning : "");
    banner(doneMsg, !clearWarning);
    report({ done: true, added, addedIds, warning: clearWarning || undefined });

    // Task 7: after filling, keep watching for the user actually submitting
    // the form, so the app can record a REAL submission (not just that we
    // filled it). Best-effort heuristic — the manual "Mark submitted" toggle
    // in the app is the fallback when the form's success markup doesn't match.
    const looksSubmitted = () => {
      const txt = norm(document.body.innerText).toLowerCase();
      const successText = /(thank you|response (has been )?recorded|submission received|your response has|successfully submitted|form submitted|has been submitted)/.test(txt);
      const createGone = ![...document.querySelectorAll("button,[role=button],a,div,span")]
        .some((n) => norm(n.textContent) === "Create" && n.offsetParent !== null);
      const submitGone = ![...document.querySelectorAll("button,[role=button]")]
        .some((b) => norm(b.textContent) === "Submit" && b.offsetParent !== null);
      // Require the success text AND the form controls to be gone, so a stray
      // "thank you" elsewhere on the page can't trigger a false positive.
      return successText && createGone && submitGone;
    };
    if (window.__ttWatch) clearInterval(window.__ttWatch);
    window.__ttWatch = setInterval(() => {
      try {
        if (looksSubmitted()) {
          clearInterval(window.__ttWatch);
          banner("✓ Submission detected — recorded in the app.", true);
          report({ submittedConfirmed: true, added, addedIds });
        }
      } catch {}
    }, 1500);
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
  }
}

// entries: [{ id, project, category, description, hhmm }]
export function buildFillScript(entries, name) {
  return `(${runner.toString()})(${JSON.stringify(entries)}, ${JSON.stringify(name)});`;
}
