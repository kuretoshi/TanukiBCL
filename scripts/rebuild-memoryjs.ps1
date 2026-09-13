param(
    [Parameter(Mandatory=$true)][string]$MsvcRoot,
    [Parameter(Mandatory=$true)][string]$NodeHeaders
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$compilerRoot = Get-ChildItem -LiteralPath (Join-Path $MsvcRoot 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$sdkRoot = Join-Path $MsvcRoot 'Windows Kits/10'
$sdkVersion = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$compiler = Join-Path $compilerRoot.FullName 'bin/Hostx64/x64/cl.exe'
$env:INCLUDE = @((Join-Path $compilerRoot.FullName 'include'), (Join-Path $sdkVersion.FullName 'ucrt'), (Join-Path $sdkVersion.FullName 'shared'), (Join-Path $sdkVersion.FullName 'um')) -join ';'
$env:LIB = @((Join-Path $compilerRoot.FullName 'lib/x64'), (Join-Path $sdkRoot "Lib/$($sdkVersion.Name)/ucrt/x64"), (Join-Path $sdkRoot "Lib/$($sdkVersion.Name)/um/x64")) -join ';'
$moduleRoot = Join-Path $repoRoot 'node_modules/memoryjs'
$output = Join-Path $moduleRoot 'build/Release'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$options = @('/nologo', '/LD', '/MT', '/O2', '/std:c++20', '/Zc:__cplusplus', '/EHsc', '/DNOMINMAX', '/DNAPI_DISABLE_CPP_EXCEPTIONS', '/DHOST_BINARY=\"node.exe\"', '/Zc:strictStrings-')
$options += '/I"' + (Join-Path $repoRoot 'node_modules/node-addon-api') + '"'
$options += '/I"' + (Join-Path $NodeHeaders 'include/node') + '"'
foreach ($source in @('memoryjs.cc','memory.cc','process.cc','module.cc','pattern.cc','functions.cc')) {
    $options += '"' + (Join-Path $moduleRoot "lib/windows/$source") + '"'
}
$options += '"' + (Join-Path $repoRoot 'node_modules/node-gyp/src/win_delay_load_hook.cc') + '"'
$options += @('/link', '/OUT:memoryjs.node', '/DELAYLOAD:node.exe', 'delayimp.lib', 'Psapi.lib', ('"' + (Join-Path $NodeHeaders 'node.lib') + '"'))
$responseFile = Join-Path $output 'compile.rsp'
[IO.File]::WriteAllText($responseFile, ($options -join ' '))
Push-Location -LiteralPath $output
try {
    & $compiler "@$responseFile"
    if ($LASTEXITCODE -ne 0) { throw "memoryjs compilation failed ($LASTEXITCODE)" }
} finally { Pop-Location }
Write-Output "Built $output/memoryjs.node"
