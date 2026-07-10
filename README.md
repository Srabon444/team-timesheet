# Daily Timesheet Auto-Filler

A Chrome extension that turns filling out the Techzu **Daily Timesheet Form**
(hosted on Fillout) into a popup with per-project timers, then automates
entering that data into the live form for you — stopping right before the
form's own final Submit so you always review before sending.

## Why

The form requires, for every project worked on that day: picking your name,
clicking "Create", selecting a project + work category, typing a task
description, and typing the time worked as `hh:mm` — then repeating that for
each project. This extension replaces the manual repetition with: start a
timer when you begin a task, switch timers as you switch projects, and hit
one button at the end of the day to have it all typed in for you.

## Features

- **Per-project timers** — start/pause, only one active at a time (starting
  one automatically pauses whichever was running). Elapsed time is tracked as
  timestamps in storage, so it survives closing the popup or restarting the
  browser.
- **Toolbar badge** — shows live elapsed time (`23m`, `2h`) with a green/gray
  background so you can tell at a glance whether a timer is running without
  opening the popup. Hover the icon for the exact `hh:mm:ss` and project name.
- **Searchable pickers** — your name (21 people) and the project list are
  typeahead comboboxes (substring search, click or Enter to pick), not a
  plain dropdown you have to scroll.
- **Add / Edit / Delete** project entries for the day, each with an editable
  `hh:mm` time.
- **Daily reset** — switching to a new date clears the day's project entries
  and timers automatically, but remembers your name and your last-used
  project/category as defaults.
- **Draft persistence** — a half-filled "add project" form (or an in-progress
  edit) survives closing the popup, so switching tabs mid-entry doesn't lose
  your typing.
- **Final Submit automation** — drives the real Fillout form: opens/focuses
  the tab, selects your name, and for each project clicks *Create*, fills in
  the project/category/description/time inside the form's own popup subform,
  and clicks *that* subform's Submit to add the entry. It **never** clicks
  the main form's final Submit button — you always do that manually after
  reviewing the entries.

## Tech used

- **Manifest V3** Chrome extension — no build step, no bundler, no
  dependencies. Plain HTML/CSS/JS.
- `chrome.storage.local` for all state (timers, entries, name, drafts).
- `chrome.scripting.executeScript` for page automation, including
  **cross-frame** injection (`allFrames` + discovered `frameIds`) — the
  form's "Create" button opens the project/category/description/time fields
  inside a genuine `<iframe>` subform, a separate document from the main
  page, so automation has to run there directly rather than in the top frame.
- `chrome.alarms` + `chrome.storage.onChanged` in a background service worker
  to keep the toolbar badge live even while the popup is closed, without
  polling.
- The live form's dropdowns are [react-select](https://react-select.com/);
  automation drives them by setting the input value and dispatching a
  synthetic `Enter` keydown, the same way typing-to-search and pressing Enter
  works for a human user.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension for quick access to the timer badge.

## Use

1. **First run**: click the extension icon → **Load names from form** → pick
   your name from the list → **Save**.
2. **Add a project**: pick a project and work category (both searchable —
   just start typing), enter a task description (required), click
   **+ Add Project**.
3. **Track time**: click the ▶ on a project to start its timer, ❚❚ to pause.
   Only one timer runs at a time. Edit the `hh:mm` field directly if you need
   to correct it.
4. Add more projects throughout the day as needed. Use **Edit** on an entry
   to change its project/category/description without losing its tracked
   time.
5. **End of day**: click the red **Final Submit** button, review the
   confirmation, confirm. The extension opens the form (or reuses an already
   open tab), selects your name, and adds every entry for you.
6. **You still click the form's own Submit yourself** after reviewing the
   entries it added — the extension deliberately never does this for you.

On a new date, the previous day's entries and timers clear automatically;
your name and last-used project/category stay as defaults.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension configuration (MV3) |
| `popup.html` / `popup.css` | Popup UI |
| `popup.js` | All popup logic: storage, timers, UI, search comboboxes, and the form-filling automation |
| `background.js` | Service worker — keeps the toolbar badge in sync with the running timer |
| `icons/` | Extension icon |
