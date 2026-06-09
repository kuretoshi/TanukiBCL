param(
	[Parameter(Mandatory = $true)]
	[int]$TargetPid,
	[string]$Title = "Among Us",
	[string]$ExePath = "",
	[switch]$DebugVoice = $true
)

$ErrorActionPreference = "Stop"

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

$arguments = @(
	"--multi-instance",
	"--target-pid=$TargetPid",
	"--target-name=$Title"
)

if ($DebugVoice) {
	$arguments += "--debug-voice"
}

Write-Host "Launching TanukiBCL: $ExePath"
Start-Process -FilePath $ExePath -ArgumentList $arguments
