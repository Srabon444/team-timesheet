#!/usr/bin/env bash
# Build the macOS desktop app (.dmg + .app). Must run ON macOS.
#
# One-time prerequisites:
#   xcode-select --install
#   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
#   Node.js 22+ (e.g. brew install node)
#
# The build is unsigned (no Apple Developer certificate). To open it on
# another Mac: right-click the app -> Open -> Open, or clear quarantine:
#   xattr -dr com.apple.quarantine "/Applications/Team Timesheet.app"
set -euo pipefail
cd "$(dirname "$0")"

command -v cargo >/dev/null || source "$HOME/.cargo/env"

npm install
npm test
npm run tauri build

echo
echo "Artifacts:"
ls -lh src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || true
ls -d src-tauri/target/release/bundle/macos/*.app 2>/dev/null || true
