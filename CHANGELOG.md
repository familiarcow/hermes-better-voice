# Changelog

## 1.0.2
- Dictation now lands where your cursor is: with text highlighted in the composer it replaces the highlight, with the cursor mid-text it inserts there. Short fixes are lowercased and lose the trailing period so they read as part of the sentence. Replacements never auto-send.
- Holding the trigger key over highlighted text dictates over it instead of typing a space over it (a quick tap still types the space).

## 1.0.1
- Auto-send now shows a countdown ring in the dictation bar (no more toasts). Record again to keep going, or click x / press Esc to cancel.
- Auto-send settings reworded: it sends after transcribing finishes, after the delay you pick.

## 1.0.0
First release.
- Hold SPACE (or any key / mouse button you choose) or hold/tap the mic to dictate; live word-by-word text while you speak (Moonshine), accurate final text when you stop (faster-whisper).
- Record the next take while earlier ones are still transcribing. One stacked row per take, inserted in order, never auto-sent unless you turn that on.
- Queued send (press Enter while transcribing), optional auto-send with a cancel countdown, attachments included.
- Cancel a transcription with x, with Undo. Timeouts and crashes keep your words: unfinished takes are recoverable with "Restore recent dictations".
- Settings page (Settings > Plugins > Better Voice) and a setup script for the local models.
- Start/stop sound: Off, Soft sub (default) or Marimba, with click-to-preview.
- Hold-to-talk also works when focus is on the chat rather than the composer (no flood of spaces).
- Fully local: no audio leaves your machine.
