# Privacy Policy — Daily Timesheet Auto-Filler

_Last updated: 2026-10-26_

Daily Timesheet Auto-Filler ("the extension") is a Chrome extension that tracks
time per project and fills your team's Fillout timesheet form. It is unofficial
and not affiliated with Fillout.

## Data the extension handles

| Data | Where it lives | Why |
|---|---|---|
| Your name (as picked on the timesheet form), timer entries (project, category, description, time), settings, activity log | `chrome.storage.local` on your device | The core timesheet feature |
| City, country and calculation settings for prayer reminders (only if you turn the feature on) | `chrome.storage.local` | Prayer-time reminders |
| Your Google account's access token (only if you click Connect) | Managed by Chrome (`chrome.identity`); never stored by the extension's own code, never sent anywhere except Google | Optional Google Drive backup/sync |

The extension has no server of its own. The developer never receives your data.

## Network requests

- **techzu.fillout.com** — the extension reads the form's name/project/category
  lists and fills the form you have open. Your entries go to the form only when
  you start the fill, and you review the form before its final Submit.
- **Google Drive API** (`googleapis.com`, `oauth2.googleapis.com`) — only after
  you click Connect. The extension requests the `drive.file` scope, which lets
  it see **only the files it creates itself** in your Drive, never your other
  files. It writes your timesheet data there as backup/sync files. "Disconnect"
  revokes the token.
- **api.aladhan.com** — only if you enable prayer reminders. The city, country
  and calculation-method values you entered are sent to fetch prayer times.

No analytics, tracking, advertising or telemetry. No data is sold or shared with
third parties, and none is used for creditworthiness, lending or any purpose
unrelated to the features above. The extension does not load or run remote code.

## Your control

- Delete all local data by removing the extension or using Reset in Settings.
- Delete Drive backups by deleting the extension's files in your Google Drive,
  and revoke access at https://myaccount.google.com/permissions.

## Use of Google user data

The extension's use and transfer of information received from Google APIs
adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Contact

Questions or deletion requests: open an issue at
https://github.com/Srabon444/team-timesheet/issues
