# Dashboard + Tab View — Design

## Context

The extension currently only works from the popup: a small, transient window
good for quick timer control but cramped for reviewing history or changing
settings. The user saw a personal time-tracking app ("DLog") with a full-page
sidebar-nav layout — Today / Dashboard / Settings — and wants the equivalent
here, controllable from a normal browser tab in addition to the existing
popup, both operating on the same live data.

Goal: add a tab-accessible view with a Dashboard (weekly chart + stats) and a
Settings page (daily hour limit + warning, confirm-before-delete, theme,
reset-everything), while leaving the popup exactly as it is today except for
one link to open the tab.

## Architecture

**Code sharing — Approach A (shared include), chosen over duplicating logic
into a second file.** `popup.js` stays completely unmodified except for the
data-model additions below; `tab.html` includes it verbatim as the engine
for its Today section (timers, entry CRUD, searchable pickers, Final Submit
automation), reusing the exact same element IDs as `popup.html`'s main view
so `popup.js`'s existing `render()`/`refreshAddForm()`/etc. work unchanged
against either document. `tab.js` loads on top and owns everything popup.js
doesn't: sidebar nav, Dashboard rendering, and the Settings-only controls.

Rationale: the timer engine, storage model, and cross-frame form automation
are the most carefully verified parts of this codebase (extensive smoke-test
coverage, live verification against the real form). Duplicating that logic
into a second file risks drift and re-introduces bugs already fixed once.
Reuse keeps a single source of truth.

```
manifest.json
background.js        # unchanged responsibilities + daily-limit notification check
popup.html/css/js     # unchanged (popup.js gains history-archive + new settings fields only)
tab.html               # new: sidebar + Today (popup.js's markup, reused) + Dashboard + Settings
tab.js                 # new: nav, Dashboard rendering, Settings-only wiring
theme.css               # new: CSS custom properties, dark (default) + light overrides
```

## Data model additions

All still in `chrome.storage.local`, alongside the existing `entries`,
`timer`, `draft`, `name`, `names`, `lastProject`, `lastCategory`, `date`.

```
history: { "2026-07-09": [ {id, project, category, description, accSec}, ... ], ... }
dailyLimitHours: 8            // default
confirmBeforeDelete: true      // default
theme: "dark"                  // "dark" | "light" | "system", default "dark"
warnedDate: null               // internal: last date the limit-notification fired
```

**History archiving** happens in `popup.js`'s existing daily-reset block
(`init()`), which already detects `stored.date !== today`. Before clearing
`S.entries`, if there are any, fold any active timer to its final `accSec`
(same as `finalSubmit` already does) and write them into
`history[oldDate]`. This fires the first time *either* the popup or the tab
is opened on a new day — single code path, no duplication. Kept forever; no
pruning UI (not requested, and the data is small — negligible against
`chrome.storage.local`'s quota even after years).

## Tab layout (`tab.html` + `tab.js`)

Sidebar: **Today**, **Dashboard**, **Settings** — client-side show/hide of
three `<section>`s, no routing needed (matches the existing no-build-step,
zero-dependency approach).

**Today** — literally `popup.html`'s existing main-view markup (add-project
form, entries list, Final Submit), same IDs, driven entirely by the
unmodified `popup.js`. If no name is set yet, instead of duplicating the
setup/name-picker flow a second time, this section shows a short prompt with
a button that switches the sidebar to Settings, where the one canonical
name-picker lives.

**Dashboard**:
- Weekly bar chart, Mon–Sun, with `<` `>` navigation between weeks (matches
  the screenshot's week browser). Hand-rolled SVG/DOM bars — no charting
  library; consistent with the rest of the project's zero-dependency,
  no-build-step approach. Colors and palette decided at build time via the
  dataviz skill.
- Stat tiles — **Today**, **Tracked Total**, **Daily Average**, **Busiest
  Day** — computed from the full `history` log plus today's live `entries`,
  independent of whatever week the chart is currently showing (all-time).
  `Tracked Total` = sum of every entry's `accSec` across all days. `Daily
  Average` = `Tracked Total` ÷ number of *active* days (days with at least
  one entry, not every calendar day since first use — matches DLog's "across
  active days" label). `Busiest Day` = the single day with the highest
  summed `accSec`; ties broken by most-recent date.
- **By project** and **by category** breakdowns (also all-time), reusing the
  fixed `PROJECTS`/`CATEGORIES` lists already in `popup.js` — these are not
  user-editable the way DLog's topics are, since they must match the real
  form's dropdown options.

**Settings**:
- Name — the one searchable name-picker (reused component), plus a "change"
  affordance.
- Daily limit — dropdown (e.g. 4h/6h/8h/10h), stored as `dailyLimitHours`.
- Confirm before delete — toggle, stored as `confirmBeforeDelete`.
- Theme — Dark/Light/System buttons, stored as `theme`, applied via a
  `data-theme` attribute + `theme.css` custom properties, consumed by both
  `popup.css` and `tab.css`.
- Reset everything — danger button (tab-only, deliberately **not** exposed
  in the small popup to avoid a fat-finger destructive click). Clears
  `entries`, `history`, `timer`, `draft`, `lastProject`, `lastCategory`, and
  resets the three settings above to their defaults. Keeps `name`/`names`.
  Confirmed via the existing custom confirm modal (danger styling) — never
  the browser's native `confirm()`, consistent with why that was replaced
  earlier for Final Submit.

## Daily limit notification

Computed in `background.js`, which already reacts to `chrome.storage.onChanged`
for the toolbar badge — natural place to add this too, since it already
recomputes on every entries/timer change. On each change: sum today's
elapsed time across `entries` (folding the active timer's live elapsed the
same way the badge does); if the sum crosses `dailyLimitHours * 3600` and
`warnedDate` isn't today, fire a real OS notification via
`chrome.notifications.create` (new permission needed in `manifest.json`) and
set `warnedDate` to today. Once-per-day by construction — resets naturally
via the existing daily-reset path clearing/updating `date`.

## Confirm-before-delete

`deleteEntry(id)` (in `popup.js`, shared by both surfaces) checks the new
`confirmBeforeDelete` setting; if true, awaits the existing `showConfirm()`
modal before proceeding. Same function, same behavior in popup and tab —
no duplicated delete logic.

## Popup changes

Unchanged except one small link/button: "Open full view ⤢", which does
`chrome.tabs.create({ url: chrome.runtime.getURL("tab.html") })` (or focuses
an already-open tab.html tab if one exists, same pattern as `ensureFormTab`
uses for the live form tab).

## Testing

Extends the existing Node/jsdom smoke-test approach (no new tooling):
- History archiving: simulate a date rollover with existing entries present,
  assert `history[oldDate]` matches what was there and `entries` clears.
- Daily-limit notification: extend `background.js`'s harness (already mocks
  `chrome.storage`/`chrome.alarms`) with a mocked `chrome.notifications`,
  assert it fires once when crossing the limit and not again same day.
- Confirm-before-delete: assert `deleteEntry` shows the modal when the
  setting is on and skips it when off, reusing the existing confirm-modal
  test pattern from Final Submit.
- Dashboard math (weekly totals, busiest day, by-project/by-category sums):
  pure-function unit checks against a synthetic `history` fixture, same
  style as the existing timer-math self-check.
- Reset everything: assert every listed key clears/resets and `name`/`names`
  survive.
