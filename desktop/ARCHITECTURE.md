# ARCHITECTURE — desktop app (`desktop/`)

Tauri 2 (Rust shell) + Svelte 5 (runes) front end. Trackabi-style time
tracker; **Final Submit** opens the Fillout form in an in-app window and
auto-fills it. Same domain + automation as the Chrome extension — see the
repo-root [ARCHITECTURE.md](../ARCHITECTURE.md) and
[CLAUDE.md](../CLAUDE.md).

## Layout

```
desktop/
  src/
    App.svelte              custom titlebar (drag/min/max/close) + sidebar nav
    app.css                 theme vars (dark/light); select appearance:none fix
    lib/
      store.svelte.js       central runes state ($state app{}), persistence,
                            timer/entry actions, submit flow, fill-status listener,
                            nav{page,jumpDate}, submittedDays helpers
      timer.js              pure timer engine (fold/start/pause/edit, rollover);
                            stamps every entry change (TTCore.touch)
      sync-core.js          sync v2 core (TTCore) — BYTE-IDENTICAL to the
                            extension's root sync-core.js; change both together
      gdrive.js             Drive transport + atomic local commit for TTCore.sync
      activity.js           activity log + recovery points (Rust files)
      time.js stats.js      pure date + dashboard math (ported from extension)
      constants.js          DEFAULT_PROJECTS/DEFAULT_CATEGORIES (pre-fetch
                            fallback) + color maps + FORM_URL/SUBFORM_URL
      names.js              parseDropdownOptions(__NEXT_DATA__, fieldName);
                            parseNames() = sorted "Name" wrapper
      fillout-inject.js     buildFillScript(): the whole injected automation as
                            one stringified IIFE
    components/
      AddEntryModal.svelte  add/edit (Project→Category, hrs/min picker, presets)
      Confirm.svelte        promise-based confirm, per-action Yes label
      RestorePicker.svelte  restore/import: missing tasks, each ✓ add / ✗ skip
    pages/
      Timer.svelte          big timer + hover quick-add menu, day strip, entry
                            rows, Summary (+ submit panel + submission status)
      Timesheet.svelte      week list; day rows click → jump to that day in Timer
      Projects.svelte Reports.svelte Settings.svelte
  src-tauri/
    src/lib.rs              commands + Fillout window + title-poll bridge;
                            single-instance plugin on desktop targets
    src/storage.rs          data.json (atomic write, .bak, corrupt fallback),
                            activity.log, recovery/ (cargo test)
    tauri.conf.json         window config; bundle.targets differ per branch
  tests/                    vitest; sync-v2.test.js = multi-device + persistence
```

## State & persistence

`store.svelte.js` holds `export const app = $state({ data, loaded, now, fill,
confirm })`. `data` is persisted to `app_data_dir/data.json` via the Rust
`load_data`/`save_data` commands. `save()` writes immediately and serialized
(no debounce — a debounce lost the last edit when the app closed); a failed
save sets `app.saveError` (banner). `load_data` returns `data.json.bak` when
`data.json` is torn (copying the bad file aside); an unreadable (locked) file
sets `app.saveBlocked` so it is never saved over. `now` is a 1s tick so
timer displays stay live; the same tick runs `rolloverIfNeeded` and the
daily-limit notification. `nav{page,jumpDate}` drives sidebar routing +
cross-page day jumps.

Data: `days{date: entries[]}`, `timer{activeId, startedAt, date}`,
`submittedDays{date:{at,method|null,by}}`, `deletedEntries`/`deletedBy`,
`clock`, `deviceId`, plus scalar settings. Entry: `{id, project, category,
description, accSec, submitted, updatedAt, updatedBy}`. The sync model (per-device
Drive files, stamped merge, tombstones, restore picker, recovery points, activity
log) is the extension's — see "Sync v2" in [../ARCHITECTURE.md](../ARCHITECTURE.md)
on `master`. Desktop specifics: `gdSync` calls are chained (one at a time) and
`commitRemote` merges into `app.data` synchronously, after all network calls.

`projects[]`/`categories[]` start empty; Settings' "Fetch projects &
categories" (`fetchProjectsAndCategories`) fills them from the live
`SUBFORM_URL` form (same idea as `fetchNames`, but the "Create entry"
subform, not the main form). `currentProjects()`/`currentCategories()` —
used everywhere a project/category list is needed (`Timer.svelte`,
`AddEntryModal.svelte`, `Projects.svelte`) — prefer these over
`DEFAULT_PROJECTS`/`DEFAULT_CATEGORIES`, which now exist only as the
pre-first-fetch fallback.

## Fillout automation (Final Submit)

1. `submitToFillout(date)` builds a payload from that day's entries (always a
   full resync — the injected script clears the form's existing entries
   first) and calls the Rust `open_fillout(url, script)`.
2. `lib.rs` opens/navigates the `"fillout"` WebviewWindow and stores the job.
   `on_page_load` runs the **reload-first** sequence (first load → visible
   reload; second load → inject the script), then starts the title poll.
3. `fillout-inject.js` runs in the form's top frame; the "Create" subform is
   a **same-origin iframe**, reached directly via `iframe.contentDocument`
   (no frame IDs — cross-realm rule: use the iframe window's own value
   setters / Event constructors). It selects Name, clears existing rows,
   fills each entry via react-select + native setters, clicks the iframe's
   own Submit, respects the entries-list race, then keeps watching for a
   **real submission** (success page) to auto-record it.
4. Progress crosses the origin boundary via `document.title` = `TT_STATE:{…}`.
   The injected script can't use Tauri IPC (remote origin), so `lib.rs` polls
   the title and re-emits it as a `fill-status` event to the main window.
   **Title reads are marshaled to the main thread** (`run_on_main_thread`) —
   reading WebView2's title off-thread froze the app on Windows 11. The poll
   does not stop on `done` (keeps watching ~30 min for the real submit),
   stops on `submittedConfirmed`/error/window-closed, and dedupes emits.
5. A successful run (webview `s.done` with `s.added > 0`, or mobile's headless
   `submitHeadless`) also fires a dated Drive backup (`gdBackupNow`,
   fire-and-forget, errors swallowed) — captures the moment those entries got
   marked submitted, separate from the debounced merge-sync App.svelte's
   `$effect` already fires on any `app.data` change.

## Packaging / release

`tauri.conf.json` `bundle.targets` differ per branch (deb+appimage / msi+nsis
/ dmg+app / apk). Each branch's `.github/workflows/release-<os>.yml` is
push-triggered, builds on the matching runner, publishes `v0.0.<run_number>`,
and prunes older releases for that OS. See [../CLAUDE.md](../CLAUDE.md).

## Tests

`npm test` (vitest) covers time/stats/timer/parseNames/parseDropdownOptions/
colors, `buildFillScript` validity + payload escaping, the sync merge, and
multi-device sync + persistence safety (`sync-v2.test.js`, in-memory Drive).
`cd src-tauri && cargo test --lib storage` covers atomic save / corrupt load.
No headless Fillout run here — the automation is verified live.
