param([string]$TargetDir = "")
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path $PSScriptRoot -Parent
$env:TANUKI_SHERPA_ROOT = Join-Path $env:LOCALAPPDATA 'TanukiBCL/Speech/sherpa-2.0.2'
if (!(Test-Path -LiteralPath (Join-Path $env:TANUKI_SHERPA_ROOT 'runtime/sherpa-onnx-c-api.lib'))) { throw 'Run prepare-local-speech.py first.' }
if (!$TargetDir) { $TargetDir = $env:CARGO_TARGET_DIR }
$taskExistingTarget = Join-Path (Split-Path (Split-Path $taskRepo -Parent) -Parent) 'BetterCrewLink-Tauri-Beta/src-tauri/target'
if (!$TargetDir -and (Test-Path -LiteralPath $taskExistingTarget)) { $TargetDir = $taskExistingTarget }
if (!$TargetDir) { $TargetDir = Join-Path $env:LOCALAPPDATA 'TanukiBCL/Build/speech-worker' }
& cargo build --manifest-path (Join-Path $taskRepo 'native/speech-worker/Cargo.toml') --release --locked --target-dir $TargetDir -j 2
if ($LASTEXITCODE -ne 0) { throw 'Native speech build failed' }
Copy-Item -LiteralPath (Join-Path $TargetDir 'release/tanuki-speech-worker.exe') -Destination (Join-Path $env:TANUKI_SHERPA_ROOT 'runtime/TanukiSpeechWorker.exe') -Force
