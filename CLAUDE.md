# CLAUDE.md — repo map & working notes

Two products in one repo, both track daily per-project time and auto-fill the
Techzu **Fillout** timesheet form (`https://techzu.fillout.com/t/uhz6TddCX2us`):

| Product | Lives on | Stack | Detail doc |
|---|---|---|---|
| Chrome extension | `master` (root files) | vanilla JS, MV3 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Desktop app (Linux/Win/mac) | `desktop-linux` / `desktop-windows` / `desktop-mac` (in `desktop/`) | Tauri 2 + Svelte 5 | [desktop/ARCHITECTURE.md](desktop/ARCHITECTURE.md) |
| Android app | `desktop-android` (in `desktop/`) | Tauri 2 mobile | same as desktop |

Desktop branches also still carry the extension's root files (they branched
off `master`); only `desktop/` differs meaningfully between them.

## Branch / release model

- **Extension** changes → `master`.
- **Desktop** changes → land on `desktop-linux`, then propagate to
  `desktop-windows` / `desktop-mac` (cherry-pick the changed `desktop/…`
  files so each branch keeps its own `.github/workflows/release-*.yml`; a
  full merge would drag the wrong release workflow across).
- **Releases are automatic**: any push touching `desktop/**` on a
  `desktop-*` branch runs `release-<os>.yml`, which builds on the matching
  OS runner, publishes a GitHub Release named `v0.0.<run_number>`, and
  deletes every older release+tag for that OS (keep-latest-only). Tags are
  `<os>-v0.0.N` (prefix kept for the cleanup filter + uniqueness).

## Shared domain facts (identical in both codebases)

- `PROJECTS` = 11 fixed names; `CATEGORIES` = 5 fixed. Per-project and
  per-category color maps (`projectColor`/`categoryColor`).
- The form's **Name** list is not in the DOM — it's parsed from the form
  HTML's `__NEXT_DATA__` JSON (`parseNames`), fetched over HTTP, sorted.
- **Fillout automation** (both products): the "Create" entry subform is an
  iframe. Fields are **react-select** — selected by typing the value into
  `input[role=combobox]` + a synthetic `Enter` (works with untrusted
  events). Only the iframe's own **Submit** is ever clicked; the main form's
  final Submit is always left for the human.
- Two hard-won gotchas, preserved in both: (1) **reload-first** — the form
  tab/window must fully load, visibly reload, *then* receive the fill script
  (skipping this silently drops the Name selection); (2) **entries-list
  race** — after a subform submit, wait for the new entry's text to actually
  appear before clicking Create again.
- **No-duplicate**: each entry carries a `submitted` flag; a second Final
  Submit only sends entries not yet marked.

## Data models

- **Extension** (`chrome.storage.local`): today's entries in `entries[]`,
  past days archived in `history{ date: entries[] }`, `timer{activeId,
  startedAt}`, plus `name/names/lastProject/lastCategory/dailyLimitHours/
  confirmBeforeDelete/theme/warnedDate/draft/date`. Entry: `{id, project,
  category, description, accSec, submitted}`.
- **Desktop** (`app_data_dir/data.json`): unified `days{ date: entries[] }`,
  `timer{activeId, startedAt, date}`, `submittedDays{ date:{at,method} }`,
  same scalar settings. Entry shape matches the extension.
- **Transfer bridge**: both export/import the same envelope
  `{app:"team-timesheet", v:1, exportedAt, name, days}` (copy-paste, no
  server). Settings → Backup & transfer in both.

## Commands

```bash
# Extension (root, master)
npm test                       # node test/smoke.js (jsdom, must print "SMOKE: ALL PASS")

# Desktop (desktop/ on desktop-* branches)
cd desktop
npm test                       # vitest (24 tests)
npm run build                  # vite build (frontend only)
npm run tauri dev              # live app  (needs Rust + system deps, see desktop/README.md)
npm run tauri build            # installers
(cd src-tauri && cargo check)  # Rust typecheck
```

## Conventions

- Match surrounding style; comments explain *why* (esp. the automation
  gotchas above — don't "simplify" them away).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Keep `desktop/README.md` short and copy-pasteable.
- Update this file + the relevant ARCHITECTURE.md whenever structure changes.
