<script>
  import { categoryColor, projectColor } from "../lib/constants.js";
  import { todayStr, secToHHMM, secToHHMMSS, secToHMM, hhmmToSec, stripDates, addDays, dayLabel, longDate } from "../lib/time.js";
  import { dayTotal, byCategory } from "../lib/stats.js";
  import {
    app, save, showConfirm,
    startEntryTimer, pauseEntryTimer, setEntryTime, removeEntry,
    entryElapsed, activeEntry, submitToFillout,
  } from "../lib/store.svelte.js";
  import AddEntryModal from "../components/AddEntryModal.svelte";

  let selected = $state(todayStr());
  let anchor = $state(todayStr()); // day-strip window end
  let tab = $state("timesheet");
  let modal = $state(null); // { entry|null, startOnAdd }

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
  const pendingCount = $derived(entries.filter((e) => !e.submitted).length);

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
      modal = { entry: null, startOnAdd: true };
    }
  }

  async function del(entry) {
    if (app.data.confirmBeforeDelete !== false) {
      const ok = await showConfirm("Delete this task entry?", "Yes, delete");
      if (!ok) return;
    }
    removeEntry(selected, entry.id);
  }

  function onTimeEdit(entry, value) {
    if (!/^\d{1,2}:\d{2}$/.test(value.trim())) return;
    setEntryTime(selected, entry.id, value.trim());
  }

  async function finalSubmit() {
    if (!app.data.name) {
      app.fill = { ...app.fill, error: "Pick your name first (Settings, or the selector below)." };
      return;
    }
    const zeros = entries.filter((e) => !e.submitted && entryElapsed(e) < 30).length;
    const msg =
      `Auto-fill ${pendingCount} entr${pendingCount === 1 ? "y" : "ies"} in Fillout?` +
      (zeros ? `\n${zeros} have ~00:00 time.` : "") +
      `\n\nThis fills entries only — the form's own final Submit stays yours to click.`;
    if (!(await showConfirm(msg, "Yes, auto-fill"))) return;
    submitToFillout(selected);
  }
</script>

<div class="timer-head">
  <div class="big mono">{running ? secToHHMMSS(entryElapsed(running)) : "00:00:00"}</div>
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
      {#if d === today}<span class="today-tag">Today</span>{/if}
    </button>
  {/each}
  <button class="arrow" onclick={() => (anchor = addDays(anchor, 7))} disabled={anchor >= today}>›</button>
</div>

<div class="toolbar">
  <button class="btn ghost" onclick={() => (modal = { entry: null, startOnAdd: selected === today })}>+ Add</button>
  <div class="tabs">
    <button class="tabbtn" class:on={tab === "summary"} onclick={() => (tab = "summary")}>▤ Summary</button>
    <button class="tabbtn" class:on={tab === "timesheet"} onclick={() => (tab = "timesheet")}>☰ Timesheet</button>
  </div>
</div>

{#if tab === "timesheet"}
  {#if entries.length === 0}
    <p class="empty muted">No entries for this day. Click <b>Add</b> to start a timer.</p>
  {:else}
    <div class="rows">
      {#each entries as e (e.id)}
        {@const isRunning = app.data.timer.activeId === e.id}
        <div class="row" class:active={isRunning}>
          <span class="dot" style:background={isRunning ? "var(--success)" : "var(--text-muted)"}></span>
          <div class="row-main">
            <div class="row-title">{e.description}</div>
            <div class="row-meta">
              <span class="badge" style:background={categoryColor(e.category)}>{e.category}</span>
              <span class="proj"><span class="dot" style:background={projectColor(e.project)}></span>{e.project}</span>
              {#if e.submitted}<span class="badge" style:background="var(--accent)">Submitted</span>{/if}
            </div>
          </div>
          <input
            class="time mono"
            value={secToHHMM(entryElapsed(e))}
            onchange={(ev) => onTimeEdit(e, ev.target.value)}
          />
          {#if selected === today}
            <button class="iconbtn play" onclick={() => (isRunning ? pauseEntryTimer() : startEntryTimer(selected, e.id))}>
              {isRunning ? "❚❚" : "▶"}
            </button>
          {/if}
          <button class="iconbtn edit" onclick={() => (modal = { entry: e, startOnAdd: false })}>✎</button>
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

    <div class="submit-panel">
      <h2>Submit to Fillout</h2>
      <label for="subname">Your name</label>
      <select id="subname" bind:value={app.data.name} onchange={save}>
        <option value="" disabled>Pick your name…</option>
        {#each app.data.names as n}<option value={n}>{n}</option>{/each}
      </select>
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
      <button
        class="btn primary submit-btn"
        disabled={app.fill.running || pendingCount === 0 || !app.data.name}
        onclick={finalSubmit}
      >
        {app.fill.running ? "Filling…" : `Auto-fill ${pendingCount} entr${pendingCount === 1 ? "y" : "ies"} in Fillout`}
      </button>
      {#if app.fill.message}<p class="status-ok">{app.fill.message}</p>{/if}
      {#if app.fill.error}<p class="status-err">{app.fill.error}</p>{/if}
    </div>
  </div>
{/if}

{#if modal}
  <AddEntryModal date={selected} entry={modal.entry} startOnAdd={modal.startOnAdd} onclose={() => (modal = null)} />
{/if}

<style>
  .timer-head {
    display: flex; align-items: center; justify-content: center; gap: 16px;
    padding: 8px 0 16px;
    border-bottom: 1px solid var(--border-color);
  }
  .big { font-size: 34px; font-weight: 600; letter-spacing: 1px; }
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

  .toolbar { display: flex; align-items: center; justify-content: space-between; margin: 26px 0 12px; }
  .tabs { display: flex; gap: 4px; }
  .tabbtn {
    background: none; border: none; cursor: pointer;
    color: var(--text-muted); font-size: 14px; padding: 8px 12px;
    border-bottom: 2px solid transparent;
  }
  .tabbtn.on { color: var(--accent-light); border-bottom-color: var(--accent); }

  .empty { text-align: center; padding: 60px 0; }

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
  .time { width: 84px; flex: none; text-align: center; padding: 7px 6px; }
  .iconbtn {
    width: 34px; height: 34px; flex: none;
    border-radius: 50%; border: 1px solid var(--border-color);
    background: var(--bg-page); cursor: pointer; font-size: 13px;
  }
  .iconbtn.play { color: var(--success); border-color: var(--success); }
  .iconbtn.edit { color: var(--accent-light); border-color: var(--accent-light); }
  .iconbtn.del { color: var(--danger-light); border-color: var(--danger-light); }
  .iconbtn:hover { background: var(--bg-surface-hover); }

  .summary { max-width: 560px; }
  .sumrow {
    display: flex; justify-content: space-between; align-items: center;
    padding: 11px 4px; border-bottom: 1px solid var(--border-color);
  }
  .sumrow span:first-child { display: inline-flex; align-items: center; gap: 8px; }
  .sumrow.total { font-weight: 700; }

  .submit-panel { margin-top: 26px; }
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
