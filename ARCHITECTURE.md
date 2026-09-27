# ARCHITECTURE — Chrome extension (master)

MV3 extension. Popup for daily tracking + a full-page tab view
(Dashboard/Settings). Auto-fills the Fillout timesheet across frames.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; permissions: storage, tabs, scripting; host perm for the Fillout origin. |
| `sync-core.js` | Sync v2 core (`TTCore`): stamps, merge, restore, envelopes, activity-log events, all Drive calls. **Byte-identical copy** in `desktop/src/lib/sync-core.js` on the desktop branches — change both together. |
| `data.js` | Data layer (`TTData`): `withData(fn)` = Web Lock `tt-data` + fresh `storage.get` + one `storage.set` of the changed keys. Rolls the day over, folds timers, keeps `ttLog` and `recoveryPoints`. Loaded by popup, tab and the service worker. |
| `gdrive.js` | Token + HTTP transport for `TTCore.sync`; `gdCommitRemote` merges Drive into fresh local data under the lock. |
| `popup.js` | Timer engine, views, add/edit, day navigation, and the cross-frame form automation. Every data change goes through `mutate(fn)` (→ `TTData.withData`). Loaded by both `popup.html` and `tab.html`. |
| `popup.html` | Popup UI (setup view + main view). |
| `tab.html` + `tab.js` | Full-page view: reuses popup.js's globals for the "Today" panel, adds Dashboard (stats) and Settings panels. `tab.js` must not redeclare `$`/`S`. |
| `background.js` | Service worker: 1-minute alarm that checks the daily-limit and fires one OS notification per day (`warnedDate`). Reads `dailyLimitHours` from storage directly (separate realm). Also writes the form tab's auto "submitted" mark (the form page can't take the data lock). |
| `popup.css` / `tab.css` / `theme.css` | Styles + light/dark custom properties. |
| `test/smoke.js` | jsdom-driven smoke suite (no framework). `npm test`. |
| `test/fixtures/form.html` | Real captured form HTML (21 names) for `parseNames` tests. |
| `test/fixtures/subform.html` | Real captured "Create entry" subform HTML (19 projects, 5 categories) for `loadProjectsAndCategories` tests. |

## State (`S` = read-only cache of `chrome.storage.local`)

Storage is the only source of truth. `S` is refreshed from `withData`'s
result and from `storage.onChanged` (other windows, the worker, a sync), and
is never written back wholesale. `TTData.toDoc` applies the **daily reset** on
every change: if the stored `date` isn't today, the running timer is folded
into its old-day entry and the live list moves under `history`.

- `entries[]` — the live day (`S.date`). `history{date: entries[]}` — past days.
- `timer{activeId, startedAt}` — one running timer at a time; `foldActive()`
  credits elapsed into the entry's `accSec` and stops.
- `draft` — the in-progress add/edit form, persisted so it survives popup close.

## Day navigation (past-day entry)

