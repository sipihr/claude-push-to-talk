# Claude Push-to-Talk - key watcher helper.
# Reads commands from stdin, one per line:
#   wait <vk> [<vk>...] -> waits until one of the given keys is released, then writes "released"
#   waitany -> takes a snapshot of the keys held down right now, waits until one of them is released,
#              then writes "released" (so the caller does not need to know which key it is bound to);
#              writes "cancelled" instead if Esc is pressed while waiting
#   voices -> writes the installed Windows voices as one line of JSON
#   waitidle -> waits until no key is held down, then writes "idle"
#   clear -> presses Ctrl+A, Backspace if VS Code is the foreground window
#   enter -> once the modifier keys are released, presses Enter if VS Code is the foreground window
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

$src = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class PushToTalkKeys {
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    public static bool IsDown(int vKey) {
        return (GetAsyncKeyState(vKey) & 0x8000) != 0;
    }

    public static string ForegroundProcess() {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
    }

    public static void PressSelectAllAndDelete() {
        keybd_event(0x11, 0, 0, UIntPtr.Zero);   // Ctrl down
        keybd_event(0x41, 0, 0, UIntPtr.Zero);   // A down
        keybd_event(0x41, 0, 2, UIntPtr.Zero);   // A up
        keybd_event(0x11, 0, 2, UIntPtr.Zero);   // Ctrl up
        keybd_event(0x08, 0, 0, UIntPtr.Zero);   // Backspace down
        keybd_event(0x08, 0, 2, UIntPtr.Zero);   // Backspace up
    }

    public static void PressEnter() {
        keybd_event(0x0D, 0, 0, UIntPtr.Zero);
        keybd_event(0x0D, 0, 2, UIntPtr.Zero);
    }
}
"@
Add-Type -TypeDefinition $src

# Key that cancels a dictation in progress (Esc). The environment variable is for tests only.
$VK_CANCEL = if ($env:CLAUDE_PUSH_TO_TALK_CANCEL_VK) { [int]$env:CLAUDE_PUSH_TO_TALK_CANCEL_VK } else { 0x1B }
$VK_D = 0x44; $VK_CTRL = 0x11; $VK_SHIFT = 0x10; $VK_ALT = 0x12; $VK_LWIN = 0x5B; $VK_RWIN = 0x5C

function Reply([string]$text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

Reply 'ready'

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $parts = $line.Trim() -split '\s+'
    switch ($parts[0]) {
        'wait' {
            # wait <vk> [<vk>...]: waits for as long as all of the given keys are held down
            $keys = @($parts | Select-Object -Skip 1 | ForEach-Object { [int]$_ })
            if ($keys.Count -eq 0) { $keys = @($VK_D, $VK_CTRL) }
            $deadline = (Get-Date).AddSeconds(120)
            while ((Get-Date) -lt $deadline) {
                $allDown = $true
                foreach ($k in $keys) { if (-not [PushToTalkKeys]::IsDown($k)) { $allDown = $false; break } }
                if (-not $allDown) { break }
                Start-Sleep -Milliseconds 15
            }
            Reply 'released'
        }
        'waitany' {
            # 7..254 skips the mouse buttons (1-6). The cancel key (Esc) is watched separately.
            $cancelWasDown = [PushToTalkKeys]::IsDown($VK_CANCEL)
            $keys = @(7..254 | Where-Object { $_ -ne $VK_CANCEL -and [PushToTalkKeys]::IsDown($_) })
            $deadline = (Get-Date).AddSeconds(120)
            $cancelled = $false
            while ($keys.Count -gt 0 -and (Get-Date) -lt $deadline) {
                if (-not $cancelWasDown -and [PushToTalkKeys]::IsDown($VK_CANCEL)) { $cancelled = $true; break }
                $anyUp = $false
                foreach ($k in $keys) { if (-not [PushToTalkKeys]::IsDown($k)) { $anyUp = $true; break } }
                if ($anyUp) { break }
                Start-Sleep -Milliseconds 15
            }
            if ($cancelled) { Reply 'cancelled' } else { Reply 'released' }
        }
        'waitidle' {
            # Waits until no key at all is held down.
            $deadline = (Get-Date).AddSeconds(120)
            while ((Get-Date) -lt $deadline) {
                $down = @(7..254 | Where-Object { [PushToTalkKeys]::IsDown($_) })
                if ($down.Count -eq 0) { break }
                Start-Sleep -Milliseconds 20
            }
            Reply 'idle'
        }
        'clear' {
            # Select all + Backspace in the focused input, only if VS Code is the foreground window.
            $deadline = (Get-Date).AddSeconds(3)
            while ((Get-Date) -lt $deadline) {
                $down = @(7..254 | Where-Object { [PushToTalkKeys]::IsDown($_) })
                if ($down.Count -eq 0) { break }
                Start-Sleep -Milliseconds 15
            }
            $fg = [PushToTalkKeys]::ForegroundProcess()
            if ($down.Count -gt 0) {
                Reply 'skipped: a key is still down'
            } elseif ($fg -like 'Code*') {
                [PushToTalkKeys]::PressSelectAllAndDelete()
                Reply 'cleared'
            } else {
                Reply "skipped: foreground is $fg"
            }
        }
        'enter' {
            $deadline = (Get-Date).AddSeconds(3)
            while ((Get-Date) -lt $deadline) {
                $mods = [PushToTalkKeys]::IsDown($VK_CTRL) -or [PushToTalkKeys]::IsDown($VK_SHIFT) -or
                        [PushToTalkKeys]::IsDown($VK_ALT) -or [PushToTalkKeys]::IsDown($VK_LWIN) -or
                        [PushToTalkKeys]::IsDown($VK_RWIN)
                if (-not $mods) { break }
                Start-Sleep -Milliseconds 15
            }
            $fg = [PushToTalkKeys]::ForegroundProcess()
            if ($mods) {
                Reply 'skipped: modifier still down'
            } elseif ($fg -like 'Code*') {
                [PushToTalkKeys]::PressEnter()
                Reply 'sent'
            } else {
                Reply "skipped: foreground is $fg"
            }
        }
        'voices' {
            try {
                Add-Type -AssemblyName System.Runtime.WindowsRuntime
                [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
                # Windows keeps a per-application list of voices that can still name voices that were uninstalled.
                # A voice is real only if its registry token still exists.
                $list = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { -not ($_.Id -like 'HKEY_*') -or (Test-Path ('Registry::' + $_.Id)) } | ForEach-Object {
                    @{ name = $_.DisplayName; lang = $_.Language; gender = "$($_.Gender)" }
                })
                Reply (ConvertTo-Json -InputObject $list -Compress)
            } catch {
                Reply '[]'
            }
        }
        'ping' { Reply 'pong' }
        default { Reply 'unknown' }
    }
}
