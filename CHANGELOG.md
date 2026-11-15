# Changelog

All notable changes to Claude Push-to-Talk are listed here.

## 1.0.0 - 2026-11-15

First public release.

### Dictation

- Hold **Insert** anywhere in VS Code to dictate to Claude Code; the message is sent when you release the key.
- Tap the key instead to start dictation and tap again to stop and send.
- The official dictation key, **Ctrl+D** in the Claude panel, also sends the message when dictation stops.
- **Esc** cancels a dictation without sending and empties the input box.
- Dictating with text selected in the editor sends a reference to the selection along with what you say.
- Optional: let the dictation key work while the terminal is focused.

### Read aloud

- Responses are read aloud when Claude finishes, with a voice that runs on your computer.
- Windows voices and downloadable Piper voices on Windows; Piper voices on Linux.
- One list to select a voice, download a Piper voice, install a Windows voice or remove downloaded voices.
- **Alt+X** stops the current reading. Reading also stops when a new dictation starts or the window is closed.
- Settings for reading speed and the most characters read from a response.

### Platforms

- Windows 10 and 11.
- Linux with GNOME on Wayland (tested on Ubuntu 26.04).
