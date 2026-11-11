# Sum native Windows memory counters for one owned application's process tree.
# Used by test-native-voice-live-game.mjs; no audio or game identities are saved.
[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][string]$Executable,
    [int]$DurationSeconds = 100,
    [int]$GameProcessId = 0,
    [ValidateSet('auto','node','rust')][string]$Backend = 'auto',
    [Parameter(Position=0,ValueFromRemainingArguments=$true)][string[]]$CommandArguments
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AppMemoryProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct Counters {
    public uint cb, PageFaultCount;
    public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage;
    public UIntPtr QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage;
    public UIntPtr PrivateUsage, PrivateWorkingSetSize;
    public ulong SharedCommitUsage;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("psapi.dll", SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr process, ref Counters counters, uint size);
  public static Counters Read(uint pid) {
    var handle=OpenProcess(0x410, false, pid);
    if(handle==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      var counters=new Counters(); counters.cb=(uint)Marshal.SizeOf(typeof(Counters));
      if(!GetProcessMemoryInfo(handle,ref counters,counters.cb)) throw new System.ComponentModel.Win32Exception();
      return counters;
    } finally { CloseHandle(handle); }
  }
}
'@
$selfCheck=[AppMemoryProbe]::Read($PID)
Write-Output "Memory API ready: private working set=$($selfCheck.PrivateWorkingSetSize.ToUInt64())"
$measurementDirectory = Join-Path $PSScriptRoot '..\.tools\memory-comparison'
$null = New-Item -ItemType Directory -Path $measurementDirectory -Force
$prefix = Join-Path $measurementDirectory $Label
$phasePath = "$prefix.phase"
$stopPath = "$prefix.stop"
Set-Content -LiteralPath $phasePath -Value 'startup' -Encoding ascii
if (Test-Path -LiteralPath $stopPath) { throw "Run label already used: $Label" }
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
Remove-Item Env:TANUKI_RUST_TRACE -ErrorAction SilentlyContinue
if ($GameProcessId -gt 0) {
  $game=Get-Process -Id $GameProcessId -ErrorAction Stop
  if($game.ProcessName -ne 'Among Us'){throw 'The target is not Among Us.'}
  $env:BETTERCREWLINK_TARGET_PROCESS='Among Us.exe'
  $env:BETTERCREWLINK_TARGET_PID=[string]$GameProcessId
} else {
  $env:BETTERCREWLINK_TARGET_PROCESS='__memory_comparison_no_game__.exe'
  Remove-Item Env:BETTERCREWLINK_TARGET_PID -ErrorAction SilentlyContinue
}
$env:BETTERCREWLINK_LITE='0'
$start=@{FilePath=$Executable;WorkingDirectory=(Split-Path $Executable -Parent);PassThru=$true;RedirectStandardOutput="$prefix.stdout.log";RedirectStandardError="$prefix.stderr.log"}
if ($CommandArguments.Count -gt 0) {$start.ArgumentList=$CommandArguments}
$appProcess=Start-Process @start
$null=$appProcess.Handle
$watch=[System.Diagnostics.Stopwatch]::StartNew()
@{label=$Label;rootPid=$appProcess.Id;executable=$Executable;arguments=$CommandArguments;gamePid=$GameProcessId;backend=$Backend;started=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath "$prefix.run.json" -Encoding utf8
$tree=@()
try {
  do {
    $all=@(Get-CimInstance Win32_Process)
    $ids=[System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($appProcess.Id)
    do {
      $before=$ids.Count
      foreach($p in $all) {if($ids.Contains([int]$p.ParentProcessId)){[void]$ids.Add([int]$p.ProcessId)}}
    } while($before -lt $ids.Count)
    $tree=@($all | Where-Object {$ids.Contains([int]$_.ProcessId)})
    if($Backend -eq 'rust' -and @($tree | Where-Object {$_.Name -in @('tanuki-node.exe','node.exe')}).Count -gt 0){throw 'Rust mode unexpectedly started Node.'}
    if($Backend -eq 'node' -and $watch.Elapsed.TotalSeconds -gt 20 -and -not $appProcess.HasExited -and @($tree | Where-Object {$_.Name -eq 'tanuki-node.exe'}).Count -ne 1){throw 'The Node baseline backend was not running.'}
    $entries=@(foreach($p in $tree) {
      try {
        $m=[AppMemoryProbe]::Read($p.ProcessId)
        $kind=if($p.ProcessId -eq $appProcess.Id){'host'} elseif($p.Name -eq 'tanuki-node.exe'){'node-reader'} elseif($p.CommandLine -match '--type=([^ ]+)'){$Matches[1]} else {$p.Name}
        [PSCustomObject]@{pid=$p.ProcessId;parentPid=$p.ParentProcessId;name=$p.Name;kind=$kind;privateWorkingSetBytes=$m.PrivateWorkingSetSize.ToUInt64();privateBytes=$m.PrivateUsage.ToUInt64();workingSetBytes=$m.WorkingSetSize.ToUInt64()}
      } catch { [PSCustomObject]@{pid=$p.ProcessId;name=$p.Name;error=$_.Exception.Message;privateWorkingSetBytes=0;privateBytes=0;workingSetBytes=0} }
    })
    $failed=@($entries | Where-Object { $_.PSObject.Properties['error'] })
    $private=[double]($entries | Measure-Object privateBytes -Sum).Sum
    $free=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1024
    @{time=(Get-Date).ToString('o');elapsedSeconds=[math]::Round($watch.Elapsed.TotalSeconds,2);phase=(Get-Content -LiteralPath $phasePath -Raw).Trim();privateWorkingSetBytes=($entries | Measure-Object privateWorkingSetBytes -Sum).Sum;privateBytes=$private;workingSetBytes=($entries | Measure-Object workingSetBytes -Sum).Sum;freeBytes=$free;processes=$entries;failedCount=$failed.Count} | ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath "$prefix.samples.jsonl" -Encoding utf8
    if($private -gt 6GB -or $free -lt 2GB){throw 'Memory safety threshold reached.'}
    if($failed.Count -eq $entries.Count -and $entries.Count -gt 0){throw 'Processes could not be measured; inspect samples.'}
    if(Test-Path -LiteralPath $stopPath){break}
    Start-Sleep -Seconds 2
    $appProcess.Refresh()
  } while(-not $appProcess.HasExited -and $watch.Elapsed.TotalSeconds -lt $DurationSeconds)
} finally {
  foreach($p in $tree) {
    $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)" -ErrorAction SilentlyContinue
    if($current -and $p.ExecutablePath -and $current.ExecutablePath -eq $p.ExecutablePath -and $current.CreationDate -eq $p.CreationDate){Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue}
  }
}
Write-Output "$Label finished after $([math]::Round($watch.Elapsed.TotalSeconds,1)) seconds."
