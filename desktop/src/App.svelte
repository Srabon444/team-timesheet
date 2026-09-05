<script>
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";
  import { app, nav, load } from "./lib/store.svelte.js";
  import { gdSync, gdSyncSoon, gdConnect } from "./lib/gdrive.js";
  import Confirm from "./components/Confirm.svelte";
  import Timer from "./pages/Timer.svelte";
  import Timesheet from "./pages/Timesheet.svelte";
  import Projects from "./pages/Projects.svelte";
  import Reports from "./pages/Reports.svelte";
  import Settings from "./pages/Settings.svelte";

  const win = getCurrentWindow();

  // load() awaits an async Tauri call (disk read) — run the initial sync
  // only after it actually lands. Firing gdSync(false) right alongside
  // load() (not awaited) meant it read app.data while it was still the
  // empty $state(defaults()) placeholder, comparing against the wrong data
  // on every single app open.
  load().then(() => gdSync(false).catch(() => {}));

  // Push local edits shortly after any change to days/submittedDays/
  // deletedEntries. gdSync merges rather than blindly overwriting, so the
  // debounced push is a no-op once both sides already agree.
  //
  // Skipping "the initial load" needs two guards, not one: load() replaces
  // `app.data` wholesale once its async read resolves, which re-triggers
  // this effect a SECOND time after its first (pre-load, still-default)
  // pass already spent the naive one-shot skip — that second pass is the
  // data actually landing, not a real edit, and shouldn't trigger a sync.
  let sawLoad = false;
  $effect(() => {
    JSON.stringify([app.data.days, app.data.submittedDays, app.data.deletedEntries]); // track deep changes
    if (!app.loaded) return; // pre-load pass — app.data is still the placeholder
    if (!sawLoad) { sawLoad = true; return; } // this run IS the load landing
    gdSyncSoon();
  });

  const NAV = [
    ["timer", "Timer", "⏱"],
    ["timesheet", "Timesheet", "☰"],
    ["projects", "Projects", "▦"],
    ["reports", "Reports", "▙"],
  ];

  // Dismissing just quiets the nag for this app session — someone whose
  // token is still dead gets reminded again next launch (gdSync(false) on
  // load re-fails and re-flags), but doesn't get nagged on every retry
  // in between. Never shown at all if they've simply never connected.
  let dismissed = $state(false);

//! Runs the consent flow directly; Settings is only the fallback. `reconnecting` guards a
//! double-click — gdrive_connect binds a loopback listener and blocks up to 5 minutes, so two in
//! flight means two listeners and two browser tabs.
  let reconnecting = $state(false);

  //* The opener plugin is already wired for the Google consent flow; its capability allow-list
  //* names this URL too, so no JS binding package is needed — the invoke bridge is enough.
  const DASHBOARD_URL = "https://timesheet-dashboard-seven.vercel.app/";
  const openDashboard = () =>
    invoke("plugin:opener|open_url", { url: DASHBOARD_URL }).catch(() => {});
  async function reconnectDrive() {
    if (reconnecting) return;
    reconnecting = true;
    try {
      await gdConnect();
    } catch {
      nav.page = "settings";
    } finally {
      reconnecting = false;
    }
  }
</script>

