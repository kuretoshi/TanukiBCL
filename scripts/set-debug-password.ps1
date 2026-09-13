$ErrorActionPreference = 'Stop'
$first = Read-Host 'Developer debug password' -AsSecureString
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
    $directory = Join-Path (Split-Path $PSScriptRoot -Parent) '.tools'
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    [IO.File]::WriteAllText((Join-Path $directory 'debug-password.json'), ($record | ConvertTo-Json))
} finally {
    $derive.Dispose()
    $first.Dispose()
    $second.Dispose()
    $password = $null
    $confirmation = $null
}
Write-Output 'Password configured. Rebuild both editions to apply it.'
