fn main() {
    // The Google Drive client secret is compiled in via option_env!("GD_CLIENT_SECRET").
    // Cargo does NOT track env vars read by option_env!/env! automatically, so a
    // changed secret (e.g. fixing a wrong value) wouldn't trigger a recompile and a
    // cached build would keep the stale secret. This re-fingerprints the crate
    // whenever GD_CLIENT_SECRET changes.
    println!("cargo:rerun-if-env-changed=GD_CLIENT_SECRET");
    tauri_build::build()
}
