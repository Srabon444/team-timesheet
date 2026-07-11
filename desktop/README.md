# Team Timesheet — Desktop App

Trackabi-style time tracker (Tauri 2 + Svelte 5). **Final Submit** opens the
Techzu Fillout form in an app window, auto-fills every tracked entry, and
stops — you review and click the form's own Submit yourself.

## Branches

Same app everywhere; branches differ only in packaging + CI.
Fixes land on `desktop-linux`, then merge into the other two.

| Branch | Installers | Release tag |
|---|---|---|
| `desktop-linux` | `.deb`, `.AppImage` | `linux-v*` |
| `desktop-windows` | `.msi`, `.exe` | `windows-v*` |
| `desktop-mac` | `.dmg` | `macos-v*` |

## Release (all 3 OS)

Push a tag — GitHub Actions builds on the matching OS runner and attaches
installers to a GitHub Release automatically:

```bash
git tag linux-v0.1.0 desktop-linux && git push origin linux-v0.1.0
git tag windows-v0.1.0 desktop-windows && git push origin windows-v0.1.0
git tag macos-v0.1.0 desktop-mac && git push origin macos-v0.1.0
```

Installers appear under the repo's **Releases** page a few minutes later.

## Install (users)

**Linux**

```bash
sudo dpkg -i Team.Timesheet_*.deb        # or:
chmod +x Team.Timesheet_*.AppImage && ./Team.Timesheet_*.AppImage
```

**Windows** — run the downloaded `.msi` (or `.exe`) installer.

**macOS** — open the `.dmg`, drag the app to Applications. Unsigned build,
so on first launch: right-click the app → Open → Open. Or:

```bash
xattr -dr com.apple.quarantine "/Applications/Team Timesheet.app"
```

## Develop (Linux)

```bash
sudo apt install -y build-essential pkg-config libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

cd desktop
npm install
npm test            # Vitest
npm run tauri dev   # live app
./build-linux.sh    # .deb + .AppImage
```

## Notes

- Data lives locally in `data.json` (app data dir). Timers are timestamps —
  they survive restarts.
- Auto-fill never clicks the main form's Submit; already-submitted entries
  are marked and never re-sent.
