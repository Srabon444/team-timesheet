<script>
  import { projectColor } from "../lib/constants.js";
  import { secToHHMM } from "../lib/time.js";
  import { byProject } from "../lib/stats.js";
  import { app, currentProjects } from "../lib/store.svelte.js";

  const totals = $derived(byProject(app.data.days));
  const max = $derived(Math.max(1, ...Object.values(totals)));
  const projects = $derived(currentProjects());
</script>

<h1>Projects</h1>
<p class="muted">Projects from the Fillout form — all-time tracked totals.</p>

<div class="list">
  {#each projects as p}
    <div class="prow">
      <span class="dot" style:background={projectColor(p)}></span>
      <span class="name">{p}</span>
      <div class="bar"><span style:width={`${((totals[p] || 0) / max) * 100}%`} style:background={projectColor(p)}></span></div>
      <span class="mono t">{secToHHMM(totals[p] || 0)}</span>
    </div>
  {/each}
</div>

<style>
  .list { margin-top: 18px; max-width: 720px; }
  .prow {
    display: flex; align-items: center; gap: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 13px 16px; margin-bottom: 8px;
  }
  .name { width: 170px; flex: none; font-weight: 600; font-size: 14px; }
  .bar { flex: 1; height: 9px; background: var(--bg-surface-2); border-radius: 5px; overflow: hidden; }
  .bar > span { display: block; height: 100%; }
  .t { width: 70px; text-align: right; color: var(--text-muted); font-size: 13px; }
</style>
