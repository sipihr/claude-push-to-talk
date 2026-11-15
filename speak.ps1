# Claude Push-to-Talk - reads Claude's last response aloud.
# Runs in two modes:
#   (no parameters) Claude Code Stop hook: reads the hook JSON from stdin, prepares the text,
#                   hands the reading off to a separate hidden process and exits immediately.
#   -Worker         Reads the text file aloud with a Windows (OneCore) voice,
#                   or with a Piper voice downloaded by the extension.
# This file must contain ASCII only (Windows PowerShell 5.1 compatibility).
param(
    [switch]$Worker,
    [string]$TextFile
)

$dir = Join-Path $env:USERPROFILE '.claude\push-to-talk'
$pidFile = Join-Path $dir 'tts.pid'
$cfgFile = Join-Path $dir 'config.json'
$logFile = Join-Path $dir 'speak.log'
# Piper (a neural speech engine) and its voices, downloaded by the extension when the user asks for one.
$piperExe = Join-Path $dir 'piper\engine\piper\piper.exe'
$piperVoices = Join-Path $dir 'piper\voices'
# Touched when a response could not be read because no voice is selected; the extension watches it and tells the user.
$noVoiceFile = Join-Path $dir 'no-voice'
$noVoiceMessage = 'nothing read: no voice is selected (run "Claude Push-to-Talk: Select Read-Aloud Voice" in VS Code)'

function Write-NoVoice {
    Write-Log $noVoiceMessage
    try { [IO.File]::WriteAllText($noVoiceFile, (Get-Date -Format s)) } catch {}
}

function Write-Log([string]$msg) {
    try { Add-Content -Path $logFile -Value ("{0} {1}" -f (Get-Date -Format s), $msg) -Encoding UTF8 } catch {}
}

function Read-Config {
    $c = @{ readAloud = $true; voice = ''; rate = 1.15; maxChars = 1200 }
    if (Test-Path $cfgFile) {
        try {
            $j = [IO.File]::ReadAllText($cfgFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
            foreach ($k in @('readAloud', 'voice', 'rate', 'maxChars')) {
                if ($null -ne $j.$k) { $c[$k] = $j.$k }
            }
        } catch {}
    }
    return $c
}

function Stop-Previous {
    if (Test-Path $pidFile) {
        try {
            $old = [int]([IO.File]::ReadAllText($pidFile).Trim())
            $p = Get-Process -Id $old -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -like 'powershell*') { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue }
        } catch {}
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-LastAssistantText($hook) {
    if ($hook.last_assistant_message) { return [string]$hook.last_assistant_message }
    $path = $hook.transcript_path
    if (-not $path -or -not (Test-Path $path)) { return '' }
    $lines = Get-Content -Path $path -Tail 80 -Encoding UTF8
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        try { $e = $lines[$i] | ConvertFrom-Json } catch { continue }
        if ($e.type -ne 'assistant' -or -not $e.message) { continue }
        $parts = @($e.message.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text })
        $t = ($parts -join "`n").Trim()
        if ($t) { return $t }
    }
    return ''
}

function ConvertTo-Speakable([string]$t, [int]$maxChars) {
    $t = [regex]::Replace($t, '(?s)```.*?```', ' ')                 # code blocks
    $t = [regex]::Replace($t, '(?m)^\s*\|.*\|\s*$', ' ')            # table rows
    $t = [regex]::Replace($t, '!?\[([^\]]*)\]\([^)]*\)', '$1')      # links
    $t = [regex]::Replace($t, 'https?://\S+', ' ')
    $t = [regex]::Replace($t, '(?m)^\s{0,3}#{1,6}\s*', '')          # headings
    $t = [regex]::Replace($t, '(?m)^\s*([-*+]|\d+\.)\s+', '')       # list markers
    $t = [regex]::Replace($t, '(?m)^\s*>\s?', '')
    $t = [regex]::Replace($t, '[`*_~#|<>]', '')
    $t = [regex]::Replace($t, '\s+', ' ').Trim()
    if ($maxChars -gt 0 -and $t.Length -gt $maxChars) {
        $cut = $t.Substring(0, $maxChars)
        $end = $cut.LastIndexOfAny([char[]]'.!?')
        if ($end -gt ($maxChars / 2)) { $cut = $cut.Substring(0, $end + 1) }
        $t = $cut
    }
    return $t
}

