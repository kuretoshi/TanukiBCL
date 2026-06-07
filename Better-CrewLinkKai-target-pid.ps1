param(
	[Parameter(Mandatory = $true)]
	[int]$TargetPid,
	[string]$Title = "Among Us",
	[string]$ExePath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ExePath)) {
	$candidates = @(
		"$PSScriptRoot\Better-CrewLinkKai.exe",
		"$PSScriptRoot\BetterCrewLinkKai.exe",
		"$env:LOCALAPPDATA\Programs\bettercrewlinkkai\Better-CrewLinkKai.exe",
		"$env:LOCALAPPDATA\Programs\bettercrewlinkkai\BetterCrewLinkKai.exe",
		"$PSScriptRoot\dist\win-unpacked\Better-CrewLinkKai.exe",
		"$PSScriptRoot\dist\win-unpacked\BetterCrewLinkKai.exe"
	)

	$ExePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($ExePath) -or !(Test-Path -LiteralPath $ExePath)) {
	throw "BetterCrewLinkKai executable was not found. Pass -ExePath explicitly."
}

$arguments = @(
	"--multi-instance",
	"--target-pid=$TargetPid",
	"--target-name=$Title"
)

Write-Host "Launching BetterCrewLinkKai: $ExePath"
Start-Process -FilePath $ExePath -ArgumentList $arguments
