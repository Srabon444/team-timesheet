<script>
  import { categoryColor, projectColor } from "../lib/constants.js";
  import { todayStr, secToHHMM, secToHMM, dayLabel } from "../lib/time.js";
  import { mondayOf, weekDates, dayTotal } from "../lib/stats.js";
  import { addDays, longDate } from "../lib/time.js";
  import { app } from "../lib/store.svelte.js";

  let monday = $state(mondayOf(todayStr()));
  const dates = $derived(weekDates(monday));
  const weekTotal = $derived(dates.reduce((s, d) => s + dayTotal(app.data.days[d]), 0));
  const today = $derived(todayStr());
</script>

<div class="head">
  <h1>Timesheet</h1>
  <div class="nav">
    <button class="btn" onclick={() => (monday = addDays(monday, -7))}>‹</button>
    <span class="range muted">{dates[0]} – {dates[6]}</span>
    <button class="btn" onclick={() => (monday = addDays(monday, 7))}>›</button>
    <span class="mono wk">Week: {secToHHMM(weekTotal)}</span>
  </div>
</div>

{#each dates as d}
  {@const entries = app.data.days[d] || []}
  <section class="day" class:istoday={d === today}>
    <header>
      <span class="dlabel">{dayLabel(d).dow} <span class="muted">{dayLabel(d).md}</span>
        {#if d === today}<span class="today">Today</span>{/if}
      </span>
      <span class="mono muted">{secToHMM(dayTotal(entries))}</span>
    </header>
    {#if entries.length === 0}
      <p class="none muted">—</p>
    {:else}
      {#each entries as e}
        <div class="erow">
          <span class="dot" style:background={projectColor(e.project)}></span>
          <span class="desc">{e.description}</span>
          <span class="badge" style:background={categoryColor(e.category)}>{e.category}</span>
          <span class="proj muted">{e.project}</span>
          <span class="mono t">{secToHHMM(e.accSec || 0)}</span>
        </div>
      {/each}
    {/if}
  </section>
{/each}

<style>
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .nav { display: flex; align-items: center; gap: 10px; }
  .nav .btn { padding: 6px 12px; }
  .range { font-size: 13px; }
  .wk { color: var(--accent-light); font-size: 14px; margin-left: 8px; }

  .day {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 12px 16px;
    margin-bottom: 10px;
  }
  .day.istoday { border-color: var(--accent); }
  .day header { display: flex; justify-content: space-between; align-items: center; }
  .dlabel { font-weight: 700; font-size: 14px; }
  .today { color: var(--success); font-size: 12px; margin-left: 8px; }
  .none { margin: 8px 0 2px; }
  .erow { display: flex; align-items: center; gap: 10px; padding: 8px 0 0; }
  .desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; }
  .proj { font-size: 12.5px; }
  .t { font-size: 13px; }
</style>
