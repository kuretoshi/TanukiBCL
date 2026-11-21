param([string]$OutputFile = 'dist/TanukiBCL-SharedSpeech-Setup-2.0.2.1.exe')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$speech = Join-Path $env:LOCALAPPDATA 'TanukiBCL/Speech/sherpa-2.0.2'
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputFile))
if (Test-Path -LiteralPath $output) { throw "Output already exists: $output" }
$nsis = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron-builder/Cache/nsis-3.0.4.1') -Recurse -Filter makensis.exe -File | Where-Object DirectoryName -NotLike '*\Bin' | Select-Object -First 1
if (!$nsis) { throw 'Existing NSIS compiler not found' }
New-Item -ItemType Directory -Path (Split-Path $output) -Force | Out-Null
$notice = Join-Path $repo 'native\speech-worker\THIRD-PARTY-NOTICES.md'
$rustNotice = Join-Path $repo 'native\speech-worker\RUST-DEPENDENCY-LICENSES.txt'
$license = Join-Path $repo 'LICENSE'
$template = Join-Path $repo 'native\speech-worker\shared-speech.nsi'
& $nsis.FullName /WX /V2 "/DSHARED_ROOT=$speech" "/DOUTPUT_FILE=$output" "/DNOTICES_FILE=$notice" "/DRUST_NOTICES=$rustNotice" "/DADAPTER_LICENSE=$license" $template
if ($LASTEXITCODE -ne 0) { throw 'Shared speech installer build failed' }
Get-FileHash -LiteralPath $output -Algorithm SHA256
