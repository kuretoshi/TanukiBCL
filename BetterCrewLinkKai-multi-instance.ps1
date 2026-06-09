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
	$args = @(
		"--multi-instance",
		"--target-pid=$($process.Id)",
		"--target-name=`"$TargetName`"",
		"--target-process=`"$targetProcessExeName`""
	)

	if ($DebugVoice) {
		$args += "--debug-voice"
	}

	Write-Host "Launching TanukiBCL for $targetProcessExeName PID $($process.Id): $ExePath"
	Start-Process -FilePath $ExePath -ArgumentList $args
	Start-Sleep -Milliseconds 500
}
