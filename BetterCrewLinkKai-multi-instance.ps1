param(
	[int]$Count = 0,
	[int]$StartIndex = 0,
	[string]$TargetName = "Among Us",
	[string]$TargetProcessName = "Among Us",
	[string]$ExePath = "",
	[switch]$DebugVoice = $true
)

$ErrorActionPreference = "Stop"

$targetProcessBaseName = [System.IO.Path]::GetFileNameWithoutExtension($TargetProcessName)
$targetProcessExeName = "$targetProcessBaseName.exe"

if ([string]::IsNullOrWhiteSpace($ExePath)) {
	$candidates = @(
		"$PSScriptRoot\TanukiBCL.exe",
		"$env:LOCALAPPDATA\Programs\tanukibcl\TanukiBCL.exe",
		"$PSScriptRoot\dist\win-unpacked\TanukiBCL.exe"
	)

	$ExePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($ExePath) -or !(Test-Path -LiteralPath $ExePath)) {
	throw "TanukiBCL executable was not found. Pass -ExePath explicitly."
}

$processes = Get-Process -Name $targetProcessBaseName -ErrorAction SilentlyContinue |
	Sort-Object Id |
	Select-Object -Skip $StartIndex

if ($Count -gt 0) {
	$processes = $processes | Select-Object -First $Count
}

if (!$processes) {
	throw "No running '$targetProcessBaseName' processes were found."
}

foreach ($process in $processes) {
	Write-Host "Launching TanukiBCL for $targetProcessExeName PID $($process.Id): $ExePath"
	$env:BETTERCREWLINK_ALLOW_MULTI_INSTANCE = "1"
	$env:BETTERCREWLINK_TARGET_PID = [string]$process.Id
	$env:BETTERCREWLINK_TARGET_NAME = $TargetName
	$env:BETTERCREWLINK_TARGET_PROCESS = $targetProcessExeName
	$env:BETTERCREWLINK_DEBUG_OVERLAY = if ($DebugVoice) { "1" } else { "" }
	Start-Process -FilePath $ExePath
	Start-Sleep -Milliseconds 500
}
