# Glance

A macOS overlay that answers questions about your screen and your calls using an LLM (Claude by default, or any OpenAI-compatible model), and saves meeting notes.

## Setup

1. Install the transcription tool: `brew install whisper-cpp`
2. Download the speech models into `models/` (they are not in git):
   ```sh
   curl -L -o models/ggml-base.en.bin  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
   curl -L -o models/ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
   ```
3. `npm install`
4. `npm run package`, then `npm start` to open `dist/Glance-darwin-arm64/Glance.app`.
5. Choose who answers and add an API key when asked: Anthropic (key from console.anthropic.com), or any OpenAI-compatible API with its base URL and model name (OpenAI, Google Gemini, OpenRouter, Groq, Mistral, or a local Ollama or LM Studio, which needs no key). Keys are stored in the macOS login keychain. Change it later in Settings > Answers > AI provider.

`npm run dev` runs from source, but macOS won't grant it screen recording, so screenshots only work in the packaged app.

## Using it

| Default shortcut | Action |
| --- | --- |
| ⌘⇧2 | Screenshot and answer |
| ⌘↵ | Answer the question just heard, or what you've typed |
| ⌘⇧\ | Start or stop listening |
| ⌘\ | Show or hide Glance |
| ⌘⇧1 | Add a screenshot without asking |
| ⌘⇧H | Hide from screen sharing |
| ⌘ + arrows | Move the window |

Shortcuts can be changed in Settings > General > Shortcuts. The menu bar icon shows or hides the window; right-click it for more.

Settings (the gear) has four tabs:

- **Answers:** who answers (AI provider and key), model (Opus 5.5, Sonnet 5.5 or Haiku 5.5 on Anthropic), depth (Quick, Balanced, Thorough), style (Natural, Brief or Interview), custom instructions (compressed automatically when saved), and whether every question includes a screenshot.
- **Interview:** Interview mode (first-person answers to say aloud), your resume and the job description. Warns when Glance would show in a screen share.
- **Session:** spending so far, the transcript, Save notes, Clear session.
- **General:** Accurate or Fast transcription, words to recognize, hide from screen sharing, shortcuts.

Panels opened from Settings (resume, instructions, provider, transcript, shortcuts) have a Back button and return to the same tab.

While listening, a question from the other side (the Mac's audio) shows a **Question** tag with an **Answer** button. Glance never listens to your microphone: the transcript holds only the other side, and your side in notes comes from the answers you asked for. Each answer shows its estimated cost. Glance follows the macOS light or dark appearance.

**Interviews:** pick Interview from the mode menu beside the question box (Meeting is the everyday mode), or Settings > Interview > Interview mode. Under Settings > Interview > Resume and Job description, import a PDF, Word, RTF or text file (or paste). Both are sent word for word with every question, never compressed, up to 20,000 characters each. Any style uses them for questions about you or the role; Interview mode also answers in your voice, ready to say aloud; check imported text, since PDFs can merge lines. Add your name, salary expectation, visa status and notice period under Settings > Interview > Your details. Interview answers open compact: the bold first line plus 3 or 4 key phrases to glance at while you talk, with **Full answer** for the whole thing. If you said something different, press **I said something else** under the answer and type a few words; follow-up answers build on that instead of the suggestion. Answers come back in first person, ready to say aloud, using your resume as a case study: stories are built from your real roles and projects, with no placeholders, and a short note lists any details Glance added so you can check them. `node test/interview-eval.js` runs sample interview questions against the real API to check the answers.

Settings > Session > Save notes writes a Markdown file to `~/Documents/Glance/` with a summary, decisions, action items, the transcript and every question asked.

## How it works

- `src/main.js`: window, shortcuts, screenshots, keychain, notes, logging.
- `src/audio.js`: system audio (audiotee) capture, speech detection, Whisper transcription (kept loaded in `whisper-server`). The mic is never recorded.
- `src/assistant.js`: prompts and features (answers, instruction compression, notes), independent of any vendor. Custom-instruction compression uses Opus on Anthropic, otherwise the chosen model.
- `src/providers.js`: LLM providers behind one interface: Anthropic (Opus 5.5 by default; Sonnet 5.5 and Haiku 5.5 selectable, cost estimates, prompt caching) and OpenAI-compatible (streaming over fetch; cost unknown, so tokens only). Adding a provider means adding one adapter here.
- `src/compress.js`: caveman-style compression of the transcript and other text sent on every question.
- `src/ui/`: the interface. `questions.js` detects questions in the transcript, `markdown.js` renders answers and `highlight.js` colors code.

Settings live in `~/Library/Application Support/glance/config.json`, logs in `~/Library/Logs/Glance/glance.log`.

## Tests

`npm test` covers compression, question detection, speech segmenting (including background noise and system audio dropping out), whisper-server restarts, answer rendering, code highlighting and error messages. `test/ui.test.js` clicks through the real app (setup, every Settings tab and form, the mode menu, answers, compact view, what you said) in a see-through test window with its own settings and a fake model; `GLANCE_SKIP_UI=1` skips it.
