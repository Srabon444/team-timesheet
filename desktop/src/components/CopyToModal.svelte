<script>
  import { untrack } from "svelte";
  import { isDayPick } from "../lib/time.js";
  // { minDate: "YYYY-MM-DD", onclose, onconfirm(targetDate) } — parent owns
  // the selected-entries set and does the actual copying.
  let { minDate, onclose, onconfirm } = $props();

  //! Seeded once on open, deliberately — untrack() keeps the compiler from reading it as a bug.
  let target = $state(untrack(() => minDate));
  let error = $state("");
  let prev = untrack(() => minDate);
  let byPointer = false;

  //! WebKit (Linux/macOS) keeps its calendar open after a day is picked until the input loses focus.
  function onchange(e) {
    const v = e.currentTarget.value;
    if (byPointer && isDayPick(prev, v)) e.currentTarget.blur();
    prev = v;
  }

  function confirm() {
    // Mirror the native <input min> guard here too, rather than trust it
    // unconditionally.
    if (!target || target < minDate) {
      error = "Pick today or a future date.";
      return;
    }
    onconfirm(target);
  }

  function onkeydown(e) {
    if (e.key === "Escape") onclose();
  }
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="copy-to-title"
     tabindex="-1" onkeydown={onkeydown}>
  <div class="box">
    <h3 id="copy-to-title">Copy to</h3>
    <label for="copyDate">Target date</label>
    <input id="copyDate" type="date" min={minDate} bind:value={target} {onchange}
           onpointerdown={() => (byPointer = true)} onkeydown={() => (byPointer = false)} />
    {#if error}<p class="status-err">{error}</p>{/if}
    <div class="actions">
      <button class="btn" onclick={onclose}>Cancel</button>
      <button class="btn primary" onclick={confirm}>Confirm copy</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; z-index: 90;
    background: var(--overlay-bg);
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .box {
    width: 100%; max-width: 380px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 22px;
  }
  h3 { margin: 0 0 6px; font-size: 17px; }
  .actions { display: flex; gap: 10px; margin-top: 18px; }
  .actions .btn { flex: 1; }
</style>
