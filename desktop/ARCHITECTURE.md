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
      timer.js              pure timer engine (fold/start/pause/edit, rollover)
      time.js stats.js      pure date + dashboard math (ported from extension)
      constants.js          PROJECTS/CATEGORIES + color maps
      names.js              parseNames(__NEXT_DATA__)
      fillout-inject.js     buildFillScript(): the whole injected automation as
                            one stringified IIFE
    components/
      AddEntryModal.svelte  add/edit (Project→Category, hrs/min picker, presets)
      Confirm.svelte        promise-based confirm, per-action Yes label
    pages/
      Timer.svelte          big timer + hover quick-add menu, day strip, entry
                            rows, Summary (+ submit panel + submission status)
      Timesheet.svelte      week list; day rows click → jump to that day in Timer
      Projects.svelte Reports.svelte Settings.svelte
  src-tauri/
    src/lib.rs              commands + Fillout window + title-poll bridge
    tauri.conf.json         window config; bundle.targets differ per branch
  tests/lib.test.js         vitest (24)
```

## State & persistence

`store.svelte.js` holds `export const app = $state({ data, loaded, now, fill,
confirm })`. `data` is persisted to `app_data_dir/data.json` via the Rust
`load_data`/`save_data` commands (debounced `save()`). `now` is a 1s tick so
timer displays stay live; the same tick runs `rolloverIfNeeded` and the
daily-limit notification. `nav{page,jumpDate}` drives sidebar routing +
cross-page day jumps.

Data: `days{date: entries[]}`, `timer{activeId, startedAt, date}`,
`submittedDays{date:{at,method}}` (show-only), plus scalar settings. Entry:
`{id, project, category, description, accSec, submitted}`.

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

## Packaging / release

`tauri.conf.json` `bundle.targets` differ per branch (deb+appimage / msi+nsis
/ dmg+app / apk). Each branch's `.github/workflows/release-<os>.yml` is
push-triggered, builds on the matching runner, publishes `v0.0.<run_number>`,
and prunes older releases for that OS. See [../CLAUDE.md](../CLAUDE.md).

## Tests

`npm test` (vitest, 24) covers time/stats/timer/parseNames/colors and
`buildFillScript` validity + payload escaping. `cargo check` for the Rust.
No headless Fillout run here — the automation is verified live.
