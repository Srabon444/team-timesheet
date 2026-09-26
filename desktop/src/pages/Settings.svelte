<script>
  import { app, save, applyTheme, fetchNames, fetchProjectsAndCategories, showConfirm,
    restoreCandidates, restorePicked, resetEverything as resetAll } from "../lib/store.svelte.js";
  import { gdConnected, gdConnect, gdDisconnect, gdSync, gdBackupNow, gdListBackups, gdDownloadBackup } from "../lib/gdrive.js";
  import { TT, deviceName, readLog, listRecovery } from "../lib/activity.js";
  import RestorePicker from "../components/RestorePicker.svelte";
  import PrayerModal from "../components/PrayerModal.svelte";
  import SearchSelect from "../components/SearchSelect.svelte";

  let fetching = $state(false);
  let fetchMsg = $state("");

  //* Prayer setup reuses the same modal the Timer page opens — one config UI, two doors into it,
  //* rather than a second copy of the form to keep in step.
  let prayerOpen = $state(false);

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

  let fetchingPC = $state(false);
  let fetchPCMsg = $state("");

  async function loadProjectsAndCategories() {
    fetchingPC = true;
    fetchPCMsg = "";
    try {
      const { projects, categories } = await fetchProjectsAndCategories();
      fetchPCMsg = `Loaded ${projects.length} projects, ${categories.length} categories.`;
    } catch (e) {
      fetchPCMsg = `Error: ${e.message || e}`;
    }
    fetchingPC = false;
  }

  // ---- Backup / transfer (manual export/paste bridge) ----
  // The same sync envelope the Drive files use; pastes into the Chrome extension's Import box.
  // Device-local bits (timer, theme, limit) stay out on purpose.
  const exportText = $derived(
    JSON.stringify(TT.envelope(app.data, { name: app.data.name, deviceId: app.data.deviceId, deviceName: deviceName() }), null, 2)
  );

  // ---- Restore picker (Drive backups, paste import, recovery points) ----
  let picker = $state(null); // { cands, source, resolve }
  function pick(obj, source) {
    const cands = restoreCandidates(obj);
    if (!cands.length) return Promise.resolve({ none: true });
    return new Promise((resolve) => { picker = { cands, source, resolve }; });
  }
  function pickerDone(result) {
    const p = picker;
    picker = null;
    p.resolve(result);
    refreshRecoveryAndLog();
  }
  function restoreMessage(res, source) {
    if (res.none) return `Nothing missing — every task in ${source} is already here.`;
    if (res.cancelled) return "Restore cancelled.";
    return `Added ${res.added} task(s) back from ${source} ✓`;
  }

  // ---- Recovery points + activity log ----
  let recovery = $state([]);
  let log = $state([]);
  let recMsg = $state("");
  async function refreshRecoveryAndLog() {
    try { recovery = await listRecovery(); } catch { recovery = []; }
    try { log = (await readLog(300)).reverse(); } catch { log = []; }
  }
  refreshRecoveryAndLog();
  async function reviewRecovery(p) {
    const label = "the recovery point from " + new Date(p.at).toLocaleString();
    recMsg = restoreMessage(await pick(p.env, label), label);
  }
  function logText(ev) {
    const what = ev.entry || (ev.from ? `${ev.from} -> ${ev.to}` : "") || ev.reason || ev.detail || ev.status || ev.error || "";
    const extra = ["added", "removed", "changed", "tombstoned", "entries"].filter((k) => ev[k] !== undefined).map((k) => `${k}=${ev[k]}`).join(" ");
    return `${ev.t} [${ev.dev || "?"}] ${ev.type}${ev.date ? " " + ev.date : ""}${ev.source ? " (" + ev.source + ")" : ""} ${what}${ev.reason && ev.entry ? " — " + ev.reason : ""} ${extra}`.trim();
  }
  async function copyLog() {
    const text = JSON.stringify({ app: "team-timesheet", deviceId: app.data.deviceId, device: deviceName(), copiedAt: new Date().toISOString(), log: [...log].reverse() }, null, 1);
    try { await navigator.clipboard.writeText(text); recMsg = "Activity log copied — paste it into the issue."; }
    catch { recMsg = "Copy failed."; }
  }
  const legacySeen = $derived(!!app.data.gdLegacyClientAt && Date.now() - app.data.gdLegacyClientAt < 14 * 864e5);
  let resetWord = $state("");
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
    const res = await pick(obj, "the pasted data");
    ioMsg = restoreMessage(res, "the pasted data");
    if (res.added) importText = "";
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
    refreshRecoveryAndLog();
  }
  async function gdDoBackup() {
    gdBusy = true; gdMsg = "Backing up…";
    try { const wrote = await gdBackupNow(); gdMsg = wrote ? "Backed up to Google Drive ✓" : "Already up to date — nothing new to back up."; } catch (e) { gdMsg = e.message || String(e); await gdRefresh(); }
    gdBusy = false;
    refreshRecoveryAndLog();
  }
  async function gdDoRestore() {
    gdBusy = true; gdMsg = "Loading backups…";
    try { gdFiles = await gdListBackups(); gdMsg = gdFiles.length ? `${gdFiles.length} backup(s) — pick one to review what's missing.` : "No backups found in Drive."; }
    catch (e) { gdMsg = e.message || String(e); await gdRefresh(); }
    gdBusy = false;
  }
  async function gdPick(f) {
    gdBusy = true; gdMsg = `Reading ${f.name}…`;
    let obj = null;
    try { obj = await gdDownloadBackup(f.id); }
    catch (e) { gdMsg = e.message || String(e); await gdRefresh(); }
    gdBusy = false;
    if (!obj) return;
    const res = await pick(obj, f.name);
    gdMsg = restoreMessage(res, f.name);
    if (res.added) gdFiles = null;
  }

  async function resetEverything() {
    //! The typed word guards against the misclick that once wiped every device; checked here too,
    //! not only through the button's disabled state.
    if (resetWord.trim() !== "RESET") return;
    const ok = await showConfirm(
      "Delete all tasks, days, and settings on every synced device? Your name is kept, and a local recovery point is saved first.",
      "Yes, reset"
    );
    if (!ok) return;
    resetAll();
    resetWord = "";
    refreshRecoveryAndLog();
  }
