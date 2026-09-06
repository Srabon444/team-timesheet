<script>
  import { categoryColor, projectColor } from "../lib/constants.js";
  import { todayStr, secToHHMM, secToHHMMSS, secToHMM, hhmmToSec, stripDates, addDays, dayLabel, longDate } from "../lib/time.js";
  import { dayTotal, byCategory } from "../lib/stats.js";
  import {
    app, nav, save, showConfirm,
    startEntryTimer, pauseEntryTimer, removeEntry, addEntry,
    entryElapsed, activeEntry, submitToFillout,
    markDaySubmitted, unmarkDaySubmitted, daySubmitted,
    currentProjects, currentCategories,
  } from "../lib/store.svelte.js";
  import AddEntryModal from "../components/AddEntryModal.svelte";
  import CopyToModal from "../components/CopyToModal.svelte";
  import PrayerModal from "../components/PrayerModal.svelte";
  import SearchSelect from "../components/SearchSelect.svelte";
  import * as prayer from "../lib/prayer.js";
  import { prayerReminderAt } from "../lib/prayer-hadiths.js";

  let selected = $state(nav.jumpDate || todayStr());
  let anchor = $state(nav.jumpDate || todayStr()); // day-strip window end
  nav.jumpDate = null;
  let tab = $state("timesheet");
  let modal = $state(null); // { entry|null, presetProject?, presetCategory? }
  // Copy Tasks: checkbox-select entries on the viewed day, then copy them
  // (fresh, time reset to 0) into a same-or-future day.
  let copyMode = $state(false);
  let copySelected = $state(new Set());
  let copyModalOpen = $state(false);
  let copyStatus = $state("");
  // Quick-add menu opens on hover OR click. The menu sits flush under its
  // trigger (no gap) and is a DOM child of the hover region, so moving the
  // cursor into it never fires a leave — the old "vanishes when I reach for
  // it" bug. Click pins it open (survives mouse-leave) until click-away.
  let hovering = $state(false);
  let clicked = $state(false);
  let openProject = $state(null); // which project's category list is expanded
  const menuOpen = $derived(hovering || clicked);

  function enterMenu() { hovering = true; }
  function leaveMenu() { hovering = false; if (!clicked) openProject = null; }
  function toggleMenu() { clicked = !clicked; if (!clicked) openProject = null; }
  function closeMenu() { hovering = false; clicked = false; openProject = null; }
  function showCats(p) { openProject = p; } // hover or tap a project → its categories

  function openPreset(p, c) {
    selected = today;
    closeMenu();
    modal = { entry: null, presetProject: p, presetCategory: c };
  }

  const today = $derived(todayStr());
  const days = $derived(stripDates(anchor));
  const entries = $derived(app.data.days[selected] || []);
  const running = $derived(activeEntry());
  const selectedTotal = $derived(
    entries.reduce((s, e) => s + entryElapsed(e), 0)
  );
  const catTotals = $derived.by(() => {
    const map = byCategory({ [selected]: entries });
    // include live elapsed for the running entry
    if (running && app.data.timer.date === selected) {
      map[running.category] = (map[running.category] || 0) + (entryElapsed(running) - (running.accSec || 0));
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  });
  const selSubmitted = $derived(daySubmitted(selected));

  //* Reads app.now so the countdown stays live.
  let prayerOpen = $state(false);
  const prayerLine = $derived.by(() => {
    const p = app.data.prayer;
    if (!p || !p.enabled || !p.city) return "";
    void app.now;
    const now = new Date();
    const times = (p.days || {})[prayer.dayKey(now)];
    if (!times) return "times unavailable";
    return prayer.statusLine(times, now.getHours() * 60 + now.getMinutes()) || "times unavailable";
  });

  //* The reminder the next notification will carry — same rotation, so the card previews it.
  const prayerHadith = $derived.by(() => {
    const p = app.data.prayer;
    if (!p || !p.enabled || !p.city) return "";
    const r = prayerReminderAt(p.reminderIndex || 0);
    return r ? `${r.text} — ${r.source}` : "";
  });

  function stripTotal(date) {
    void app.now;
    let t = dayTotal(app.data.days[date]);
    if (app.data.timer.activeId && app.data.timer.date === date && app.data.timer.startedAt) {
      t += (Date.now() - app.data.timer.startedAt) / 1000;
    }
    return t;
  }

  function headerPlay() {
    if (running) {
      pauseEntryTimer();
    } else if (selected === today && entries.length) {
      startEntryTimer(selected, entries[entries.length - 1].id); // resume most recent
    } else {
      selected = today;
      modal = { entry: null };
    }
  }

  async function del(entry) {
    if (app.data.confirmBeforeDelete !== false) {
      const ok = await showConfirm("Delete this task entry?", "Yes, delete");
      if (!ok) return;
    }
    removeEntry(selected, entry.id);
  }

  async function finalSubmit() {
    if (!app.data.name) {
      app.fill = { ...app.fill, error: "Pick your name first (Settings, or the selector below)." };
      return;
    }
    const under1min = entries.filter((e) => entryElapsed(e) < 60);
    if (under1min.length) {
      app.fill = { ...app.fill, error: `${under1min.length} entr${under1min.length === 1 ? "y" : "ies"} have under 1 minute tracked — set a real time before submitting.` };
      return;
    }
    const msg =
      `Re-fill Fillout with all ${entries.length} entr${entries.length === 1 ? "y" : "ies"} for this day?` +
      `\nThis clears any existing entries already in the form, then adds these fresh.` +
      `\n\nThe form's own final Submit stays yours to click.`;
    if (!(await showConfirm(msg, "Yes, auto-fill"))) return;
    submitToFillout(selected);
  }

  // Copy Tasks
  $effect(() => {
    selected; // selection is scoped to whichever day is being viewed
    copyMode = false;
    copySelected = new Set();
    copyStatus = "";
  });
  function toggleCopyMode() {
    copyMode = !copyMode;
    if (!copyMode) copySelected = new Set();
    copyStatus = "";
  }
  function toggleCopySelect(id, checked) {
    const next = new Set(copySelected);
    if (checked) next.add(id); else next.delete(id);
    copySelected = next;
  }
  function copyToTarget(targetDate) {
    let n = 0;
    for (const e of entries) {
      if (copySelected.has(e.id)) { addEntry(targetDate, { project: e.project, category: e.category, description: e.description }); n++; }
    }
    copyModalOpen = false;
    copyMode = false;
    copySelected = new Set();
    copyStatus = `✓ Copied ${n} task${n === 1 ? "" : "s"} to ${targetDate}.`;
  }
</script>

{#if clicked}
  <!-- click-away closes a pinned menu -->
  <div class="menu-backdrop" onclick={closeMenu} role="presentation"></div>
{/if}

<div class="timer-head">
  <div class="big-wrap" role="group" onmouseenter={enterMenu} onmouseleave={leaveMenu}>
    <div class="big mono">{running ? secToHHMMSS(entryElapsed(running)) : "00:00:00"}</div>
    <!-- Hover or click to quick-add: pick a project, then a category. -->
    <button class="quickadd" class:on={menuOpen} onclick={toggleMenu} aria-label="Quick add a task">
      + Quick add ▾
    </button>
    {#if menuOpen}
      <div class="proj-menu">
        <div class="pm-head muted">Pick a project</div>
        {#each currentProjects() as p}
          <div class="pm-item">
            <button class="pm-row" class:open={openProject === p}
                    onmouseenter={() => showCats(p)} onclick={() => showCats(p)}>
              <span class="dot" style:background={projectColor(p)}></span>
              <span class="pm-name">{p}</span>
              <span class="chev">{openProject === p ? "▾" : "›"}</span>
            </button>
            {#if openProject === p}
              <div class="cat-menu">
                {#each currentCategories() as c}
                  <button class="cm-row" onclick={() => openPreset(p, c)}>
                    <span class="dot" style:background={categoryColor(c)}></span>{c}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
  <button class="playbig" class:running onclick={headerPlay} title={running ? "Pause" : "Start"}>
    {running ? "❚❚" : "▶"}
  </button>
  {#if running}
    <div class="running-info">
      <span class="dot" style:background={projectColor(running.project)}></span>
      <span class="running-desc">{running.description}</span>
    </div>
  {/if}
</div>

<div class="dateline">
  <span class="long">{longDate(selected)}</span>
  <span class="mono day-total">{secToHMM(selectedTotal)}</span>
  {#if selected !== today || anchor !== today}
    <button class="link" onclick={() => { selected = today; anchor = today; }}>Today ›</button>
  {/if}
</div>

<div class="strip">
  <button class="arrow" onclick={() => (anchor = addDays(anchor, -7))}>‹</button>
  {#each days as d}
    <button class="daycard" class:sel={d === selected} class:istoday={d === today} onclick={() => (selected = d)}>
      <span class="dow">{dayLabel(d).dow}</span>
      <span class="md muted">{dayLabel(d).md}</span>
      <span class="tot mono" class:has={stripTotal(d) > 0}>{secToHMM(stripTotal(d))}</span>
      {#if daySubmitted(d)}<span class="sub-tick" title="Submitted to Fillout">✅</span>{/if}
      {#if d === today}<span class="today-tag">Today</span>{/if}
    </button>
  {/each}
  <button class="arrow" onclick={() => (anchor = addDays(anchor, 7))} disabled={anchor >= today}>›</button>
</div>

<div class="toolbar">
  <div class="toolbar-left">
    <button class="btn ghost" onclick={() => (modal = { entry: null })}>+ Add</button>
    {#if entries.length}
      <button class="btn ghost" onclick={toggleCopyMode}>{copyMode ? "Cancel" : "Copy Tasks"}</button>
      {#if copyMode && copySelected.size > 0}
        <button class="btn ghost" onclick={() => (copyModalOpen = true)}>Copy to ({copySelected.size})</button>
      {/if}
    {/if}
  </div>
  <div class="tabs">
    <button class="tabbtn" class:on={tab === "summary"} onclick={() => (tab = "summary")}>▤ Summary</button>
    <button class="tabbtn" class:on={tab === "timesheet"} onclick={() => (tab = "timesheet")}>☰ Timesheet</button>
  </div>
</div>

{#if copyStatus}<p class="status-ok">{copyStatus}</p>{/if}

{#if tab === "timesheet"}
  {#if entries.length === 0}
    <p class="empty muted">No entries for this day. Click <b>Add</b> to start a timer.</p>
  {:else}
    <div class="rows">
      {#each entries as e (e.id)}
        {@const isRunning = app.data.timer.activeId === e.id}
        <div class="row" class:active={isRunning}>
          {#if copyMode}
            <input type="checkbox" class="copyChk" checked={copySelected.has(e.id)}
                   onchange={(ev) => toggleCopySelect(e.id, ev.target.checked)} />
          {/if}
          <span class="dot" style:background={isRunning ? "var(--success)" : "var(--text-muted)"}></span>
          <div class="row-main">
            <div class="row-title">{e.description}</div>
            <div class="row-meta">
              <span class="badge" style:background={categoryColor(e.category)}>{e.category}</span>
              <span class="proj"><span class="dot" style:background={projectColor(e.project)}></span>{e.project}</span>
              {#if e.submitted}<span class="badge" style:background="var(--accent)">Submitted</span>{/if}
            </div>
          </div>
          <span class="time mono">{secToHHMM(entryElapsed(e))}</span>
          {#if selected === today}
            <button class="iconbtn play" onclick={() => (isRunning ? pauseEntryTimer() : startEntryTimer(selected, e.id))}>
              {isRunning ? "❚❚" : "▶"}
            </button>
          {/if}
          <button class="iconbtn edit" onclick={() => (modal = { entry: e })}>✎</button>
          <button class="iconbtn del" onclick={() => del(e)}>✕</button>
        </div>
      {/each}
    </div>
  {/if}
{:else}
  <div class="summary">
    {#each catTotals as [cat, secs]}
      <div class="sumrow">
        <span><span class="dot" style:background={categoryColor(cat)}></span> {cat}</span>
        <span class="mono">{secToHHMM(secs)}</span>
      </div>
    {/each}
    <div class="sumrow total">
      <span>Total</span>
      <span class="mono">{secToHHMM(selectedTotal)}</span>
    </div>

    <div class="sub-status" class:done={selSubmitted}>
      {#if selSubmitted}
        <span class="s-icon">✅</span>
        <span class="s-text">Submitted to Fillout
          <span class="muted">· {longDate(selected)} · {selSubmitted.method === "auto" ? "auto-detected" : "marked manually"}</span>
        </span>
        <button class="btn tiny" onclick={() => unmarkDaySubmitted(selected)}>Unmark</button>
      {:else}
        <span class="s-icon">⬜</span>
        <span class="s-text">Not submitted yet</span>
        <button class="btn tiny" disabled={entries.length === 0} onclick={() => markDaySubmitted(selected, "manual")}>Mark submitted</button>
      {/if}
    </div>

    <div class="submit-panel">
      <h2>Submit to Fillout</h2>
      <span class="fieldlbl">Your name</span>
      <SearchSelect
        items={app.data.names}
        value={app.data.name}
        placeholder="Pick your name…"
        disabled={!app.data.names.length}
        onpick={(n) => { app.data.name = n; save(); }}
      />
      {#if !app.data.names.length}
        <p class="muted small">No names loaded yet — fetch them in Settings.</p>
      {/if}
      <p class="muted small">
        Opens the Fillout form in a window and fills every entry for you. It stops
        before the form's final Submit — review, then submit yourself.
      </p>
      {#each entries as e}
        <div class="preview-row">
          <span class="pv-desc">{e.description}</span>
          <span class="badge" style:background={categoryColor(e.category)}>{e.category}</span>
          <span class="mono pv-time">{secToHHMM(entryElapsed(e))}</span>
          {#if e.submitted}<span class="badge" style:background="var(--accent)">✓</span>{/if}
        </div>
      {/each}
      <!--! A submitted day can't be re-filled without unmarking first — the Unmark button above is
            the only escape, which is why its tombstone has to survive a Drive sync. -->
      <button
        class="btn primary submit-btn"
        disabled={app.fill.running || entries.length === 0 || !app.data.name || !!selSubmitted}
        title={selSubmitted ? "This day is marked submitted — unmark it first to re-fill the form." : ""}
        onclick={finalSubmit}
      >
        {app.fill.running ? "Filling…" : `Auto-fill ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in Fillout`}
      </button>
      {#if selSubmitted}
        <p class="muted small">Marked submitted — unmark this day above to re-fill it.</p>
      {/if}
      {#if app.fill.message}<p class="status-ok">{app.fill.message}</p>{/if}
      {#if app.fill.error}<p class="status-err">{app.fill.error}</p>{/if}
    </div>
  </div>
{/if}

<!--* Outside the tab block on purpose — it belongs to the page, not to one tab. -->
<button class="prayer-btn" class:on={app.data.prayer?.enabled && app.data.prayer?.city}
        onclick={() => (prayerOpen = true)}>
  <span class="prayer-icon">🕌</span>
  <span class="prayer-text">
    <span class="prayer-title">
      {app.data.prayer?.enabled && app.data.prayer?.city ? app.data.prayer.city : "Namaj Time"}
    </span>
    <span class="prayer-sub">{prayerLine || "Set your city to get prayer reminders"}</span>
    {#if prayerHadith}<span class="prayer-hadith">{prayerHadith}</span>{/if}
  </span>
</button>

{#if modal}
  <AddEntryModal
    date={selected}
    entry={modal.entry}
    presetProject={modal.presetProject || ""}
    presetCategory={modal.presetCategory || ""}
    onclose={() => (modal = null)}
  />
{/if}

{#if prayerOpen}
  <PrayerModal onclose={() => (prayerOpen = false)} />
{/if}

{#if copyModalOpen}
  <CopyToModal minDate={today} onclose={() => (copyModalOpen = false)} onconfirm={copyToTarget} />
{/if}

<style>
  .timer-head {
    display: flex; align-items: center; justify-content: center; gap: 16px;
    padding: 8px 0 16px;
    border-bottom: 1px solid var(--border-color);
  }
  .big-wrap { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .big { font-size: 34px; font-weight: 600; letter-spacing: 1px; cursor: default; }

  /* Visible, discoverable trigger for the quick-add menu (esp. on touch). */
  .quickadd {
    border: 1px solid var(--border-color); background: var(--bg-surface);
    color: var(--text-secondary); border-radius: 999px;
    padding: 4px 12px; font-size: 12px; font-weight: 500; cursor: pointer;
    transition: all .12s ease;
  }
  .quickadd:hover, .quickadd.on { border-color: var(--accent); color: var(--accent-light); background: var(--bg-surface-hover); }

  .menu-backdrop { position: fixed; inset: 0; z-index: 55; }
  /* Sits flush under the trigger (no gap) so hovering across into it never
     leaves the wrap. A transparent top border gives visual separation while
     staying part of the hoverable box. */
  .proj-menu {
    position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    z-index: 60;
    border-top: 6px solid transparent; background-clip: padding-box;
    min-width: 250px; max-height: 62vh; overflow-y: auto; padding: 6px;
    background: var(--bg-surface); border-left: 1px solid var(--border-color);
    border-right: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color);
    border-radius: 12px; box-shadow: 0 16px 40px rgba(0,0,0,.45);
  }
  .pm-head { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; padding: 4px 10px 8px; }
  .pm-item { display: flex; flex-direction: column; }
  .pm-row {
    display: flex; align-items: center; gap: 9px; width: 100%;
    padding: 10px 11px; border: none; background: none; border-radius: 8px;
    font-size: 13.5px; color: var(--text-primary); cursor: pointer; text-align: left;
  }
  .pm-row:hover, .pm-row.open { background: var(--bg-surface-hover); }
  .pm-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { color: var(--text-muted); font-size: 15px; }
  /* categories stack directly below the project (no side flyout to chase) */
  .cat-menu { display: flex; flex-direction: column; margin: 2px 0 6px 10px; padding-left: 8px; border-left: 2px solid var(--border-color); }
  .cm-row {
    display: flex; align-items: center; gap: 9px; width: 100%;
    padding: 9px 10px; border: none; background: none; border-radius: 8px;
    color: var(--text-secondary); font-size: 13px; cursor: pointer; text-align: left;
  }
  .cm-row:hover { background: var(--bg-surface-hover); color: var(--text-primary); }

  .playbig {
    width: 44px; height: 44px; border-radius: 50%;
    border: none; background: var(--accent); color: #fff;
    font-size: 16px; cursor: pointer;
  }
  .playbig:hover { background: var(--accent-hover); }
  .playbig.running { background: var(--bg-surface-2); color: var(--text-primary); }
  .running-info { display: flex; align-items: center; gap: 8px; max-width: 300px; }
  .running-desc { font-size: 13px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .dateline { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 14px 0 4px; font-size: 15px; }
  .long { font-weight: 600; }
  .day-total { color: var(--accent-light); }
  .link { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 13px; }
  .link:hover { color: var(--text-primary); }

  .strip { display: flex; align-items: stretch; gap: 8px; padding: 10px 0 4px; }
  .arrow { border: none; background: none; color: var(--text-muted); font-size: 20px; cursor: pointer; padding: 0 4px; }
  .arrow:disabled { opacity: .3; cursor: default; }
  .daycard {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column; gap: 2px; position: relative;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 9px;
    padding: 9px 11px 22px;
    cursor: pointer; text-align: left;
    color: var(--text-primary);
  }
  .daycard:hover { background: var(--bg-surface-hover); }
  .daycard.sel { border-color: #a3a838; background: #191a12; }
  :root[data-theme="light"] .daycard.sel { background: #fdfce8; }
  .dow { font-weight: 700; font-size: 13px; }
  .md { font-size: 12px; }
  .tot { position: absolute; right: 10px; bottom: 7px; font-size: 12px; color: var(--text-muted); }
  .tot.has { color: var(--accent-light); }
  .today-tag {
    position: absolute; left: 50%; transform: translateX(-50%); bottom: -18px;
    font-size: 11px; color: var(--success);
  }

  /* Mobile/narrow (Android): 7 equal flex columns squeeze down to ~30px each,
     which is too narrow for "Mon" + the ✅ badge to coexist — they overlap.
     Give cards a fixed, readable width and let the strip scroll horizontally
     instead; this also means fewer days show at once, which is the point. */
  @media (max-width: 640px) {
    /*! overflow-y:visible does NOT survive here — once one axis is auto/scroll the other
       computes to auto too, so the strip clips both ways however it is declared. .today-tag
       sits at bottom:-18px, outside .daycard, so it was scrolled out of view: the tag only
       appeared after scrolling the page down. Reserve room for it in the strip's own padding
       instead, which is inside the scrollable area and needs no overflow trickery.
       Tag spans roughly 18–32px below the card, so 34px clears it. */
    .strip { overflow-x: auto; padding-bottom: 34px; }
    .daycard { flex: 0 0 72px; }
  }

  .toolbar { display: flex; align-items: center; justify-content: space-between; margin: 26px 0 12px; flex-wrap: wrap; gap: 10px; }
  .toolbar-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .tabs { display: flex; gap: 4px; }
  .tabbtn {
    background: none; border: none; cursor: pointer;
    color: var(--text-muted); font-size: 14px; padding: 8px 12px;
    border-bottom: 2px solid transparent;
  }
  .tabbtn.on { color: var(--accent-light); border-bottom-color: var(--accent); }

  .empty { text-align: center; padding: 60px 0; }

  .prayer-btn {
    display: flex; align-items: center; gap: 12px; width: 100%;
    margin-top: 22px; padding: 13px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius);
    color: var(--text-primary); text-align: left; cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  .prayer-btn:hover { border-color: var(--accent); background: var(--accent-tint); }
  /*! Highlighted only once it is actually set up — an unconfigured button shouting for attention
      next to the timer is exactly the crowding this feature was meant to avoid. */
  .prayer-btn.on { border-color: var(--accent); }
  .prayer-icon { font-size: 26px; line-height: 1; flex: none; }
  .prayer-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .prayer-title { font-size: 15px; font-weight: 600; }
  .prayer-sub { font-size: 12.5px; color: var(--text-muted); }
  /*! Clamped to two lines: some reminders are long and the card must not push the timer down. */
  .prayer-hadith {
    font-size: 11.5px; line-height: 1.45; color: var(--text-muted); margin-top: 3px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .rows { display: flex; flex-direction: column; gap: 10px; }
  .row {
    display: flex; align-items: center; gap: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 13px 16px;
  }
  .row.active { border-color: var(--accent); }
  .row-main { flex: 1; min-width: 0; }
  .row-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-meta { display: flex; align-items: center; gap: 10px; margin-top: 5px; }
  .proj { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); }
  .time {
    width: 84px; flex: none; text-align: center; padding: 7px 6px;
    color: var(--text-secondary); font-size: 14px;
  }
  .iconbtn {
    width: 34px; height: 34px; flex: none;
    border-radius: 50%; border: 1px solid var(--border-color);
    background: var(--bg-page); cursor: pointer; font-size: 13px;
  }
  .iconbtn.play { color: var(--success); border-color: var(--success); }
  .iconbtn.edit { color: var(--accent-light); border-color: var(--accent-light); }
  .iconbtn.del { color: var(--danger-light); border-color: var(--danger-light); }
  .iconbtn:hover { background: var(--bg-surface-hover); }
  .copyChk { width: auto; min-height: 0; flex: none; margin: 0; }

  .summary { max-width: 560px; }
  .sumrow {
    display: flex; justify-content: space-between; align-items: center;
    padding: 11px 4px; border-bottom: 1px solid var(--border-color);
  }
  .sumrow span:first-child { display: inline-flex; align-items: center; gap: 8px; }
  .sumrow.total { font-weight: 700; }

  .sub-tick { position: absolute; right: 9px; top: 7px; font-size: 11px; }

  .sub-status {
    display: flex; align-items: center; gap: 10px;
    margin-top: 20px; padding: 12px 14px;
    background: var(--bg-surface); border: 1px solid var(--border-color);
    border-radius: 10px; font-size: 13.5px;
  }
  .sub-status.done { border-color: var(--success); }
  .sub-status .s-icon { font-size: 15px; }
  .sub-status .s-text { flex: 1; }
  .btn.tiny { padding: 5px 10px; font-size: 12.5px; }

  .submit-panel { margin-top: 26px; }
  /*? A span, not a <label>: SearchSelect owns its own input, so there is no id here to point a
      label's `for` at. */
  .fieldlbl { display: block; margin: 12px 0 5px; font-size: 12.5px; color: var(--text-muted); }
  .small { font-size: 12.5px; }
  .preview-row {
    display: flex; align-items: center; gap: 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 9px 12px; margin-top: 8px;
  }
  .pv-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .pv-time { color: var(--text-muted); font-size: 13px; }
  .submit-btn { width: 100%; margin-top: 14px; }
</style>
