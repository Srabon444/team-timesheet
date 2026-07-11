# Team Timesheet — Desktop App

Trackabi-style desktop time tracker (Tauri v2 + Svelte 5) with one extra
trick: **Final Submit** opens the Techzu Fillout timesheet form in an app
window and auto-fills every tracked entry — then stops, leaving the form's
own Submit button for you to click after review.

Shares its brain with the Chrome extension in the repo root: the timer
engine, stats math, name parsing, color coding, and the form-automation
logic are direct ports of that battle-tested code.

## Branches

| Branch | OS | Installers | Release tag |
|---|---|---|---|
| `desktop-linux` | Linux | `.deb`, `.AppImage` | `linux-v*` |
| `desktop-windows` | Windows | `.msi`, NSIS `.exe` | `windows-v*` |
| `desktop-mac` | macOS | `.dmg`, `.app` | `macos-v*` |

Same app code everywhere; the branches differ only in bundle targets and CI.
Fixes land on `desktop-linux` and get merged into the other two.
Pushing a matching tag builds installers on the right OS runner via GitHub
Actions and attaches them to a GitHub Release.

## Features

- **Timer page** — day strip (7 days, browse with ‹ ›, per-day totals), big
  live header timer, per-entry play/pause (one timer at a time; starting one
  pauses the other), inline `hh:mm` editing, add/edit/delete with confirm.
- **Summary tab** — per-category totals + the Submit-to-Fillout panel:
  pick your name (fetched from the form itself), see the day's entries,
  one button to auto-fill them all. Already-submitted entries are marked
  and never re-sent.
- **Timesheet** — browse any week, day by day.
- **Projects** — the form's 11 fixed projects, color coded, all-time totals.
- **Reports** — weekly bar chart, stat tiles (today / total / daily average /
  busiest day), by-project and by-category breakdowns.
- **Settings** — name, daily hour limit (one OS notification when crossed),
  confirm-before-delete, Dark/Light/System theme, reset (keeps your name).
- Draggable frameless window with custom titlebar; resizable; state stored
  in `data.json` under the app data dir (timers survive restarts — they're
  timestamps, not counters).

## Develop (Linux)

```bash
# one-time
sudo apt install -y build-essential pkg-config libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

cd desktop
npm install
npm test          # Vitest — logic ported from the extension's suite
npm run tauri dev # live app
./build-linux.sh  # .deb + .AppImage
```

## How the auto-fill works

The Fillout form is opened in a second app window. After it fully loads it
is reloaded once (visibly — this sequencing fixed real half-hydration
failures in the extension), then a script is injected that:

1. waits for the form to be interactive,
2. selects your Name via react-select's own type-and-Enter search
   (skipped if already selected),
3. for each unsubmitted entry: clicks **Create**, fills Project, Category,
   Description, and Time inside the entry-form iframe (same origin —
   reached via `contentDocument`, using the iframe realm's prototypes), and
   clicks **that iframe's Submit only**,
4. reports progress back through `document.title`, which the Rust side
   polls and relays to the main window.

The main form's final Submit is **never** clicked by the app.