</script>

<h1>Settings</h1>
<p class="muted">Stored locally — never leaves this machine.</p>

<section>
  <h2>Your name</h2>
  <div class="row-inline">
    <SearchSelect
      items={app.data.names}
      value={app.data.name}
      placeholder="Pick your name…"
      disabled={!app.data.names.length}
      onpick={(n) => { app.data.name = n; save(); }}
    />
    <button class="btn" onclick={loadNames} disabled={fetching}>
      {fetching ? "Fetching…" : app.data.names.length ? "Refresh names" : "Fetch names from form"}
    </button>
  </div>
  {#if fetchMsg}<p class="muted small">{fetchMsg}</p>{/if}
  <p class="muted small">Used to auto-select the Name field when submitting to Fillout.</p>
</section>

<section>
  <h2>Projects &amp; categories</h2>
  <div class="row-inline">
    <button class="btn" onclick={loadProjectsAndCategories} disabled={fetchingPC}>
      {fetchingPC ? "Fetching…" : "Fetch projects & categories"}
    </button>
  </div>
  {#if fetchPCMsg}<p class="muted small">{fetchPCMsg}</p>{/if}
  <p class="muted small">Re-fetches the live Project and Category lists from the form.</p>
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
  <p class="muted small">Export your tracked data, or paste a backup to add back tasks that are missing
    here — you pick each one. The same text imports into the Chrome extension.</p>

  <div class="setlbl">Export</div>
  <textarea class="io" readonly rows="4" value={exportText}></textarea>
  <button class="btn" onclick={copyExport}>Copy to clipboard</button>

  <div class="setlbl mt">Import</div>
  <textarea class="io" rows="4" bind:value={importText} placeholder="Paste exported data here…"></textarea>
  <button class="btn primary" onclick={doImport} disabled={!importText.trim()}>Review &amp; add missing</button>

  {#if ioMsg}<p class="muted small">{ioMsg}</p>{/if}
</section>

<section>
  <h2>Google Drive sync &amp; backup</h2>
  <p class="muted small">Sign in to sync this data across your devices (desktop, mobile, extension) on the
    same Google account — auto-syncs on open and after edits. Tasks added on any device (even while
    offline) are merged in, never overridden — nothing gets silently erased. Each device keeps its own
    copy plus dated snapshots in a "Team Timesheet Backups" folder in your own Drive; restoring one lets
    you pick which missing tasks to add back.</p>
  {#if legacySeen}
    <p class="warn small">A device on the old app version is still syncing to this account. Update the
      extension / desktop / mobile app on every device.</p>
  {/if}

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

<section>
  <h2>Prayer times</h2>
  <p class="muted small">A notification at each of the five daily prayers, with a short reminder.
    Times are fetched a month at a time and cached, so they keep working offline. Karachi method,
    Hanafi Asr.</p>
  <p class="muted small">
    {#if app.data.prayer?.enabled && app.data.prayer?.city}
      On — {app.data.prayer.city}{app.data.prayer.country ? ", " + app.data.prayer.country : ""}.
    {:else}
      Off.
    {/if}
  </p>
  <button class="btn" onclick={() => (prayerOpen = true)}>
    {app.data.prayer?.city ? "Change prayer times" : "Set up prayer times"}
  </button>
</section>

<section>
  <h2>Recovery &amp; activity log</h2>
  <p class="muted small">A recovery point is saved on this device before anything removes tasks (a sync,
    a restore, Reset). Pick one to add missing tasks back. The activity log records every add, edit,
    delete and sync with where it came from — copy it into a bug report.</p>
  {#if recovery.length}
    <div class="gdlist">
      {#each recovery as p}
        <button class="gdfile" onclick={() => reviewRecovery(p)}>
          <span class="gdname">{p.reason} ({TT.counts(p.env).entries} tasks)</span>
          <span class="gdwhen muted">{new Date(p.at).toLocaleString()}</span>
        </button>
      {/each}
    </div>
  {:else}
    <p class="muted small">No recovery points yet.</p>
  {/if}
  <pre class="io log">{log.length ? log.slice(0, 200).map(logText).join("\n") : "No activity recorded yet."}</pre>
  <button class="btn" onclick={copyLog}>Copy activity log</button>
  {#if recMsg}<p class="muted small">{recMsg}</p>{/if}
</section>

<section class="danger">
  <div class="setrow">
    <div>
      <div class="setlbl">Reset everything</div>
      <div class="setdesc muted">Deletes all tasks, days, and settings on every synced device. Your name is kept,
        and a recovery point is saved first. Type RESET to enable the button.</div>
    </div>
    <div class="resetbox">
      <input class="narrow" placeholder="Type RESET" bind:value={resetWord} />
      <button class="btn danger" onclick={resetEverything} disabled={resetWord.trim() !== "RESET"}>Reset</button>
    </div>
  </div>
</section>

{#if picker}
  <RestorePicker
    cands={picker.cands}
    source={picker.source}
    onapply={(picked) => pickerDone({ added: restorePicked(picked, picker.source) })}
    oncancel={() => pickerDone({ cancelled: true })}
  />
{/if}

{#if prayerOpen}
  <PrayerModal onclose={() => (prayerOpen = false)} />
{/if}

<style>
  section { max-width: 640px; margin-top: 26px; }
  .row-inline { display: flex; gap: 10px; align-items: center; }
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
  .danger .setrow { border-bottom: none; flex-wrap: wrap; }
  .resetbox { display: flex; gap: 8px; align-items: center; }
  .log { max-height: 240px; overflow: auto; white-space: pre-wrap; font-size: 11px; }
  .warn { color: var(--danger-light); }
</style>
