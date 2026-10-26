#!/usr/bin/env bash
# Builds the Chrome Web Store upload zip (runtime files only) next to the repo, not inside it.
set -euo pipefail
cd "$(dirname "$0")/.."
v=$(node -p "require('./manifest.json').version")
out="../timesheet-extension-v$v.zip"
rm -f "$out"
zip -q -X "$out" manifest.json background.js data.js gdrive.js sync-core.js prayer.js prayer-hadiths.js \
  popup.html popup.js popup.css tab.html tab.js tab.css theme.css icons/icon128.png
unzip -l "$out"
echo "wrote $out"
