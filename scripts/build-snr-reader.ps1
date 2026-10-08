$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$portable = Join-Path $root '.tools/dotnet-sdk/dotnet.exe'
$compiler = if (Test-Path $portable) { $portable } else { 'dotnet' }
& $compiler publish (Join-Path $root 'tools/SnrRoleReader/SnrRoleReader.csproj') -c Release -o (Join-Path $root 'out/debug-reader')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $compiler publish (Join-Path $root 'tools/SnrRoleReader/SnrRoleReader.csproj') -c Release -r win-x64 -o (Join-Path $root 'out/debug-reader/x64')
exit $LASTEXITCODE
