<script>
  // Restore picker: every task a backup holds that is missing here, each ticked ✓ (add back) or
  // ✗ (leave out). Nothing already present is touched. Same flow as the extension's full view.
  import { secToHHMM } from "../lib/time.js";

  let { cands, source, onapply, oncancel } = $props();
  let choice = $state(cands.map(() => null));
  let err = $state("");
  const picked = $derived(cands.filter((_, i) => choice[i] === true));

  function apply() {
    if (!picked.length) { err = "Tick ✓ on at least one task, or Cancel."; return; }
    onapply(picked);
  }
</script>

<div class="overlay" role="dialog">
  <div class="box">
    <p>{cands.length} task(s) in {source} are not in your data now. Tick ✓ to add a task back, ✗ to leave it out.</p>
    <div class="bulk">
      <button class="btn" onclick={() => (choice = cands.map(() => true))}>✓ All</button>
      <button class="btn" onclick={() => (choice = cands.map(() => false))}>✗ All</button>
    </div>
    <div class="list">
      {#each cands as c, i}
        {#if i === 0 || cands[i - 1].date !== c.date}<div class="date">{c.date}</div>{/if}
        <div class="row" class:yes={choice[i] === true} class:no={choice[i] === false}>
          <span class="main">
            <span class="proj">{c.entry.project} · {c.entry.category}</span>
            <span class="desc muted">{c.entry.description}</span>
          </span>
          <span class="mono time">{secToHHMM(c.entry.accSec || 0)}</span>
          <button class="tick y" title="Add this task back" onclick={() => (choice[i] = true)}>✓</button>
          <button class="tick n" title="Leave it out" onclick={() => (choice[i] = false)}>✗</button>
        </div>
      {/each}
    </div>
    {#if err}<p class="err">{err}</p>{/if}
    <div class="actions">
      <button class="btn" onclick={oncancel}>Cancel</button>
      <button class="btn primary" onclick={apply}>Add {picked.length} task(s)</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; z-index: 100; background: var(--overlay-bg);
    display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .box {
    width: 100%; max-width: 640px; max-height: 90vh; display: flex; flex-direction: column;
    background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 10px; padding: 16px;
  }
  .box p { margin: 0 0 10px; line-height: 1.5; }
  .bulk { display: flex; gap: 8px; margin-bottom: 8px; }
  .list { overflow-y: auto; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
  .date { font-weight: 600; font-size: 12px; margin-top: 8px; color: var(--text-muted); }
  .row {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    border: 1px solid var(--border-color); border-radius: 6px;
  }
  .row.yes { border-color: var(--success); }
  .row.no { opacity: 0.5; }
  .main { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .desc { display: block; font-size: 12px; }
  .time { white-space: nowrap; }
  .tick {
    width: 34px; height: 30px; border-radius: 6px; border: 1px solid var(--border-color);
    background: transparent; color: inherit; cursor: pointer; flex: none;
  }
  .row.yes .y { background: var(--success); color: #fff; }
  .row.no .n { background: var(--danger); color: #fff; }
  .err { color: var(--danger-light); font-size: 13px; margin: 8px 0 0; }
  .actions { display: flex; gap: 10px; margin-top: 12px; }
  .actions .btn { flex: 1; }
</style>
