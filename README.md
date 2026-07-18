# Team Timesheet

Track time per project across **Chrome, Desktop (Windows/macOS/Linux), and
Android** — synced to your own Google Drive — and auto-fill the Techzu
**Daily Timesheet Form** (hosted on Fillout) so you're never retyping the
same entries into a web form by hand.

## Why

The form requires, for every project worked on that day: picking your name,
clicking "Create", selecting a project + work category, typing a task
description, and typing the time worked as `hh:mm` — then repeating that for
each project. This app replaces the manual repetition with: start a timer
when you begin a task, switch timers as you switch projects, and hit one
button at the end of the day to have it all filled in for you — **you always
review before the form's own final Submit is clicked**, the app never clicks
it for you.

## The three apps

One project, three products, sharing the same domain logic and data format
so they interoperate:

| App | Platform | Get it |
|---|---|---|
| **Chrome extension** | Any Chromium browser | Load unpacked from this repo (see below) |
| **Desktop app** | Windows · macOS · Linux | [Releases](../../releases) — installer per OS |
| **Android app** | Android (arm64) | [Releases](../../releases) — debug APK |

All three track the same 11 projects / 5 categories, run independent timers,
and drive the same Fillout automation. Desktop/Android releases are fully
automated — every push builds fresh installers and keeps only the latest.

## Features

- **Per-project timers** — start/pause, only one active at a time. Time is
  tracked as timestamps, so it survives closing the app or restarting the
  browser/device.
- **Previous-day entry** — back-fill or correct an earlier day's time, not
  just today's.
- **Final Submit automation** — drives the real Fillout form for you: selects
  your name, and for each project clicks *Create*, fills in the
  project/category/description/time, and submits *that* entry's subform. It
  never clicks the main form's own final Submit — that's always a manual,
  reviewed step. On Android, this runs headless (a direct API call, since
  there's no embedded browser window) but the same review-first spirit
  applies: you fill locally, then send.
- **Submission tracking** — the app detects when you've actually clicked the
  form's real Submit (a network signal on desktop, a DOM signal on the
  extension) and marks the day as submitted for reference, without disabling
  anything if the detection ever guesses wrong.
- **Google Drive sync & backup** — optionally sign in with Google to sync
  your tracked data across every device on the same account (desktop ↔
  mobile ↔ extension), auto-syncing on open and after edits. If two devices
  changed independently, you're asked which to keep. A rolling `latest`
  backup plus dated snapshots live in a private "Team Timesheet Backups"
  folder in *your own* Drive — nothing is stored on a server we run.
- **Manual export/import bridge** — copy-paste a JSON snapshot between any
  two installs without Google, if you'd rather not connect an account.
- **Dashboard** — a weekly chart, stat tiles (today / all-time / daily
  average / busiest day), and time breakdowns by project and category.
- **Daily limit notifications**, **dark/light/system theme**, and a
  **searchable name/project picker** instead of long dropdowns.

## Install

### Chrome extension
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the repo root (this checks out the `master`
   branch's root files).
3. Pin the extension for quick access.

### Desktop (Windows / macOS / Linux)
Download the latest installer for your OS from the [Releases](../../releases)
page (`.deb`/`.AppImage`, `.msi`/`.exe`, or `.dmg`) and install normally.
macOS builds are unsigned — right-click → Open the first time to bypass
Gatekeeper.

### Android
Download the debug APK from [Releases](../../releases) and install via
"unknown sources." Auto-fill runs headless (no browser window needed); Final
Submit posts your entries directly.

## Cross-device sync

Sign in with Google from any app's **Settings** to sync your tracked data
across all your devices on that same account:

- Data lives in **your own** Google Drive (`drive.file` scope — the app can
  only see files it created, nothing else in your Drive), in a "Team
  Timesheet Backups" folder.
- Syncs automatically when you open the app and shortly after you make
  changes; if two devices both changed since the last sync, you're asked
  which copy to keep.
- **Back up now** / **Restore from Drive** are also available manually if you
  want an on-demand snapshot or to roll back to an earlier one.
- This is entirely optional — everything works fully offline without it, and
  the manual copy-paste export/import bridge covers moving data between
  installs without a Google account.

## Repo structure

This repo hosts all three apps across branches, since desktop/Android need
OS-specific packaging and release workflows the extension doesn't:

| Branch | Contains |
|---|---|
| `master` | Chrome extension (root files) |
| `desktop-linux` | Desktop app (Tauri 2 + Svelte 5), Linux packaging |
| `desktop-windows` | Same app, Windows packaging |
| `desktop-mac` | Same app, macOS packaging |
| `desktop-android` | Same app, Android (Tauri mobile) packaging |

See [CLAUDE.md](CLAUDE.md) for the full branch/release model and shared
domain facts, [ARCHITECTURE.md](ARCHITECTURE.md) for the extension's internal
structure, and `desktop/ARCHITECTURE.md` (on the desktop branches) for the
desktop/Android app's.

## Development

```bash
# Extension (root, master)
npm test                       # node test/smoke.js (jsdom), must print "SMOKE: ALL PASS"

# Desktop / Android (desktop/ on desktop-* branches)
cd desktop
npm test                       # vitest
npm run tauri dev              # live desktop app
npm run tauri android dev      # live Android app (needs Android SDK/NDK)
```

Releases build automatically in CI on every push to a `desktop-*` branch
that touches `desktop/**` — see the branch/release model in
[CLAUDE.md](CLAUDE.md).
