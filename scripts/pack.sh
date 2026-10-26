#!/usr/bin/env bash
# Builds the Chrome Web Store upload zip (runtime files only) next to the repo, not inside it.
set -euo pipefail
cd "$(dirname "$0")/.."
v=$(node -p "require('./manifest.json').version")
out="$(cd .. && pwd)/timesheet-extension-v$v.zip"
files="manifest.json background.js data.js gdrive.js sync-core.js prayer.js prayer-hadiths.js popup.html popup.js popup.css tab.html tab.js tab.css theme.css icons/icon128.png"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp --parents $files "$tmp"
#! The Web Store rejects a manifest with "key"; it stays in the repo manifest so unpacked dev builds keep the same extension ID.
node -e "const f=process.argv[1],m=JSON.parse(require('fs').readFileSync(f));delete m.key;require('fs').writeFileSync(f,JSON.stringify(m,null,2)+'\n')" "$tmp/manifest.json"
rm -f "$out"
(cd "$tmp" && zip -q -X "$out" $files)
unzip -l "$out"
echo "wrote $out"
