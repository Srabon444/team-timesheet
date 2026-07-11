<script>
  import { app, save, applyTheme, fetchNames, showConfirm } from "../lib/store.svelte.js";

  let fetching = $state(false);
  let fetchMsg = $state("");

  async function loadNames() {
    fetching = true;
    fetchMsg = "";
    try {
      const names = await fetchNames();
      fetchMsg = `Loaded ${names.length} names.`;
    } catch (e) {
      fetchMsg = `Error: ${e.message || e}`;
    }
    fetching = false;
  }

  async function resetEverything() {
    const ok = await showConfirm(
      "Delete all tasks, history, and settings? This cannot be undone. Your name is kept.",
      "Yes, reset"
    );
    if (!ok) return;
    const { name, names } = app.data;
    app.data.days = {};
    app.data.timer = { activeId: null, startedAt: null, date: null };
    app.data.lastProject = null;
    app.data.lastCategory = null;
    app.data.dailyLimitHours = 8;
    app.data.warnedDate = null;
    app.data.confirmBeforeDelete = true;
    app.data.name = name;
    app.data.names = names;
    applyTheme("dark");
    save();
  }
</script>

<h1>Settings</h1>
<p class="muted">Stored locally — never leaves this machine.</p>

<section>
  <h2>Your name</h2>
  <div class="row-inline">
    <select bind:value={app.data.name} onchange={save} disabled={!app.data.names.length}>
      <option value="" disabled>Pick your name…</option>
      {#each app.data.names as n}<option value={n}>{n}</option>{/each}
    </select>
    <button class="btn" onclick={loadNames} disabled={fetching}>
      {fetching ? "Fetching…" : app.data.names.length ? "Refresh names" : "Fetch names from form"}
    </button>
  </div>
  {#if fetchMsg}<p class="muted small">{fetchMsg}</p>{/if}
  <p class="muted small">Used to auto-select the Name field when submitting to Fillout.</p>
</section>

<section>
  <h2>Tracking</h2>
  <div class="setrow">
    <div>
      <div class="setlbl">Daily limit</div>
      <div class="setdesc muted">One OS notification when you cross this many hours in a day.</div>
    </div>
    <select class="narrow" bind:value={app.data.dailyLimitHours} onchange={save}>
      {#each Array.from({ length: 12 }, (_, i) => i + 1) as h}
        <option value={h}>{h} hour{h > 1 ? "s" : ""}</option>
      {/each}
    </select>
  </div>
  <div class="setrow">
    <div>
      <div class="setlbl">Confirm before deleting</div>
      <div class="setdesc muted">Turn off to delete tasks in one click.</div>
    </div>
    <input type="checkbox" class="toggle" bind:checked={app.data.confirmBeforeDelete} onchange={save} />
  </div>
</section>

<section>
  <h2>Appearance</h2>
  <div class="themes">
    {#each ["dark", "light", "system"] as t}
      <button class="btn" class:primary={app.data.theme === t} onclick={() => applyTheme(t)}>
        {t[0].toUpperCase() + t.slice(1)}
      </button>
    {/each}
  </div>
</section>

<section class="danger">
  <div class="setrow">
    <div>
      <div class="setlbl">Reset everything</div>
      <div class="setdesc muted">Deletes all tasks, days, and settings. Cannot be undone. Your name is kept.</div>
    </div>
    <button class="btn danger" onclick={resetEverything}>Reset</button>
  </div>
</section>

<style>
  section { max-width: 640px; margin-top: 26px; }
  .row-inline { display: flex; gap: 10px; align-items: center; }
  .row-inline select { flex: 1; }
  .small { font-size: 12.5px; margin-top: 8px; }
  .setrow {
    display: flex; justify-content: space-between; align-items: center; gap: 20px;
    padding: 14px 0; border-bottom: 1px solid var(--border-color);
  }
  .setlbl { font-size: 14.5px; font-weight: 600; }
  .setdesc { font-size: 12.5px; margin-top: 3px; }
  .narrow { width: 130px; }
  .toggle { width: 20px; height: 20px; accent-color: var(--accent); }
  .themes { display: flex; gap: 10px; }
  .danger { border: 1px solid var(--danger); border-radius: 10px; padding: 4px 16px; }
  .danger .setrow { border-bottom: none; }
</style>
