$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$output = Join-Path $root '.cache/snr-reader-test'
$reader = Join-Path $root 'out/debug-reader/SnrRoleReader.exe'
$portable = Join-Path $root '.tools/dotnet-sdk/dotnet.exe'
$compiler = if (Test-Path $portable) { $portable } else { 'dotnet' }
& $compiler publish (Join-Path $root 'tools/SnrRoleReader/SnrRoleReader.csproj') -c Release -o (Split-Path $reader)
if ($LASTEXITCODE -ne 0) { throw 'Reader build failed' }
& $compiler publish (Join-Path $PSScriptRoot 'fixtures/snr-reader/Host/Host.csproj') -c Release -o $output
if ($LASTEXITCODE -ne 0) { throw 'Host build failed' }
& $compiler build (Join-Path $PSScriptRoot 'fixtures/snr-reader/Plugin/Plugin.csproj') -c Release -o $output
if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed' }

foreach ($mode in @('duplicate', 'single', 'ambiguous', 'uninitialized', 'mismatch', 'empty')) {
    $ready = Join-Path $output ($mode + '-' + [Guid]::NewGuid().ToString('N') + '.ready')
    $hostProcess = Start-Process -FilePath (Join-Path $output 'Among Us.exe') -ArgumentList @($mode, ('"' + $ready + '"')) -WindowStyle Hidden -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (!(Test-Path -LiteralPath $ready)) {
            if ($hostProcess.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw "Fixture failed: $mode" }
            Start-Sleep -Milliseconds 100
        }
        $json = & $reader $hostProcess.Id
        $readerExitCode = $LASTEXITCODE
        $result = $json | ConvertFrom-Json
        if ($mode -in @('duplicate', 'single')) {
            $jackal = @($result.players | Where-Object playerId -eq 3)
            $frankenstein = @($result.players | Where-Object playerId -eq 2)
            if ($readerExitCode -ne 0 -or $result.status -ne 'ok' -or $result.players.Count -ne 2 -or
                $jackal.Count -ne 1 -or $jackal[0].role.name -ne 'Jackal' -or $jackal[0].role.value -ne 11 -or
                $jackal[0].modifier.name -ne 'JumboModifier' -or $jackal[0].modifier.value -ne 16 -or
                $frankenstein.Count -ne 1 -or $frankenstein[0].role.name -ne 'Frankenstein' -or
                $frankenstein[0].modifier.name -ne 'JumboModifier | TestModifier') { throw "Role read failed: $mode $json" }
            if ($mode -eq 'duplicate' -and (@($result.diagnostics).Count -ne 2 -or
                $result.diagnostics[0].initialized -ne $false -or $result.diagnostics[1].initialized -ne $true)) {
                throw "Did not reproduce inactive-first module order: $json"
            }
        } elseif ($mode -eq 'empty') {
            if ($readerExitCode -ne 0 -or $result.status -ne 'ok' -or $result.players.Count -ne 0) { throw "Empty read failed: $json" }
        } else {
            if ($readerExitCode -eq 0 -or $result.status -ne 'error' -or $null -ne $result.players -or
                @($result.diagnostics).Count -ne 2) { throw "Unsafe result: $mode $json" }
            $initialized = @($result.diagnostics | Where-Object initialized -eq $true).Count
            if (($mode -eq 'ambiguous' -and $initialized -ne 2) -or
                ($mode -eq 'uninitialized' -and $initialized -ne 0) -or
                ($mode -eq 'mismatch' -and $result.message -ne 'Player ID mismatch')) { throw "Unexpected failure: $mode $json" }
        }
        Write-Host "PASS: $mode"
    } finally {
        if (!$hostProcess.HasExited) { $hostProcess.Kill(); $hostProcess.WaitForExit() }
        $hostProcess.Dispose()
        if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready }
    }
}