<div class="shell">
  <header class="titlebar" data-tauri-drag-region>
    <span class="titlebar-title" data-tauri-drag-region>Team Timesheet</span>
    <div class="winbtns">
      <button class="winbtn" onclick={() => win.minimize()} title="Minimize">–</button>
      <button class="winbtn" onclick={() => win.toggleMaximize()} title="Maximize">□</button>
      <button class="winbtn close" onclick={() => win.close()} title="Close">✕</button>
    </div>
  </header>

  {#if app.gdriveNeedsReconnect && !dismissed}
    <div class="gdrive-alert">
      <button class="gdrive-alert-msg" onclick={reconnectDrive} disabled={reconnecting}>
        {reconnecting ? "Opening Google sign-in…" : "⚠ Google Drive session expired — tap to reconnect"}
      </button>
      <button class="gdrive-alert-close" onclick={() => (dismissed = true)} title="Dismiss">✕</button>
    </div>
  {/if}

  <div class="body">
    <nav class="sidebar">
      <div class="brand">
        <span class="brand-mark">⏱</span>
        <span>Team Timesheet</span>
      </div>
      {#each NAV as [id, label, icon]}
        <button class="nav" class:active={nav.page === id} onclick={() => (nav.page = id)}>
          <span class="nav-icon">{icon}</span>{label}
        </button>
      {/each}
      <div class="spacer"></div>
      <button class="nav" onclick={openDashboard} title="Opens the team dashboard in your browser">
        <span class="nav-icon">▤</span>Team dashboard ↗
      </button>
      <button class="nav" class:active={nav.page === "settings"} onclick={() => (nav.page = "settings")}>
        <span class="nav-icon">⚙</span>Settings
      </button>
      <div class="you">
        <span class="you-avatar">{(app.data.name || "?")[0]}</span>
        <span class="you-name">{app.data.name || "No name set"}</span>
      </div>
    </nav>

    <main class="content">
      {#if app.loaded}
        {#if nav.page === "timer"}<Timer />{/if}
        {#if nav.page === "timesheet"}<Timesheet />{/if}
        {#if nav.page === "projects"}<Projects />{/if}
        {#if nav.page === "reports"}<Reports />{/if}
        {#if nav.page === "settings"}<Settings />{/if}
      {/if}
    </main>
  </div>

  <Confirm />
</div>

<style>
  .shell { display: flex; flex-direction: column; height: 100%; }
  .titlebar {
    height: 36px;
    flex: none;
    background: var(--bg-titlebar);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-left: 14px;
    border-bottom: 1px solid var(--border-color);
  }
  .titlebar-title { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
  .winbtns { display: flex; height: 100%; }
  .winbtn {
    width: 44px; height: 100%;
    border: none; background: none;
    color: var(--text-muted);
    font-size: 13px; cursor: pointer;
  }
  .winbtn:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
  .winbtn.close:hover { background: var(--danger); color: #fff; }

  .gdrive-alert {
    flex: none; width: 100%; display: flex; align-items: center;
    background: var(--danger); color: #fff;
  }
  .gdrive-alert-msg {
    flex: 1; border: none; cursor: pointer; background: none; color: inherit;
    font-size: 13px; font-weight: 600; padding: 8px 14px; text-align: center;
  }
  .gdrive-alert-msg:hover { filter: brightness(1.15); }
  .gdrive-alert-close {
    flex: none; border: none; cursor: pointer; background: none; color: inherit;
    font-size: 13px; padding: 8px 14px; opacity: .85;
  }
  .gdrive-alert-close:hover { opacity: 1; }

  .body { display: flex; flex: 1; min-height: 0; }
  .sidebar {
    width: 210px; flex: none;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border-color);
    display: flex; flex-direction: column;
    padding: 14px 10px;
    gap: 2px;
  }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; padding: 4px 10px 16px; }
  .brand-mark {
    width: 26px; height: 26px; border-radius: 7px;
    background: var(--accent); color: #fff;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 14px;
  }
  .nav {
    display: flex; align-items: center; gap: 10px;
    text-align: left; padding: 10px 12px;
    border-radius: 8px; border: none; background: none;
    color: var(--text-secondary); cursor: pointer; font-size: 14px;
  }
  .nav:hover { background: var(--bg-surface-hover); }
  .nav.active { background: var(--bg-surface-2); color: var(--text-primary); }
  .nav-icon { width: 18px; text-align: center; opacity: .8; }
  .spacer { flex: 1; }
  .you { display: flex; align-items: center; gap: 9px; padding: 12px 10px 4px; border-top: 1px solid var(--border-color); margin-top: 8px; }
  .you-avatar {
    width: 26px; height: 26px; border-radius: 50%;
    background: var(--accent); color: #fff;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700; text-transform: uppercase;
  }
  .you-name { font-size: 13px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .content { flex: 1; min-width: 0; overflow-y: auto; padding: 22px 26px; }

  /* Mobile / narrow (Android): no OS window chrome, sidebar becomes a
     horizontal top nav, content full width. Never triggers on desktop
     (min window width is 900px), so it's safe to carry on every branch. */
  @media (max-width: 640px) {
    .titlebar { display: none; }
    /* .titlebar is hidden above, so when this banner shows it becomes the
       topmost element — it needs the same status-bar clearance .sidebar
       gets below, or it renders flush at y=0, behind the phone's status
       bar (clock/battery icons) and unclickable there. */
    .gdrive-alert { padding-top: env(safe-area-inset-top); }
    .body { flex-direction: column; }
    .sidebar {
      width: 100%; flex-direction: row; align-items: center;
      overflow-x: auto; height: auto; gap: 4px;
      /* env() keeps the top nav clear of the phone's status bar / clock
         (needs viewport-fit=cover; 0 on desktop, so harmless). */
      padding: calc(8px + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) 8px calc(8px + env(safe-area-inset-left));
      border-right: none; border-bottom: 1px solid var(--border-color);
      position: sticky; top: 0; z-index: 20;
    }
    .brand, .spacer, .you { display: none; }
    .nav { flex: none; white-space: nowrap; padding: 10px 14px; font-size: 14.5px; }
    .content { padding: 16px 14px calc(16px + env(safe-area-inset-bottom)); }
  }
</style>
