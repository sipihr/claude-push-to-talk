# Claude Push-to-Talk

*Push to talk. Release to send. Listen to the answer.*

Talk to Claude Code from anywhere in VS Code and hear its answers. This extension works alongside the official Claude Code extension, on Windows and on Linux (GNOME on Wayland).

- **Push to talk:** **Hold** a key anywhere in VS Code, speak, and release; the message is sent to Claude without pressing Enter. Or **tap** the key once to start dictation and once more to stop and send.
- **Cancel:** Press **Esc** while dictating to stop without sending.
- **Read aloud:** When Claude finishes a response, it is read to you with a voice that runs on your computer.

Dictation itself is done by the official Claude Code extension. This extension starts and stops it for you, sends the message, and reads the responses.

This is an independent extension. It is not made or endorsed by Anthropic.

## Requirements

- The official Claude Code extension, with voice dictation working. VS Code installs it together with this extension if it is missing.
- Windows 10 or 11, or Linux with GNOME on Wayland (tested on Ubuntu 26.04). See [Linux](#linux) for details.

## Getting started

1. Install the extension and reload the window.
2. The first time it starts, it asks which voice should read Claude's responses. Pick one, or press Esc to decide later; nothing is read aloud until a voice is selected. See [Voices](#voices).
3. Hold **Insert**, say something, and release. The message is sent to Claude.
4. When Claude finishes, the response is read aloud. This starts with the next Claude session you open.

## Keys

| Key | What it does | Where |
| --- | --- | --- |
| **Insert** (default) | **Hold:** dictation runs while the key is down; the message is sent on release. **Tap:** dictation starts and stays on; tap again to stop and send | Anywhere in VS Code; in the terminal only if **Dictation In Terminal** is on |
| **Ctrl+D** | The official dictation key, held or tapped in the same way; this extension adds sending when dictation stops | Claude panel only |
| **Esc** | Cancels the dictation in progress, whether it was started by holding or by a tap | While dictating |
| **Alt+X** (default) | Stops the current reading | Anywhere in VS Code |

**Insert** and **Alt+X** are the default keys, and both can be changed: open Keyboard Shortcuts (Ctrl+K Ctrl+S) and rebind **Claude Push-to-Talk: Global Dictation Key** and **Claude Push-to-Talk: Stop Speaking**. Ctrl+D is set by the official extension, and Esc is fixed.

With the default key, Insert no longer switches the editor to overtype mode.

A press shorter than 200 ms counts as a tap, a longer one as a hold.

When dictation starts, focus moves to the Claude input and stays there.

## Voices

One voice reads every response, whatever its language; the language of the text is not detected. No voice is selected at first.

| Kind | Where | What it is |
| --- | --- | --- |
| Windows voices | Windows | The voices installed in Windows. More can be added in the Windows speech settings |
| Piper voices | Windows and Linux | Natural-sounding voices from the [Piper](https://github.com/rhasspy/piper) project (about 180 voices in 58 languages), downloaded on request |

On Linux, Piper voices are the only kind, so the first start goes straight to the download list.

All voices are managed in one list: run **Claude Push-to-Talk: Select Read-Aloud Voice**. It shows the voices on your computer; pick one to make it the reading voice. The end of the list has the ways to get a further voice:

- **Download a Piper voice…** opens the list of Piper voices.
- **Install a Windows voice…** (Windows only) opens the Windows speech settings, where you add a voice with "Add voices". The new voice then appears in this list.
- **Remove downloaded voices…** deletes Piper voices one by one.

To download a Piper voice:

1. Choose **Download a Piper voice…** in that list.
2. Type your language and pick a voice.
3. A dialog shows the download size, where the files come from and the licence of the voice. Nothing is downloaded before you confirm.

The first download is about 90 MB (the speech engine and one voice); each further voice is about 60 MB. No administrator rights are needed. The voice you download becomes the selected voice.

Voices have different licences, and some do not allow commercial use (the Turkish voice, for example). Check that the licence allows your use.

If read aloud is on and no voice is selected, VS Code shows a warning after each response that could not be read, with buttons to select a voice or to turn read aloud off.

## What is read

- Code blocks, tables, links and Markdown symbols are left out.
- At most **Max Chars** characters of a response are read (1200 by default).

Reading stops when a new dictation starts, when you press Alt+X, or when the VS Code window is closed or reloaded.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Global Dictation | on | Enables the dictation key (Insert) anywhere in VS Code. When off, dictation works only in the Claude panel with Ctrl+D |
| Dictation In Terminal | off | Lets the dictation key work while the terminal is focused too. When off, the key goes to the program running in the terminal (for example, `vim` uses Insert) |
| Auto Submit | on | Sends the message when dictation stops (the key is released after a hold, or tapped a second time). When off, the text stays in the input box |
| Submit Delay Ms | 800 | How long to wait after dictation stops before the message is sent. The last words arrive a moment after you stop speaking; increase this if they are cut off. The minimum is 300 |
| Clear On Cancel | on | After a cancel with Esc, empties the input box. This removes everything in it, including text typed before dictating |
| Read Aloud | on | Reads responses aloud |
| Voice | none | The name of the voice that reads. Set it with **Claude Push-to-Talk: Select Read-Aloud Voice**; nothing is read until a voice is selected |
| Rate | 1.15 | Reading speed (1.0 is normal) |
| Max Chars | 1200 | The most characters read from one response (0 = no limit) |

## Commands

| Command | What it does |
| --- | --- |
| Claude Push-to-Talk: Global Dictation Key | The command behind Insert; rebind it to change the dictation key |
| Claude Push-to-Talk: Stop Speaking | Stops the current reading (Alt+X) |
| Claude Push-to-Talk: Select Read-Aloud Voice | Shows the voices on your computer to pick from. The end of the list lets you download a Piper voice, install a Windows voice (Windows only) or remove downloaded voices |
| Claude Push-to-Talk: Remove Downloaded Voices | Deletes downloaded Piper voices |
| Claude Push-to-Talk: Toggle Read Aloud | Turns read aloud on or off |
| Claude Push-to-Talk: Toggle Auto-Submit | Turns auto-submit on or off |

## Privacy and what changes on your computer

- **Nothing you say or hear is sent anywhere by this extension.** Voices run on your computer. Dictation is handled by the official Claude Code extension under its own terms.
- **Downloads happen only when you ask for a Piper voice.** The speech engine comes from `github.com/rhasspy/piper` and the voices from `huggingface.co/rhasspy/piper-voices`; the files are checked against their checksums.
- **Your Claude Code settings get one entry.** To know when a response is finished, the extension adds a `Stop` hook to `~/.claude/settings.json` when it starts with read aloud on. The rest of the file is left as it is. The entry is removed again when you uninstall the extension, and added again if you install it again.
- **Sending is done by pressing Enter for you.** The official extension has no "send" command, so this extension presses Enter in the Claude input (and Ctrl+A, Backspace when you cancel). It does this only while VS Code is the active window.
- **Files are kept in `~/.claude/push-to-talk`:** the downloaded voices, your read-aloud settings and a log.

## Linux

Tested on Ubuntu 26.04 with GNOME 50 on Wayland. Everything the extension needs is part of a standard Ubuntu desktop.

Wayland normally stops programs from watching the keyboard or pressing keys. On the tested setup the extension needs no extra permission:

- **Noticing that you released the key** works when VS Code runs through XWayland, which is how the VS Code snap runs.
- **Sending the message** uses GNOME's own remote desktop interface. GNOME's remote-control indicator appears in the top bar for a moment after each dictation.

Other setups:

- **VS Code as a native Wayland window:** the key release can only be noticed if your user is in the `input` group (`sudo usermod -aG input $USER`, then log out and in). That group lets every program you run read all keystrokes, so only add it if you need it. Without it, the dictation key works as a toggle: press once to start, press again to stop and send.
- **A desktop other than GNOME:** the first time the extension starts, the desktop shows an "Allow Remote Desktop" dialog. Allow it so the extension can press Enter for you.

## Troubleshooting

- **The message is not sent when dictation stops:** Open the Output panel and select "Claude Push-to-Talk". Every key press writes a line there, and `Enter: skipped` lines say why the message was not sent.
- **The last words are missing:** Increase **Submit Delay Ms**.
- **Nothing is read aloud:** Check that **Read Aloud** is on and a **Voice** is selected, then start a new Claude session; the hook takes effect in sessions started after it was added.
- **The dictation key does nothing in the terminal with Dictation In Terminal on:** If you have set `terminal.integrated.commandsToSkipShell` yourself, add `claudePushToTalk.dictationKeyGlobal` to it.
- **Linux, not GNOME: the message is not sent and the log says permission was not given:** The "Allow Remote Desktop" dialog was closed without allowing. Reload the window; the dialog is shown again.

## Known limitations

- The extension cannot see whether dictation is running; it works it out from your key presses. If you stop dictation another way (the microphone button, or by editing the text), the next key press may be misread.
- Any text already in the input box is sent together with the dictation.
- Esc also reaches the Claude panel, so cancelling a dictation while Claude is responding may interrupt that response too.
- Responses from every Claude Code session are read, including sessions in a terminal outside VS Code.
- With several VS Code windows open, closing or reloading any of them stops the current reading.
- If text is selected in the editor when you press the dictation key, the official extension adds a reference to it to the input box.
- An update of the official Claude Code extension can change the behavior this extension relies on; it may then need an update too.

## Removing the extension

When you uninstall the extension, its entry in `~/.claude/settings.json` is removed for you within a couple of seconds, and reading aloud stops. If you uninstall it while VS Code is closed, the entry is removed the next time VS Code starts.

The `~/.claude/push-to-talk` folder is kept, because it holds the voices you downloaded. Delete it yourself if you no longer want them.
