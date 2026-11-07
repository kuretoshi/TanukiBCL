# Tauri beta9 corresponding source

Version: 3.2.62-tauri-beta.9. Base: v3.2.62 (0053e9c19b902ad3b453461fdb206569290b9cd2).

This branch contains the Rust application/UI, generated source data, original UI/assets used by build-time exporters, Cargo.lock, npm lockfile, licenses, and build scripts. Electron main and its published installers are unchanged.

## Build on Windows x64

Install Node.js 24, Rust MSVC, Visual Studio C++ Build Tools and WebView2 Runtime. FFmpeg is needed only to regenerate the included checked PCM effects if their input files change. A .NET SDK is needed only for optional comparison fixtures.

Run in the extracted source root:

```powershell
npm ci
rustup target add wasm32-unknown-unknown i686-pc-windows-msvc
cargo install wasm-bindgen-cli --version 0.2.130 --locked
$env:CARGO_INCREMENTAL='0'
$env:CARGO_BUILD_JOBS='2'
npm run verify:tauri-base
cargo test --manifest-path src-tauri/Cargo.toml --workspace --bins --lib -j 2
npm run tauri:build
```

Use one working directory and reuse dependencies/build caches. Frontend compilation must finish before the native application is built; the build command enforces that order. Resources download Vosk and its Japanese model from pinned upstream locations and verify SHA256. The Windows installer and portable directory are produced under dist-tauri.

The local-only verify-rust-package.mjs audit additionally expects retained historical releases, a local Electron preservation manifest, and 7-Zip; these private machine-specific audit inputs are intentionally absent from this source branch and are not required to build the application.

The supplied installer was checked with 101 Rust unit tests, 1,984 original grid-layout cases, a bounded 90-second 13-player synthetic UI run, and packaged two-way voice interoperability. Full visual/Mod/long-session verification remains incomplete. See docs/tauri-beta.md for scope and limitations. Existing Electron/.NET memory measurements describe beta8, not beta9.

GPL-3.0-or-later; see LICENSE and src-tauri/licenses for third-party notices. Source identifiers and packaged executable checksums are recorded in tauri-beta9-source.json.
