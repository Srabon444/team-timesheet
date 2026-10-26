# Chrome Web Store listing — copy/paste sheet

Upload: `npm run pack` → `../timesheet-extension-v<version>.zip`.
Bump `version` in manifest.json for every re-upload.

## Store listing tab

- **Name:** Daily Timesheet Auto-Filler
- **Summary (≤132):** Per-project timers that auto-fill your team's Fillout daily timesheet form. Optional Google Drive backup. Unofficial.
- **Category:** Productivity
- **Language:** English
- **Icon:** `icons/icon128.png`
- **Screenshot:** `docs/store/screenshot-1-autofill-1280x800.png`
- **Small promo tile:** `docs/store/promo-tile-440x280.png`
- **Privacy policy URL:** `https://srabon444.github.io/team-timesheet/` (served from the `gh-pages` branch; edit `docs/privacy-policy.md` and mirror the change into `gh-pages/index.html`)

### Description

Track your day per project, then let the extension fill the daily timesheet form for you.

Built for the Techzu team's Fillout timesheet form. Unofficial: not affiliated with or endorsed by Fillout.

FEATURES
• Per-project timers — start/pause, one active at a time; survives closing the browser
• Back-fill or correct earlier days
• One-click auto-fill: picks your name, creates an entry per project with category, description and time. It never presses the form's final Submit; you review and submit
• Submitted-day tracking, so a second fill never duplicates entries
• Full-page view with weekly chart, stats and a timesheet table
• Daily-limit notification and a toolbar badge showing the running timer
• Optional Google Drive backup and multi-device sync (you choose to connect; only files the extension creates are accessible)
• Optional prayer-time reminders (off by default; city sent to a prayer-times service only if you enable it)

PRIVACY
All data stays on your device unless you connect Google Drive. No analytics, no ads, no remote code.

## Privacy practices tab

**Single purpose:** Track time per project and auto-fill the user's Fillout daily timesheet form.
(Prayer reminders are an optional reminder feature in the same daily-planning workflow, off by default.)

**Permission justifications**

| Permission | Justification |
|---|---|
| `storage` | Saves timer entries, settings and the activity log locally. |
| `unlimitedStorage` | Keeps months of entries, activity log and recovery points; they can exceed the default quota. |
| `scripting` | Injects the fill routine into the open Fillout timesheet form (and only that site) to select fields and click Create. |
| `alarms` | Updates the toolbar badge each minute while a timer runs and schedules daily-limit and prayer reminders while the popup is closed. |
| `notifications` | Daily-limit alert and optional prayer reminders. |
| `identity` | Optional Google sign-in for Drive backup/sync (`drive.file` scope only). |
| Host `https://techzu.fillout.com/*` | Read the form's name/project/category lists and fill the form. |
| Host `https://www.googleapis.com/*`, `https://oauth2.googleapis.com/*` | Drive backup/sync calls and token revocation on Disconnect. |
| Host `https://api.aladhan.com/*` | Fetch prayer times for the city the user enters (optional feature). |

**Remote code:** No. All code is in the package.

**Data usage disclosures (check these):**
- Personally identifiable information: **No** (a display name the user picks on the form stays local / in their own Drive)
- User activity / Website content: entries the user types are stored locally; disclose "Website content" only if the dashboard prompts about form text read from Fillout
- Authentication information: **Yes**, Google OAuth token handled by `chrome.identity` for Drive (optional)
- Certify: not sold to third parties; not used for unrelated purposes; not used for creditworthiness/lending

## Reviewer test notes (Distribution tab → "Test instructions")

The extension works with the Techzu Fillout timesheet form (https://techzu.fillout.com/t/uhz6TddCX2us).
Timers, the full view, notifications and settings work without any account: open the popup, enter any
name, add a project entry and start the timer. Drive backup is optional (Settings → Connect Google Drive).
Auto-fill needs the form open; the form is public, so no login is required.

## Distribution tab

- Visibility: **Public**
- Regions: all (or restrict if preferred)

## Before submitting — one-time checklist (owner only)

1. Developer account registered ($5).
2. Upload zip as a draft → Package tab → compare the Item ID with the unpacked extension's ID. If they differ, copy "View public key" into manifest `key`, and set that ID as the Application ID of the OAuth client in Google Cloud.
3. Google Cloud → OAuth consent screen: publish to **In production**, add the privacy-policy URL (same as above), scopes `drive.file` only.
4. Manual check on an unpacked build: Open full view twice (second click should focus the existing tab, not open a new one; confirms `tabs` permission is not needed).
5. Submit for review.
