$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$portable = Join-Path $root '.tools/dotnet-sdk/dotnet.exe'
$compiler = if (Test-Path $portable) { $portable } else { 'dotnet' }
$readerOutput = Join-Path $root 'out/nos-reader'
# Remove files left by the former single-architecture output layout.
if (Test-Path $readerOutput) {
    Get-ChildItem -LiteralPath $readerOutput -File | Remove-Item
}
foreach ($architecture in @('x86', 'x64')) {
    & $compiler publish (Join-Path $root 'tools/TbclSnapshotReader/TbclSnapshotReader.csproj') -c Release -r "win-$architecture" -o (Join-Path $readerOutput $architecture)
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
