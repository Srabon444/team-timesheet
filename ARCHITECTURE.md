# ARCHITECTURE — Chrome extension (master)

MV3 extension. Popup for daily tracking + a full-page tab view
(Dashboard/Settings). Auto-fills the Fillout timesheet across frames.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; permissions: storage, tabs, scripting; host perm for the Fillout origin. |
| `popup.js` | **The whole app.** Timer engine, storage, views, add/edit, day navigation, and the cross-frame form automation. Loaded by both `popup.html` and `tab.html`. |
| `popup.html` | Popup UI (setup view + main view). |
| `tab.html` + `tab.js` | Full-page view: reuses popup.js's globals for the "Today" panel, adds Dashboard (stats) and Settings panels. `tab.js` must not redeclare `$`/`S`. |
| `background.js` | Service worker: 1-minute alarm that checks the daily-limit and fires one OS notification per day (`warnedDate`). Reads `dailyLimitHours` from storage directly (separate realm). |
| `popup.css` / `tab.css` / `theme.css` | Styles + light/dark custom properties. |
| `test/smoke.js` | jsdom-driven smoke suite (no framework). `npm test`. |
| `test/fixtures/form.html` | Real captured form HTML (21 names) for `parseNames` tests. |
| `test/fixtures/subform.html` | Real captured "Create entry" subform HTML (19 projects, 5 categories) for `loadProjectsAndCategories` tests. |

## State (`S`, mirrors `chrome.storage.local`)

`init()` loads everything, applies the **daily reset**: if `S.date !==
todayStr()`, the outgoing day's `entries` are folded (running timer → accSec)
and archived into `history[S.date]`, then `entries` cleared and `date`
advanced. First-ever run (no prior `S.date`) skips archiving.

- `entries[]` — the live day (`S.date`). `history{date: entries[]}` — past days.
- `timer{activeId, startedAt}` — one running timer at a time; `foldActive()`
  credits elapsed into the entry's `accSec` and stops.
- `draft` — the in-progress add/edit form, persisted so it survives popup close.

## Day navigation (past-day entry)

`viewDate` (module global) selects which day the main view shows.
`isTodayView()` compares `viewDate === S.date` (NOT the wall clock, so it
stays correct across a rollover). `currentEntries()` → `S.entries` for the
live day, else `S.history[viewDate]`. `persistCurrent()` writes back to the
right place. The add form has an hrs/min select pair (the desktop app's picker) for back-filling past days
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

## Transfer

Settings (full view) → Backup & transfer: export = `{app,v,exportedAt,name,
days}` from `buildDaysMap()`; import replaces `entries`/`history` from the
same envelope. Same format the desktop app uses.

## Tests

`npm test` → `SMOKE: ALL PASS`. Harnesses cover: storage/daily-reset, timer
fold/switch, hh:mm math, searchable combobox, delete-confirm, cross-frame
automation against the real fixture, `parseNames`, colors, dashboard math,
background alarm/notification.
