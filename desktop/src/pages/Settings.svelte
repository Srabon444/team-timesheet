<script>
  import { app, save, applyTheme, fetchNames, showConfirm } from "../lib/store.svelte.js";
  import { gdConnected, gdConnect, gdDisconnect, gdSync, gdBackupNow, gdListBackups, gdRestoreFile } from "../lib/gdrive.js";

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

  // ---- Backup / transfer (Task 1: manual export/paste bridge) ----
  // A small versioned envelope holding just the portable data (days + name).
  // Device-local bits (timer, theme, limit) stay out on purpose. The same
  // text pastes into the Chrome extension's Import box.
  const exportText = $derived(
    JSON.stringify(
      {
        app: "team-timesheet", v: 1, exportedAt: Date.now(), name: app.data.name,
        days: app.data.days, submittedDays: app.data.submittedDays,
      },
      null, 2
    )
  );
  let importText = $state("");
  let ioMsg = $state("");

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(exportText);
      ioMsg = "Copied to clipboard.";
    } catch {
      ioMsg = "Copy failed — select the text above and copy manually.";
    }
  }

  async function doImport() {
    ioMsg = "";
    let obj;
    try {
      obj = JSON.parse(importText);
    } catch {
      ioMsg = "That's not valid JSON.";
      return;
    }
    if (!obj || typeof obj.days !== "object" || obj.days === null) {
      ioMsg = "No 'days' data found in that text.";
      return;
    }
    const n = Object.keys(obj.days).length;
    const ok = await showConfirm(
      `Replace all tracked data with this import (${n} day${n === 1 ? "" : "s"})? Your current data is overwritten.`,
      "Yes, import"
    );
    if (!ok) return;
    app.data.days = obj.days;
    app.data.submittedDays = obj.submittedDays || {};
    if (obj.name && !app.data.name) app.data.name = obj.name;
    app.data.timer = { activeId: null, startedAt: null, date: null }; // never import a running timer
    save();
    importText = "";
    ioMsg = `Imported ${n} day${n === 1 ? "" : "s"}.`;
  }

  // ---- Google Drive sync & backup ----
  let gdBusy = $state(false);
  let gdMsg = $state("");
  let gdIsConnected = $state(false);
  let gdFiles = $state(null);

  async function gdRefresh() { gdIsConnected = await gdConnected(); }
  gdRefresh();

  async function gdDoConnect() {
    gdBusy = true; gdMsg = "Opening browser — approve access, then come back…";
    try { await gdConnect(); await gdRefresh(); gdMsg = await gdSync(true) || "Connected."; }
    catch (e) { gdMsg = e.message || String(e); }
    gdBusy = false;
  }
  async function gdDoDisconnect() {
    await gdDisconnect(); gdIsConnected = false; gdFiles = null; gdMsg = "Disconnected.";
  }
  async function gdDoSync() {
    gdBusy = true; gdMsg = "Syncing…";
    try { gdMsg = await gdSync(true) || "Done."; } catch (e) { gdMsg = e.message || String(e); await gdRefresh(); }
    gdBusy = false;
  }
  async function gdDoBackup() {
    gdBusy = true; gdMsg = "Backing up…";
    try { await gdBackupNow(); gdMsg = "Backed up to Google Drive ✓"; } catch (e) { gdMsg = e.message || String(e); await gdRefresh(); }
    gdBusy = false;
  }
  async function gdDoRestore() {
    gdBusy = true; gdMsg = "Loading backups…";
    try { gdFiles = await gdListBackups(); gdMsg = gdFiles.length ? `${gdFiles.length} backup(s) — pick one to restore.` : "No backups found in Drive."; }
    catch (e) { gdMsg = e.message || String(e); await gdRefresh(); }
    gdBusy = false;
  }
  async function gdPick(f) {
    if (!(await showConfirm(`Restore "${f.name}"? Current data is overwritten.`, "Yes, restore"))) return;
    gdBusy = true; gdMsg = `Restoring ${f.name}…`;
    try { await gdRestoreFile(f.id); gdFiles = null; gdMsg = `Restored from ${f.name} ✓`; }
    catch (e) { gdMsg = e.message || String(e); await gdRefresh(); }
    gdBusy = false;
  }

  async function resetEverything() {
    const ok = await showConfirm(
      "Delete all tasks, history, and settings? This cannot be undone. Your name is kept.",
      "Yes, reset"
    );
    if (!ok) return;
    const { name, names } = app.data;
    // Tombstone every entry that existed — otherwise a sync merge would just
    // pull them all back in from Drive/another device right after.
    const deletedEntries = { ...(app.data.deletedEntries || {}) };
    const now = Date.now();
    for (const list of Object.values(app.data.days)) for (const e of list) deletedEntries[e.id] = now;
    app.data.days = {};
    app.data.deletedEntries = deletedEntries;
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

<section>
  <h2>Backup &amp; transfer</h2>
  <p class="muted small">Export your tracked data, or paste a backup to restore it.
    The same text imports into the Chrome extension.</p>

  <div class="setlbl">Export</div>
  <textarea class="io" readonly rows="4" value={exportText}></textarea>
  <button class="btn" onclick={copyExport}>Copy to clipboard</button>

  <div class="setlbl mt">Import</div>
  <textarea class="io" rows="4" bind:value={importText} placeholder="Paste exported data here…"></textarea>
  <button class="btn primary" onclick={doImport} disabled={!importText.trim()}>Import</button>

  {#if ioMsg}<p class="muted small">{ioMsg}</p>{/if}
</section>

<section>
  <h2>Google Drive sync &amp; backup</h2>
  <p class="muted small">Sign in to sync this data across your devices (desktop, mobile, extension) on the
    same Google account — auto-syncs on open and after edits. Tasks added on any device (even while
    offline) are merged in, never overridden — nothing gets silently erased. Backups live in a "Team
    Timesheet Backups" folder in your own Drive.</p>

  <div class="gdbtns">
    {#if !gdIsConnected}
      <button class="btn" onclick={gdDoConnect} disabled={gdBusy}>Connect Google Drive</button>
    {:else}
      <button class="btn primary" onclick={gdDoSync} disabled={gdBusy}>Sync now</button>
      <button class="btn" onclick={gdDoBackup} disabled={gdBusy}>Back up now</button>
      <button class="btn" onclick={gdDoRestore} disabled={gdBusy}>Restore from Drive</button>
      <button class="btn" onclick={gdDoDisconnect} disabled={gdBusy}>Disconnect</button>
    {/if}
  </div>

  {#if gdFiles && gdFiles.length}
    <div class="gdlist">
      {#each gdFiles as f}
        <button class="gdfile" onclick={() => gdPick(f)} disabled={gdBusy}>
          <span class="gdname">{f.name}</span>
          <span class="gdwhen muted">{f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : ""}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if gdMsg}<p class="muted small">{gdMsg}</p>{/if}
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
  .setlbl.mt { margin-top: 16px; }
  .gdbtns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .gdlist { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; max-height: 280px; overflow-y: auto; }
  .gdfile {
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
    padding: 10px 12px; text-align: left; cursor: pointer;
    background: var(--bg-surface); border: 1px solid var(--border-color);
    border-radius: var(--radius); color: var(--text-primary); font-size: 13px;
  }
  .gdfile:hover { border-color: var(--accent); background: var(--accent-tint); }
  .gdname { font-weight: 600; font-variant-numeric: tabular-nums; }
  .gdwhen { font-size: 12px; white-space: nowrap; }
  .setdesc { font-size: 12.5px; margin-top: 3px; }
  .narrow { width: 130px; }
  .io {
    width: 100%; margin: 8px 0; padding: 10px 12px;
    background: var(--bg-surface); border: 1px solid var(--border-color);
    border-radius: 8px; color: var(--text-primary);
    font: 12px/1.4 ui-monospace, monospace; resize: vertical;
  }
  .io:focus { outline: none; border-color: var(--accent); }
  .toggle { width: 20px; height: 20px; accent-color: var(--accent); }
  .themes { display: flex; gap: 10px; }
  .danger { border: 1px solid var(--danger); border-radius: 10px; padding: 4px 16px; }
  .danger .setrow { border-bottom: none; }
</style>
