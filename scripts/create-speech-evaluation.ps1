param([string[]]$Voices = @('Microsoft Haruka Desktop', 'Microsoft Ichiro'))
$ErrorActionPreference = 'Stop'
# Synthetic test fixtures only. No physical microphone or cloud service is used.
Add-Type -AssemblyName System.Speech
$taskSynth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$taskCorpus = Join-Path $env:LOCALAPPDATA 'TanukiBCL/Speech/evaluation'
$taskWords = @('インポスター','ポスター','クルーメイト','タスク','ボイスストーン','インポスターが来た','変身','あっ')
$taskFormat = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
$taskCases = @()
try {
    $taskInstalled = $taskSynth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
    foreach ($taskVoice in $Voices) { if ($taskVoice -notin $taskInstalled) { throw "Local TTS voice unavailable: $taskVoice" } }
    New-Item -ItemType Directory -Path $taskCorpus -Force | Out-Null
    foreach ($taskVoice in $Voices) {
        $taskSynth.SelectVoice($taskVoice)
        for ($taskIndex = 0; $taskIndex -lt $taskWords.Count; $taskIndex++) {
            $taskName = ($taskVoice -replace ' ','_') + '-' + $taskIndex + '.wav'
            $taskSynth.SetOutputToWaveFile((Join-Path $taskCorpus $taskName),$taskFormat)
            $taskSynth.Speak($taskWords[$taskIndex])
            $taskSynth.SetOutputToNull()
            $taskCases += @{file=$taskName;text=$taskWords[$taskIndex];voice=$taskVoice}
        }
    }
    ConvertTo-Json -InputObject $taskCases | Set-Content -LiteralPath (Join-Path $taskCorpus 'cases.json') -Encoding utf8
    Write-Output $taskCorpus
} finally { $taskSynth.Dispose() }