`viewDate` (module global) selects which day the main view shows.
`isTodayView()` compares `viewDate === S.date` (NOT the wall clock, so it
stays correct across a rollover). `currentEntries()` → `S.entries` for the
live day, else `S.history[viewDate]`. Writes go through `mutate(fn)` against
`d.days[viewDate]`, so any day is written the same way. The add form has an hrs/min select pair (the desktop app's picker) for back-filling past days
(which have no live timer, so their play button is hidden). Nav controls:
`dayPrev/dayNext/viewDateInput/todayBtn`, clamped to `<= S.date`.

## Form automation (the delicate part)

Orchestrated from the popup (`fillFormOnPage`), alternating
`chrome.scripting.executeScript` between the top frame and the discovered
subform frame:

1. `ensureFormTab()` — open/focus the form tab, `waitTabComplete`, then
   **reload via the `onUpdated` event** (not a `tabs.get().status` poll — a
   poll can read a stale "complete" and run automation against a
   about-to-be-torn-down page, losing the Name selection), then
   `waitForFormReady` (poll `pageFormReady`, React can take 1.3s+).
2. `pageSelectName` (top frame) — skip if already set.
3. Per entry: `pageClickCreate` → `waitForSubframe` (probe `allFrames` for
   `input[placeholder="Task Description"]`) → `frameFillEntry` in that
   frameId (react-select Project/Category, native-setter Description/Time,
   click the iframe's own Submit) → `waitForSubframeGone` →
   `waitForEntryVisible` (entries-list race).
4. `finalSubmit` marks the successfully-added entries `submitted`. Operates
   on `currentEntries()`, so a past day can be filled too (with a reminder
   to set the form's Date field first). On success it also fires a dated
   Drive backup (`gdBackupNow`, fire-and-forget, errors swallowed) — captures
   the moment those entries got marked submitted. Skipped entirely if
   nothing new was added (re-clicking with everything already submitted).

## Projects & categories loading

Same idea as Name loading, but sourced from the "Create entry" **subform**
(`SUBFORM_URL`) rather than the main form — Project/Category live there, not
on the main page's `__NEXT_DATA__`. `parseDropdownOptions(html, fieldName)`
generalizes the old `parseNames`-only walk; `parseNames` is now a thin sorted
wrapper over it. Project/Category are deliberately **not** alphabetized —
they're kept in the form's native order, which ends with a catch-all
"Others" that would otherwise get shuffled into the middle. Settings' "Fetch
projects & categories" button (`loadProjectsAndCategories`) overwrites
`S.projects`/`S.categories`; `currentProjects()`/`currentCategories()` prefer
those over the `DEFAULT_PROJECTS`/`DEFAULT_CATEGORIES` fallback consts, which
now exist only so the app has something to show before the first fetch.

## Sync v2 (issue #2)

- **Entries** carry `updatedAt`/`updatedBy` from a hybrid logical clock
  (`TTCore.touch`); the newest version wins a merge. **Deletes** are
  `deletedEntries{id: at}` (+ `deletedBy`); an entry is live only if updated
  after its tombstone, so a restore (fresh stamp) beats an old delete.
  **Unmark** is a stamped `{method:null}`. The merge is commutative,
  associative and idempotent (fuzz-tested in harness 7).
- **Drive**: each device writes only `device-<deviceId>.json` and reads every
  device file (in every "Team Timesheet Backups" folder), so concurrent syncs
  can't overwrite each other. `timesheet-latest.json` is still written as a
  compatibility mirror for old clients; an old client writing it sets
  `gdLegacyClientAt` (Settings warns). Dated snapshots carry a device suffix.
- **Sync order**: lock `tt-sync` → network → `withData(gdCommitRemote)` merges
  into *fresh* storage → write own device file → dashboard ingest. An edit
  made mid-sync is in that fresh read, so it survives.
- **Safety net**: a recovery point (`recoveryPoints`, last 10) before Reset,
  a restore, or a sync that removes entries; `ttLog` (last 500 events) records
  every add/edit/delete/sync with the source device. Settings → Recovery &
  activity log lists both; "Copy activity log" for bug reports.

## Transfer / restore

Settings → Backup & transfer: export = the v2 envelope. Paste-import, Drive
restore and recovery points all open the **restore picker**: only tasks
missing now are listed, each ticked ✓ (add back) or ✗ (leave out); nothing
present is removed or overwritten. Reset needs "RESET" typed.

## Tests

`npm test` → `SMOKE: ALL PASS` (exit 1 with "DID NOT FINISH" if a harness
hangs). Harnesses cover: storage/daily-reset, timer fold/switch, hh:mm math,
searchable combobox, delete-confirm, cross-frame automation against the real
fixture, `parseNames`, colors, dashboard math, background alarm/notification,
the sync core (7), two windows on one storage (8), and multi-device sync
against an in-memory Drive (14) plus the restore picker (15).