# Keys of the downloaded Piper voices, e.g. 'tr_TR-dfki-medium'.
function Get-PiperVoices {
    if (-not (Test-Path $piperExe) -or -not (Test-Path $piperVoices)) { return @() }
    return @(Get-ChildItem -Path $piperVoices -Filter '*.onnx' |
        Where-Object { Test-Path ($_.FullName + '.json') } |
        ForEach-Object { $_.BaseName } | Sort-Object)
}

# The Piper voice to read with, or $null if the chosen voice is not a Piper voice.
function Select-PiperVoice($cfg) {
    if (-not $cfg.voice) { return $null }
    $voices = @(Get-PiperVoices)
    if ($voices -contains [string]$cfg.voice) { return [string]$cfg.voice }
    return $null
}

# Text as a JSON string with every non-ASCII character escaped, so no code page can damage it on the way to Piper.
function ConvertTo-AsciiJson([string]$text) {
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $text.ToCharArray()) {
        $c = [int]$ch
        if ($c -eq 34 -or $c -eq 92) { [void]$sb.Append('\').Append($ch) }
        elseif ($c -lt 32 -or $c -gt 126) { [void]$sb.Append('\u').Append($c.ToString('x4')) }
        else { [void]$sb.Append($ch) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

# Piper voices. Throws if Piper could not produce the audio.
function New-PiperWav([string]$text, [string]$wav, $cfg, [string]$key) {
    $model = Join-Path $piperVoices ($key + '.onnx')
    $scale = 1.0
    try {
        $info = [IO.File]::ReadAllText($model + '.json', [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($info.inference.length_scale) { $scale = [double]$info.inference.length_scale }
    } catch {}
    $speed = 1.0
    try { $speed = [Math]::Min(4.0, [Math]::Max(0.25, [double]$cfg.rate)) } catch {}
    $length = ($scale / $speed).ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $piperExe
    $psi.Arguments = ('--model "{0}" --output_file "{1}" --length_scale {2} --json-input --quiet' -f $model, $wav, $length)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $line = '{"text": ' + (ConvertTo-AsciiJson $text) + '}'
    $bytes = [Text.Encoding]::ASCII.GetBytes($line + "`n")
    $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $proc.StandardInput.BaseStream.Flush()
    $proc.StandardInput.Close()
    if (-not $proc.WaitForExit(120000)) {
        try { $proc.Kill() } catch {}
        throw 'Piper did not finish in time'
    }
    if ($proc.ExitCode -ne 0 -or -not (Test-Path $wav)) { throw ('Piper failed with exit code ' + $proc.ExitCode) }
    Write-Log ("speaking: {0} chars, voice: {1}" -f $text.Length, $key)
}

# Built-in Windows (OneCore) voices. Returns $false if the chosen voice is not one of them.
function New-WindowsWav([string]$text, [string]$wav, $cfg) {
    if (-not $cfg.voice) { return $false }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
    $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    # Voices that were uninstalled can still be listed by Windows; a voice is real only if its registry token exists.
    $voices = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { -not ($_.Id -like 'HKEY_*') -or (Test-Path ('Registry::' + $_.Id)) })

    $voice = $voices | Where-Object { $_.DisplayName -like "*$($cfg.voice)*" } | Select-Object -First 1
    if (-not $voice) { return $false }
    $synth.Voice = $voice
    Write-Log ("speaking: {0} chars, voice: {1}" -f $text.Length, $synth.Voice.DisplayName)
    try { $synth.Options.SpeakingRate = [double]$cfg.rate } catch {}

    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $op = $synth.SynthesizeTextToStreamAsync($text)
    $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op))
    [void]$task.Wait(60000)
    $stream = $task.Result

    $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $fs = [IO.File]::Create($wav)
    try { $net.CopyTo($fs) } finally { $fs.Close(); $net.Close() }
    return $true
}

function Invoke-Speak([string]$text, $cfg) {
    $wav = Join-Path $dir ("tts-{0}.wav" -f $PID)
    $made = $false
    $key = Select-PiperVoice $cfg
    if ($key) {
        try {
            New-PiperWav $text $wav $cfg $key
            $made = $true
        } catch {
            Write-Log ("Piper: " + $_.Exception.Message)
            return
        }
    }
    if (-not $made) { $made = [bool](New-WindowsWav $text $wav $cfg) }
    # Only the chosen voice reads; without one (or if it is no longer installed) nothing is read.
    if (-not $made) {
        Write-NoVoice
        return
    }

    if ($env:CLAUDE_PUSH_TO_TALK_NOPLAY) { return $wav }   # test: exit without playing
    try {
        $player = New-Object System.Media.SoundPlayer $wav

        # Length of the audio, from the WAV header (byte rate is at offset 28).
        $seconds = 0
        try {
            $fs = [IO.File]::OpenRead($wav)
            $hdr = New-Object byte[] 44
            [void]$fs.Read($hdr, 0, 44)
            $len = $fs.Length
            $fs.Close()
            $byteRate = [BitConverter]::ToInt32($hdr, 28)
            if ($byteRate -gt 0) { $seconds = ($len - 44) / $byteRate }
        } catch {}

        # Stop reading if VS Code was running when the reading started and has since been closed.
        # (If it was not running, e.g. Claude Code in a standalone terminal, the reading is left alone.)
        $watch = if ($env:CLAUDE_PUSH_TO_TALK_WATCH) { $env:CLAUDE_PUSH_TO_TALK_WATCH } else { 'Code' }
        $wasRunning = [bool](Get-Process -Name $watch -ErrorAction SilentlyContinue)
        if ($seconds -le 0 -or -not $wasRunning) {
            $player.PlaySync()
        } else {
            $player.Play()
            $end = (Get-Date).AddSeconds($seconds + 0.3)
            $tick = 0
            while ((Get-Date) -lt $end) {
                Start-Sleep -Milliseconds 200
                $tick++
                if (($tick % 3) -eq 0 -and -not (Get-Process -Name $watch -ErrorAction SilentlyContinue)) {
                    $player.Stop()
                    Write-Log "stopped: $watch was closed"
                    break
                }
            }
        }
    } finally {
        Remove-Item $wav -Force -ErrorAction SilentlyContinue
    }
}

try {
    if (-not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
    $cfg = Read-Config

    if ($Worker) {
        [IO.File]::WriteAllText($pidFile, "$PID")
        # Remove audio files left behind by readings that were interrupted.
        Get-ChildItem -Path $dir -Filter 'tts-*.wav' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-2) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
        try {
            $text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
            Remove-Item $TextFile -Force -ErrorAction SilentlyContinue
            if ($text.Trim()) { [void](Invoke-Speak $text $cfg) }
        } finally {
            if ((Test-Path $pidFile) -and ([IO.File]::ReadAllText($pidFile).Trim() -eq "$PID")) {
                Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
            }
        }
        exit 0
    }

    # --- Hook mode ---
    if (-not $cfg.readAloud) { exit 0 }
    $reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
    $raw = $reader.ReadToEnd()
    if (-not $raw.Trim()) { exit 0 }
    $hook = $raw | ConvertFrom-Json

    $text = ConvertTo-Speakable (Get-LastAssistantText $hook) ([int]$cfg.maxChars)
    if (-not $text) { exit 0 }
    if (-not $cfg.voice) {
        Write-NoVoice
        exit 0
    }

    Stop-Previous
    $txt = Join-Path $dir ("say-{0}.txt" -f $PID)
    [IO.File]::WriteAllText($txt, $text, (New-Object Text.UTF8Encoding $false))
    $psArgs = @('-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Worker', '-TextFile', "`"$txt`"")
    Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -WindowStyle Hidden
    exit 0
} catch {
    Write-Log ("ERROR: " + $_.Exception.Message)
    exit 0
}
