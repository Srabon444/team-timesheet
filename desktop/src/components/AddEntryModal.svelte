<script>
  import { PROJECTS, CATEGORIES } from "../lib/constants.js";
  import { app, addEntry, updateEntry, startEntryTimer } from "../lib/store.svelte.js";

  // { date, entry|null (edit mode), startOnAdd } — parent controls visibility.
  let { date, entry = null, startOnAdd = false, onclose } = $props();

  let project = $state(entry ? entry.project : (app.data.lastProject || PROJECTS[0]));
  let category = $state(entry ? entry.category : (app.data.lastCategory || CATEGORIES[2]));
  let description = $state(entry ? entry.description : "");
  let error = $state("");

  function submit() {
    const desc = description.trim();
    if (!desc) {
      error = "Description is required.";
      return;
    }
    if (!PROJECTS.includes(project)) {
      error = "Pick a project from the list.";
      return;
    }
    if (entry) {
      updateEntry(date, entry.id, { project, category, description: desc });
    } else {
      const created = addEntry(date, { project, category, description: desc });
      if (startOnAdd) startEntryTimer(date, created.id);
    }
    onclose();
  }

  function onkeydown(e) {
    if (e.key === "Escape") onclose();
    if (e.key === "Enter" && e.target.tagName !== "SELECT") submit();
  }
</script>

<div class="overlay" role="dialog" onkeydown={onkeydown}>
  <div class="box">
    <h3>{entry ? "Edit task" : "Add task"}</h3>

    <label for="proj">Project</label>
    <input id="proj" list="projects" bind:value={project} placeholder="Type to search…" />
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

    {#if error}<p class="status-err">{error}</p>{/if}

    <div class="actions">
      <button class="btn" onclick={onclose}>Cancel</button>
      <button class="btn primary" onclick={submit}>
        {entry ? "Save changes" : startOnAdd ? "Add & start timer" : "Add task"}
      </button>
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
  .actions { display: flex; gap: 10px; margin-top: 18px; }
  .actions .btn { flex: 1; }
</style>
