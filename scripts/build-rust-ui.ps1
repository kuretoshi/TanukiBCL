$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Join-Path $repoRoot 'src-tauri/Cargo.toml'
& node (Join-Path $PSScriptRoot 'export-rust-ui-data.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Rust UI data export failed' }
& node (Join-Path $repoRoot 'scripts/export-rust-ui-visuals.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Rust UI visual asset export failed' }
& node (Join-Path $repoRoot 'scripts/export-player-grid-goldens.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Electron player grid reference export failed' }
$env:CARGO_INCREMENTAL = '0'
& cargo build --manifest-path $manifest -p tbcl-rust-ui --target wasm32-unknown-unknown --release -j 2
if ($LASTEXITCODE -ne 0) { throw 'Rust UI build failed' }
$output = Join-Path $repoRoot 'out/tauri-rust-ui'
New-Item -ItemType Directory -Force -Path $output | Out-Null
& wasm-bindgen (Join-Path $repoRoot 'src-tauri/target/wasm32-unknown-unknown/release/tbcl_rust_ui.wasm') --target web --out-dir (Join-Path $output 'rust-ui') --no-typescript
if ($LASTEXITCODE -ne 0) { throw 'Rust UI binding generation failed' }
@'
import init from './tbcl_rust_ui.js';
await init();
'@ | Set-Content -LiteralPath (Join-Path $output 'rust-ui/bootstrap.js') -Encoding utf8
Copy-Item -LiteralPath (Join-Path $repoRoot 'src-tauri/rust-ui/index.html') -Destination (Join-Path $output 'rust-ui.html')
Copy-Item -LiteralPath (Join-Path $repoRoot 'src-tauri/rust-ui/index.html') -Destination (Join-Path $output 'index.html')
