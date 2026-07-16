<script>
  import { PROJECTS, CATEGORIES } from "../lib/constants.js";
  import { todayStr, hhmmToSec } from "../lib/time.js";
  import {
    app, addEntry, updateEntry, removeEntry,
    startEntryTimer, setEntryTime, entryElapsed, showConfirm,
  } from "../lib/store.svelte.js";

  // { date, entry|null (edit mode), presetProject, presetCategory } — parent
  // controls visibility. Presets come from the header timer's hover menu.
  let { date, entry = null, presetProject = "", presetCategory = "", onclose } = $props();

  const dayEntries = app.data.days[date] || [];
  const lastForDay = dayEntries.length ? dayEntries[dayEntries.length - 1] : null;
  const canStartTimer = date === todayStr();

  // First task of a day starts blank (forces a deliberate pick); once the
  // day has an entry, later Adds preselect that day's most recent project.
  // A preset (hover-menu pick) wins over both.
  let project = $state(entry ? entry.project : (presetProject || (lastForDay ? lastForDay.project : "")));
  let category = $state(entry ? entry.category : (presetCategory || (lastForDay ? lastForDay.category : CATEGORIES[2])));
  let description = $state(entry ? entry.description : "");
  // Seed from the entry's LIVE elapsed (not just accSec), so editing a
  // running task shows the real running time — the fix for elapsed getting
  // reset when you edit a task mid-run.
  const startSec = Math.round(entry ? entryElapsed(entry) : 0);
  let hrs = $state(Math.floor(startSec / 3600));
  let mins = $state(Math.floor((startSec % 3600) / 60));
  let error = $state("");

  const hhmm = () => `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  const initHHMM = hhmm(); // to detect whether the user actually changed the time

  function validate() {
    const desc = description.trim();
    if (!desc) { error = "Description is required."; return null; }
    if (!PROJECTS.includes(project)) { error = "Pick a project from the list."; return null; }
    return desc;
  }

  function doAdd(start) {
    const desc = validate();
    if (!desc) return;
    const created = addEntry(date, { project, category, description: desc });
    if (hhmmToSec(hhmm()) > 0) setEntryTime(date, created.id, hhmm());
    if (start) startEntryTimer(date, created.id);
    onclose();
  }

  function doSave() {
    const desc = validate();
    if (!desc) return;
    updateEntry(date, entry.id, { project, category, description: desc });
    // Only rewrite the time if it was actually changed — otherwise a running
    // timer would be reset to the (minute-truncated) displayed value on every
    // edit of project/category/description.
    if (hhmm() !== initHHMM) setEntryTime(date, entry.id, hhmm());
    onclose();
  }

  async function doDelete() {
    if (app.data.confirmBeforeDelete !== false) {
      const ok = await showConfirm("Delete this task entry?", "Yes, delete");
      if (!ok) return;
    }
    removeEntry(date, entry.id);
    onclose();
  }

  function onkeydown(e) {
    if (e.key === "Escape") onclose();
  }
</script>

<div class="overlay" role="dialog" onkeydown={onkeydown}>
  <div class="box">
    <h3>{entry ? "Task Details" : "Add task"}</h3>

    <label for="proj">Project</label>
    <div class="proj-wrap">
      <input id="proj" type="text" list="projects" bind:value={project} placeholder="Pick a project…" />
      {#if project}
        <button type="button" class="clear-x" onclick={() => (project = "")} title="Clear project">×</button>
      {/if}
    </div>
    <datalist id="projects">
      {#each PROJECTS as p}<option value={p}></option>{/each}
    </datalist>

    <label for="cat">Work Category</label>
    <select id="cat" bind:value={category}>
      {#each CATEGORIES as c}<option value={c}>{c}</option>{/each}
    </select>

    <label for="desc">Description <span class="req">*</span></label>
    <!-- svelte-ignore a11y_autofocus -->
    <input id="desc" type="text" bind:value={description} placeholder="What are you working on?" autofocus />

    <label>Time Clocked</label>
    <div class="timepick">
      <select bind:value={hrs} aria-label="Hours">
        {#each Array.from({ length: 24 }, (_, h) => h) as h}<option value={h}>{String(h).padStart(2, "0")} hrs</option>{/each}
      </select>
      <span class="colon">:</span>
      <select bind:value={mins} aria-label="Minutes">
        {#each Array.from({ length: 60 }, (_, m) => m) as m}<option value={m}>{String(m).padStart(2, "0")} min</option>{/each}
      </select>
    </div>
    {#if !entry}<p class="muted small">Leave 00:00 to start a live timer instead.</p>{/if}

    {#if error}<p class="status-err">{error}</p>{/if}

    <div class="actions">
      {#if entry}
        <button class="btn danger" onclick={doDelete}>Delete</button>
        <button class="btn" onclick={onclose}>Cancel</button>
        <button class="btn primary" onclick={doSave}>Save</button>
      {:else}
        <button class="btn" onclick={onclose}>Cancel</button>
        <button class="btn" onclick={() => doAdd(false)}>Add</button>
        {#if canStartTimer}
          <button class="btn primary" onclick={() => doAdd(true)}>Add & Start Timer</button>
        {/if}
      {/if}
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
    width: 100%; max-width: 480px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 22px;
  }
  h3 { margin: 0 0 6px; font-size: 17px; }
  .req { color: var(--danger-light); }
  .proj-wrap { position: relative; }
  .proj-wrap input { padding-right: 34px; }
  .clear-x {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: 22px; height: 22px; border-radius: 50%; border: none; padding: 0;
    background: none; color: var(--text-muted); cursor: pointer;
    font-size: 16px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
  }
  .clear-x:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
  .timepick { display: flex; align-items: center; gap: 8px; }
  .timepick select { flex: 1; width: auto; }
  .colon { color: var(--text-muted); font-weight: 700; }
  .small { font-size: 12.5px; margin-top: 6px; }
  .actions { display: flex; gap: 10px; margin-top: 18px; }
  .actions .btn { flex: 1; }
</style>
