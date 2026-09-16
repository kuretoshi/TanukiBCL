$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$portable = Join-Path $root '.tools/dotnet-sdk/dotnet.exe'
$compiler = if (Test-Path $portable) { $portable } else { 'dotnet' }
& $compiler publish (Join-Path $root 'tools/SnrRoleReader/SnrRoleReader.csproj') -c Release -o (Join-Path $root 'out/debug-reader')
exit $LASTEXITCODE
