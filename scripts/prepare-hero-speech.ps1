$ErrorActionPreference = 'Stop'
$heroRoot = Split-Path $PSScriptRoot -Parent
$heroCache = Join-Path $heroRoot '.cache/hero-speech'
$heroAssets = Join-Path $heroRoot 'src/renderer/public/speech'
New-Item -ItemType Directory -Path $heroCache, $heroAssets -Force | Out-Null
$heroTar = Join-Path $env:SystemRoot 'System32/tar.exe'
function Get-HeroAsset([string]$Name, [string]$Url, [string]$Sha256) {
    $heroFile = Join-Path $heroCache $Name
    if (!(Test-Path -LiteralPath $heroFile)) { Invoke-WebRequest -Uri $Url -OutFile $heroFile }
    if ((Get-FileHash -LiteralPath $heroFile -Algorithm SHA256).Hash -ne $Sha256) {
        throw "Speech asset checksum mismatch: $Name"
    }
    return $heroFile
}
$heroBrowser = Get-HeroAsset 'vosk-browser-0.0.8.tgz' 'https://registry.npmjs.org/vosk-browser/-/vosk-browser-0.0.8.tgz' 'FD16FC7E64C935D7A79CF07C8F67D84232B6485376A59144AF8A234979A9A4B4'
$heroModel = Get-HeroAsset 'vosk-model-small-ja-0.22.zip' 'https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip' 'EFA092D280153A77615E9E0C7D7283E93E600DE3D19D3BEC686C57EF19D52EAC'
if (!(Test-Path -LiteralPath (Join-Path $heroAssets 'vosk.js'))) {
    & $heroTar -xzf $heroBrowser -C $heroCache 'package/dist/vosk.js'
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the speech engine.' }
    Copy-Item -LiteralPath (Join-Path $heroCache 'package/dist/vosk.js') -Destination (Join-Path $heroAssets 'vosk.js')
}
if (!(Test-Path -LiteralPath (Join-Path $heroAssets 'model-ja.tar.gz'))) {
    Expand-Archive -LiteralPath $heroModel -DestinationPath (Join-Path $heroCache 'extracted') -Force
    $heroModelRoot = Join-Path $heroCache 'model'
    New-Item -ItemType Directory -Path $heroModelRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $heroCache 'extracted/vosk-model-small-ja-0.22/*') -Destination $heroModelRoot -Recurse -Force
    & $heroTar -czf (Join-Path $heroAssets 'model-ja.tar.gz') -C $heroCache 'model'
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the Japanese speech model.' }
}
Write-Output 'Japanese recognition engine/model ready (local processing, Apache-2.0).'
