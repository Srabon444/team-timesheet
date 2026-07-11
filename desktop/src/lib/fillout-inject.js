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
  const fail = (msg) => report({ error: msg, added, addedIds });

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

    report({ done: true, added, addedIds });
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
  }
}

// entries: [{ id, project, category, description, hhmm }]
export function buildFillScript(entries, name) {
  return `(${runner.toString()})(${JSON.stringify(entries)}, ${JSON.stringify(name)});`;
}
