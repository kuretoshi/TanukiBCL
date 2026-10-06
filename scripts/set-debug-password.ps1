param(
    [switch]$Add,
    [string]$Name,
    [string]$ConfigurationPath = (Join-Path (Split-Path $PSScriptRoot -Parent) '.tools/debug-password.json')
)

$ErrorActionPreference = 'Stop'
$records = @()
if ($Add) {
    if (Test-Path -LiteralPath $ConfigurationPath) {
        $existing = Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json
        if ($existing.PSObject.Properties.Name -contains 'passwords') {
            if ($existing.passwords -isnot [array]) { throw 'Invalid password configuration.' }
            $records = @($existing.passwords)
        } else {
            $records = @(@{ name = 'developer'; salt = $existing.salt; hash = $existing.hash })
        }
        foreach ($entry in $records) {
            if ($entry.salt -isnot [string] -or $entry.hash -isnot [string] -or $entry.salt -notmatch '^[a-f0-9]{32}$' -or $entry.hash -notmatch '^[a-f0-9]{64}$') {
                throw 'Invalid password configuration. Existing passwords were not changed.'
            }
        }
    }
    if ($records.Count -ge 16) { throw 'At most 16 debug passwords can be configured.' }
    if ([string]::IsNullOrWhiteSpace($Name)) { $Name = Read-Host 'Name for this tester (not the password)' }
    $Name = $Name.Trim()
    if (-not $Name -or $Name.Length -gt 80) { throw 'Name must contain 1-80 characters.' }
    if ($records | Where-Object { $_.name -eq $Name }) { throw 'This name already exists. Choose another name.' }
}

$first = Read-Host 'Debug password' -AsSecureString
$second = Read-Host 'Confirm password' -AsSecureString
$password = [System.Net.NetworkCredential]::new('', $first).Password
$confirmation = [System.Net.NetworkCredential]::new('', $second).Password
if ([string]::IsNullOrEmpty($password) -or $password.Length -gt 1024 -or $password -cne $confirmation) {
    throw 'Passwords must match and contain 1-1024 characters.'
}
$salt = New-Object byte[] 16
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$random.GetBytes($salt)
$random.Dispose()
$derive = [Security.Cryptography.Rfc2898DeriveBytes]::new($password, $salt, 100000, [Security.Cryptography.HashAlgorithmName]::SHA256)
try {
    $record = @{ salt = [BitConverter]::ToString($salt).Replace('-', '').ToLowerInvariant(); hash = [BitConverter]::ToString($derive.GetBytes(32)).Replace('-', '').ToLowerInvariant() }
    if ($Add) {
        $record.name = $Name
        $configuration = @{ passwords = @($records) + @($record) }
    } else {
        $configuration = $record
    }
    $directory = Split-Path ([IO.Path]::GetFullPath($ConfigurationPath)) -Parent
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    [IO.File]::WriteAllText($ConfigurationPath, ($configuration | ConvertTo-Json -Depth 4))
} finally {
    $derive.Dispose()
    $first.Dispose()
    $second.Dispose()
    $password = $null
    $confirmation = $null
}
if ($Add) { Write-Output 'Debug password added. Existing passwords still work.' }
else { Write-Output 'Debug passwords replaced.' }
Write-Output 'Rebuild both editions to apply it.'
