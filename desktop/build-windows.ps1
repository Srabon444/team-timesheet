# Build the Windows desktop app (.msi + NSIS .exe).
#
# One-time prerequisites (run on Windows):
#   - Rust:            winget install Rustlang.Rustup   (then: rustup default stable)
#   - Node.js 22+:     winget install OpenJS.NodeJS.LTS
#   - VS Build Tools:  winget install Microsoft.VisualStudio.2022.BuildTools
#     (with the "Desktop development with C++" workload)
#   - WebView2 runtime ships with Windows 10/11 already.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

npm install
npm test
npm run tauri build

Write-Host ""
Write-Host "Artifacts:"
Get-ChildItem -Path "src-tauri/target/release/bundle/msi/*.msi", "src-tauri/target/release/bundle/nsis/*.exe" -ErrorAction SilentlyContinue
