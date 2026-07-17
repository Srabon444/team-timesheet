<script>
  // App-wide confirm modal (promise-based via store.showConfirm). Custom
  // per-action Yes label — same pattern the extension settled on after
  // "Yes, submit" showed up on delete confirmations.
  import { app, answerConfirm } from "../lib/store.svelte.js";
</script>

{#if app.confirm}
  <div class="overlay" role="dialog">
    <div class="box">
      <p>{app.confirm.message}</p>
      <div class="actions">
        <button class="btn" onclick={() => answerConfirm("cancel")}>Cancel</button>
        {#if app.confirm.altLabel}
          <button class="btn alt" onclick={() => answerConfirm("alt")}>{app.confirm.altLabel}</button>
        {/if}
        <button class="btn danger" onclick={() => answerConfirm("yes")}>{app.confirm.yesLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0; z-index: 100;
    background: var(--overlay-bg);
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .box {
    width: 100%; max-width: 460px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 20px;
  }
  .box p { margin: 0 0 16px; white-space: pre-line; word-break: break-word; line-height: 1.5; }
  .actions { display: flex; gap: 10px; }
  .actions .btn { flex: 1; }
  .actions .btn.alt {
    background: var(--accent); border-color: var(--accent); color: var(--text-on-accent);
  }
</style>
