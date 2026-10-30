# Glance

A macOS overlay that answers questions about your screen and your calls using Claude, and saves meeting notes.

## Setup

1. Install the audio and transcription tools: `brew install sox whisper-cpp`
2. Download the speech models into `models/` (they are not in git):
   ```sh
   curl -L -o models/ggml-base.en.bin  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
   curl -L -o models/ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
   ```
3. `npm install`
4. `npm run package`, then `npm start` to open `dist/Glance-darwin-arm64/Glance.app`.
5. Paste an Anthropic API key from console.anthropic.com when asked. It is stored in the macOS login keychain.

`npm run dev` runs from source, but macOS won't grant it screen recording, so screenshots only work in the packaged app.

## Using it

| Default shortcut | Action |
| --- | --- |
| ⌘⇧2 | Screenshot and answer |
| ⌘↵ | Ask what you've typed (or the latest question heard) |
| ⌘⇧\ | Start or stop listening |
| ⌘\ | Show or hide Glance |
| ⌘⇧1 | Add a screenshot without asking |
| ⌘⇧H | Hide from screen sharing |
| ⌘ + arrows | Move the window |

Shortcuts can be changed in Settings > Keyboard. The menu bar icon shows or hides the window; right-click it for more.

Settings (the gear) covers:

- **Answers:** model (Opus 5.5, Sonnet 5.5 or Haiku 5.5), depth (Quick, Balanced, Thorough), style (Natural or Brief), custom instructions (compressed automatically when saved), and whether every question includes a screenshot.
- **Listening:** Accurate or Fast transcription, plus words to recognize (names, products, jargon).
- **Privacy:** hide from screen sharing.
- **Session:** the transcript, spending so far, Save notes, Clear session.
- **Keyboard:** remap every shortcut.

While listening, a question from the other side shows a **Question** tag with an **Answer** button. Each answer shows its estimated cost. Glance follows the macOS light or dark appearance.

Settings > Session > Save notes writes a Markdown file to `~/Documents/Glance/` with a summary, decisions, action items, the transcript and every question asked.

## How it works

- `src/main.js`: window, shortcuts, screenshots, keychain, notes, logging.
- `src/audio.js`: mic (sox) and system audio (audiotee) capture, speech detection, Whisper transcription.
- `src/claude.js`: prompts and Claude API calls (Opus 5.5 by default; Sonnet 5.5 and Haiku 5.5 selectable), error messages, per-model cost estimates. Custom-instruction compression always uses Opus.
- `src/compress.js`: caveman-style compression of the transcript and other text sent on every question.
- `src/ui/`: the interface. `questions.js` detects questions in the transcript, `markdown.js` renders answers and `highlight.js` colors code.

Settings live in `~/Library/Application Support/glance/config.json`, logs in `~/Library/Logs/Glance/glance.log`.

## Tests

`npm test` covers compression, question detection, speech segmenting (including background noise and a dying microphone), answer rendering, code highlighting and error messages.
