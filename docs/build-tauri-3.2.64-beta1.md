# Tauri 3.2.64 beta1 corresponding source

Version: 3.2.64-tauri-beta.1. Electron base: v3.2.64 (a309dbff11846f4069bf6e101180dcc475415edf).

This branch includes the native Rust application, Rust/WASM UI, 32/64-bit Rust CLR readers, source assets, build-time Electron reference exporters, lockfiles and dependency licenses. The Electron main branch and existing installers are preserved.

## Build on Windows x64

Install Node.js 24, Rust MSVC, Visual Studio C++ Build Tools and WebView2 Runtime. FFmpeg is needed only when regenerating checked PCM effect assets. A .NET SDK is used by optional test oracles only.

```powershell
npm ci
rustup target add wasm32-unknown-unknown i686-pc-windows-msvc
cargo install wasm-bindgen-cli --version 0.2.130 --locked
$env:CARGO_INCREMENTAL='0'
$env:CARGO_BUILD_JOBS='2'
npm run verify:tauri-base
npm run tauri:build
cargo test --manifest-path src-tauri/Cargo.toml --workspace --bins --lib -j 2
```

Use one working directory and reuse build caches. The build finishes the WASM frontend before compiling the native executable. Speech resources are downloaded from pinned upstream URLs and SHA256 checked. The installer is produced under dist-tauri.

Local verify-rust-package.mjs additionally expects preserved historical releases and an Electron file hash manifest; these machine-specific inputs are not required to build. Run its --preservation-manifest and --report options with your own local audit inputs when appropriate.

See docs/validation-tauri-3.2.64.json for validation and limitations. New roles were tested using synthetic PCM and local authenticated transports. Physical microphones, multi-person live matches and long sessions remain unverified. Earlier Electron/.NET memory comparisons describe older betas, not this version.

GPL-3.0-or-later. See LICENSE and the packaged notices for dependencies.
