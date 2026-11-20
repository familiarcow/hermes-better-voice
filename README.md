# Better Voice

Fully local dictation for Hermes Desktop.

- **Live words while you speak**, then an **accurate final pass** when you stop.
- **Record the next take while earlier ones transcribe.** Each take is its own row, inserted in order. Nothing is sent unless you want it to be.
- **Queued send**: press Enter while a take is transcribing and it sends once the text lands. Optional auto-send with a cancel countdown. Attachments go along.
- **Never loses speech**: cancel with ×, then Undo. If the app quits or the network drops, unfinished takes can be restored from ⌘K → "Better Voice: restore recent dictations".
- **Your keys**: hold Space, or pick any key or mouse button; hold or tap the mic.
- **No cloud.** Audio never leaves your machine.

Tested on macOS (Apple Silicon). Needs Hermes 0.23+ and, for the live-preview setup, Python 3.10+ on the machine (the setup script finds it).

## How it works (and why two models)

| Part | What it does |
|---|---|
| **Moonshine** (small streaming model, ~0.1 s lag, ~1 CPU core) | Produces the *live preview* while you talk. Fast, but makes more mistakes, especially on names. Optional. |
| **Whisper large-v3-turbo** (via faster-whisper, ~1.6 GB) | Produces the *final text* once you stop and replaces the preview. Accurate, but works on whole recordings, so it can't type as you speak. |
| **Gateway half** (`engine.py`, Python) | Runs wherever Hermes runs. Receives audio, runs both models, keeps finished text safe. |
| **Desktop half** (`desktop/plugin.js`) | Runs inside Hermes Desktop. Records the mic, draws the rows, settings page, sending. |

Both halves are needed. If either is missing, Hermes falls back to its stock microphone.

## Install

Repo: https://github.com/FamiliarCow/hermes-better-voice

1. **Install the plugin** on the machine that runs Hermes:
   ```
   hermes plugins install FamiliarCow/hermes-better-voice
   python3 ~/.hermes/plugins/better-voice/setup_runtime.py
   hermes plugins enable better-voice
   hermes config set stt.provider better_voice
   hermes config set stt.streaming true
   ```
   `setup_runtime.py` is the only step that downloads anything (Moonshine ~100 MB, Whisper turbo ~1.6 GB). It prints the exact config commands for the choices you make; `--check` shows what is installed.
2. **Desktop half.**
   - If Hermes Desktop runs on the **same machine** as Hermes, Hermes copies `desktop/plugin.js` into the app on the next Rescan or app restart. Open Capabilities → Plugins, turn Better Voice on for the desktop, and Rescan if needed.
   - If the app runs on a **different machine** (remote gateway), the Plugins page shows the desktop half as "unavailable (remote backend)". Use **Install from Git** with the Desktop target checked and the same repo, or copy `desktop/plugin.js` to `~/.hermes/desktop-plugins/better-voice/plugin.js` on that machine.
   - Then ⌘K → "Reload desktop plugins".
3. Hold Space in the composer and talk.

If you have another dictation plugin (for example `hold-to-talk` or `voice-hud`), remove it from `~/.hermes/desktop-plugins` first; they fight over the same keys.

## Choose your setup

| You want | Run |
|---|---|
| Default: live preview + best accuracy | `setup_runtime.py` |
| More accurate live text, more CPU (~1.7 cores) | `setup_runtime.py --live medium` |
| Lightest install, no live words | `setup_runtime.py --live none` |
| Less RAM for the final pass | `setup_runtime.py --final small.en` |

The final model defaults to `large-v3-turbo`; change it any time with `hermes config set stt.better_voice.final_model small.en`.

Hints for names and jargon the models get wrong: `hermes config set stt.prompt "Your Company, Colleague Name, ProductName"`.

## Settings

Settings → Plugins → Better Voice (or ⌘K → "Better Voice: settings"): hold-to-talk trigger, hold delay, start/stop sound (Off, Soft sub, Marimba), insert style, live preview on/off, auto-send and its delay, include attachments, hide the stock voice-conversation button. Defaults are neutral; the plugin never hides stock UI unless you ask.

## Privacy

- All transcription runs on the machine running Hermes. This plugin sends no audio or text to any service.
- Each take's audio is written to `$HERMES_HOME/better-voice/spool/` (permissions 0600) so it survives a crash, and removed when the text is delivered or after 24 hours. Finished but undelivered text is kept 6 hours for "Restore".
- The only network use is `setup_runtime.py`, when you run it.

## Known limits

- A background take landing moves your caret to the end of the draft.
- Undo after cancelling doesn't bring back a queued send.
- Mic detection uses the English button labels; if it fails, the stock mic still works.
- Auto-send with attachments falls back to text-only when the agent is busy.
- Tested on macOS (Apple Silicon) only; not tested on a fresh machine or on other platforms.

## Tests

Gateway engine tests (need a short 16 kHz speech WAV of your own):
```
python tests/smoke.py your.wav
python tests/hardening.py your.wav
```

## Roll back / uninstall

`hermes plugins disable better-voice`, `hermes config set stt.provider <your previous provider>`, delete `~/.hermes/desktop-plugins/better-voice`.

## Licence

MIT. See `LICENSE` and `NOTICE.md` (Moonshine, faster-whisper, smart-dictation's `local_stt`).
