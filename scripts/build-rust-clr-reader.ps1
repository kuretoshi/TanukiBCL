param([ValidateSet('debug','release')][string]$Configuration = 'release')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Join-Path $repoRoot 'src-tauri/Cargo.toml'
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_BUILD_JOBS = '2'
foreach ($architecture in @('x64','x86')) {
    $arguments = @('build','--manifest-path',$manifest,'-p','tbcl-clr-reader')
    $targetDirectory = Join-Path $repoRoot 'src-tauri/target'
    if ($architecture -eq 'x86') {
        $arguments += @('--target','i686-pc-windows-msvc')
        $targetDirectory = Join-Path $targetDirectory 'i686-pc-windows-msvc'
    }
    if ($Configuration -eq 'release') { $arguments += '--release' }
    & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw "Rust CLR reader build failed: $architecture" }
    $executable = Join-Path $targetDirectory "$Configuration/tbcl-clr-reader.exe"
    $destination = Join-Path $repoRoot "out/tauri-backend/out/rust-clr/$architecture"
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -LiteralPath $executable -Destination (Join-Path $destination 'tbcl-clr-reader.exe')
}
