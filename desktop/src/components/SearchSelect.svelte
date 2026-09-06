<script>
  // Type-to-filter picker for long lists. The name list is 20+ people, and a plain <select> means
  // scrolling for yours every time — the extension has had a search box on it for a while, this
  // is the same thing for the app.
  // { items, value, placeholder, disabled, onpick(value) }
  let { items = [], value = "", placeholder = "Type to search…", disabled = false, onpick } = $props();

  let query = $state("");
  let open = $state(false);
  let box;

  const matches = $derived(
    query.trim()
      ? items.filter((i) => i.toLowerCase().includes(query.trim().toLowerCase()))
      : items
  );

  function pick(v) {
    onpick?.(v);
    query = "";
    open = false;
  }

  function onkeydown(e) {
    if (e.key === "Escape") {
      open = false;
      query = "";
    } else if (e.key === "Enter" && open && matches.length) {
      e.preventDefault();
      pick(matches[0]);
    }
  }

  //! A plain on:blur closes the list before the click on a row lands, so the pick never fires.
  //! Closing only when focus leaves the whole widget avoids that without a timeout race.
  function onfocusout(e) {
    if (!box.contains(e.relatedTarget)) {
      open = false;
      query = "";
    }
  }
</script>

<div class="ss" bind:this={box} onfocusout={onfocusout}>
  <input
    type="text"
    autocomplete="off"
    {disabled}
    placeholder={value || placeholder}
    bind:value={query}
    onfocus={() => (open = true)}
    oninput={() => (open = true)}
    {onkeydown}
  />
  {#if open && !disabled}
    <div class="list">
      {#if matches.length === 0}
        <div class="none">No match</div>
      {:else}
        {#each matches as m}
          <button type="button" class="row" class:sel={m === value} onclick={() => pick(m)}>{m}</button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .ss { position: relative; width: 100%; }
  .ss input { width: 100%; box-sizing: border-box; }
  .list {
    position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px);
    max-height: 240px; overflow-y: auto;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius);
    box-shadow: var(--shadow-md);
  }
  .row {
    display: block; width: 100%; text-align: left;
    padding: 9px 12px; font-size: 13.5px;
    background: none; border: none; cursor: pointer; color: var(--text-primary);
  }
  .row:hover { background: var(--accent-tint); }
  .row.sel { color: var(--accent-light); font-weight: 600; }
  .none { padding: 9px 12px; font-size: 13px; color: var(--text-muted); }
</style>
