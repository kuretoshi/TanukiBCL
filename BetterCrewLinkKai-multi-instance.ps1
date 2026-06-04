param(
	[int]$Count = 1,
	[int]$StartIndex = 0,
	[string]$TargetName = "Among Us",
	[string]$ExePath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ExePath)) {
	$candidates = @(
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

for ($i = 0; $i -lt $Count; $i++) {
	$targetIndex = $StartIndex + $i
	$args = @(
		"--multi-instance",
		"--target-index=$targetIndex",
		"--target-name=$TargetName"
	)

	Start-Process -FilePath $ExePath -ArgumentList $args -WindowStyle Hidden
	Start-Sleep -Milliseconds 500
}
