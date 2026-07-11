<script>
  // Port of the extension's Dashboard: weekly bars, stat tiles, breakdowns.
  import { categoryColor, projectColor } from "../lib/constants.js";
  import { todayStr, secToHHMM, addDays, dayLabel } from "../lib/time.js";
  import {
    mondayOf, weekDates, weekTotals, dayTotal,
    trackedTotal, dailyAverage, activeDayCount, busiestDay,
    byProject, byCategory,
  } from "../lib/stats.js";
  import { app } from "../lib/store.svelte.js";

  let monday = $state(mondayOf(todayStr()));
  const today = $derived(todayStr());
  const totals = $derived(weekTotals(app.data.days, monday));
  const maxBar = $derived(Math.max(1, ...totals.map((t) => t.total)));
  const projTotals = $derived(Object.entries(byProject(app.data.days)).sort((a, b) => b[1] - a[1]));
  const catTotals = $derived(Object.entries(byCategory(app.data.days)).sort((a, b) => b[1] - a[1]));
  const maxProj = $derived(Math.max(1, ...projTotals.map(([, v]) => v)));
  const maxCat = $derived(Math.max(1, ...catTotals.map(([, v]) => v)));
  const busiest = $derived(busiestDay(app.data.days));
</script>

<h1>Reports</h1>

<div class="weeknav">
  <button class="btn" onclick={() => (monday = addDays(monday, -7))}>‹</button>
  <span class="muted">{weekDates(monday)[0]} – {weekDates(monday)[6]}</span>
  <button class="btn" onclick={() => (monday = addDays(monday, 7))}>›</button>
</div>

<div class="chart">
  {#each totals as t}
    <div class="col" class:istoday={t.date === today}>
      <div class="bar" style:height={`${Math.max(2, (t.total / maxBar) * 130)}px`} title={`${t.date}: ${secToHHMM(t.total)}`}></div>
      <span class="dow muted">{dayLabel(t.date).dow}</span>
    </div>
  {/each}
</div>

<div class="tiles">
  <div class="tile">
    <span class="lbl">Today</span>
    <span class="val mono">{secToHHMM(dayTotal(app.data.days[today]))}</span>
  </div>
  <div class="tile">
    <span class="lbl">Tracked Total</span>
    <span class="val mono">{secToHHMM(trackedTotal(app.data.days))}</span>
  </div>
  <div class="tile">
    <span class="lbl">Daily Average</span>
    <span class="val mono">{secToHHMM(dailyAverage(app.data.days))}</span>
    <span class="sub muted">across {activeDayCount(app.data.days)} active day(s)</span>
  </div>
  <div class="tile">
    <span class="lbl">Busiest Day</span>
    <span class="val mono">{busiest ? secToHHMM(busiest.total) : "—"}</span>
    <span class="sub muted">{busiest ? busiest.date : ""}</span>
  </div>
</div>

<div class="breakdowns">
  <div>
    <h2>By project</h2>
    {#each projTotals as [name, secs]}
      <div class="brow">
        <span class="bname">{name}</span>
        <div class="bbar"><span style:width={`${(secs / maxProj) * 100}%`} style:background={projectColor(name)}></span></div>
        <span class="bamount mono muted">{secToHHMM(secs)}</span>
      </div>
    {/each}
  </div>
  <div>
    <h2>By category</h2>
    {#each catTotals as [name, secs]}
      <div class="brow">
        <span class="bname">{name}</span>
        <div class="bbar"><span style:width={`${(secs / maxCat) * 100}%`} style:background={categoryColor(name)}></span></div>
        <span class="bamount mono muted">{secToHHMM(secs)}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .weeknav { display: flex; align-items: center; gap: 12px; margin: 14px 0 8px; }
  .weeknav .btn { padding: 6px 12px; }

  .chart {
    display: flex; align-items: flex-end; gap: 12px;
    height: 170px; padding: 10px 0;
    border-bottom: 1px solid var(--border-color);
  }
  .col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  /* dataviz mark spec: bar capped, never fills the slot */
  .bar { width: 100%; max-width: 28px; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 2px; }
  .col.istoday .bar { background: var(--success); }
  .dow { font-size: 12px; }

  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 20px 0; }
  .tile {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 14px 16px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .lbl { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
  .val { font-size: 24px; font-weight: 700; }
  .sub { font-size: 12px; }

  .breakdowns { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-top: 10px; }
  .brow { display: flex; align-items: center; gap: 10px; margin: 9px 0; font-size: 13.5px; }
  .bname { width: 145px; flex: none; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bbar { flex: 1; height: 9px; background: var(--bg-surface-2); border-radius: 5px; overflow: hidden; }
  .bbar > span { display: block; height: 100%; }
  .bamount { width: 62px; flex: none; text-align: right; font-size: 12.5px; }
</style>
