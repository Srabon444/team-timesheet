#!/usr/bin/env bash
# Build the Linux desktop app (deb + AppImage).
#
# One-time system prerequisites (Ubuntu/Debian):
#   sudo apt install -y build-essential pkg-config libssl-dev libgtk-3-dev \
#     libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
#   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
set -euo pipefail
cd "$(dirname "$0")"

command -v cargo >/dev/null || source "$HOME/.cargo/env"

npm install
npm test
npm run tauri build

echo
echo "Artifacts:"
ls -lh src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null || true
