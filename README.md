# Glance

A macOS overlay for calls and interviews. Glance listens to the other side of the call, picks out the questions, and shows you what to say, built from the conversation, your screen, and (for interviews) your own résumé. It works with Claude or any OpenAI-compatible model, and it can save meeting notes.

<p align="center">
  <img src="docs/images/question-heard.png" width="49%" alt="Glance listening to a call, showing a detected question with an Answer button" />
  <img src="docs/images/interview-answer.png" width="49%" alt="An interview answer in the first person, built from the résumé" />
</p>

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Download](#download)
- [Requirements](#requirements)
- [Using Glance](#using-glance)
- [Interview mode](#interview-mode)
- [Settings](#settings)
- [AI providers](#ai-providers)
- [Choosing a model](#choosing-a-model)
- [Depth and Think harder](#depth-and-think-harder)
- [Troubleshooting](#troubleshooting)
- [Privacy and data](#privacy-and-data)
- [Screen sharing: what hiding does and doesn't do](#screen-sharing-what-hiding-does-and-doesnt-do)
- [Uninstall](#uninstall)
- [How it works](#how-it-works)
- [Build from source](#build-from-source)
- [Development](#development)

## Features

- **Hears the question.** Glance transcribes the Mac's audio (the other side of a Zoom, Meet or Teams call) on your machine with NVIDIA's Parakeet speech model and detects questions as they're asked. A question split by pauses is joined back together, lead-in included ("So looking at your time at Acme Pay, can you tell me about…").
- **Answers in seconds.** Press **Answer** (⌘↵), or in Interview mode let Glance answer on its own once the interviewer finishes. If you press Answer while they're still talking, Glance waits for the rest of the question.
- **Fast when it can be, careful when it counts.** Everyday spoken questions start in about a second; design, coding, estimates, typed questions and screenshots think first when Depth is Balanced; **Think harder** re-answers any quick answer more carefully.
- **Sounds like you.** Interview mode answers in the first person, as natural speech, using your résumé as a case study: real roles, projects and numbers, no placeholders. A short note lists anything Glance added so you can check it.
- **Glanceable.** Each long interview answer carries 3 or 4 key phrases. Switch an answer to **Key points** to see just the opening line and the phrases while you talk.
- **Keeps up with you.** If you said something different from the suggestion, press **I said something else** and type a few words; follow-ups build on what you actually said.
- **Sees your screen.** Screenshot a coding problem, an error or a shared doc and get an answer (⌘⇧2).
- **Any model.** Anthropic (Opus, Sonnet, Haiku) or any OpenAI-compatible API: OpenAI, Google Gemini, OpenRouter, Groq, Mistral, or a local Ollama or LM Studio.
- **Meeting notes.** Save a Markdown summary with decisions, action items, the transcript and every question asked.
- **Stays out of the way.** A small always-on-top panel that sizes itself to its content, can hide from screen sharing, and follows macOS light and dark mode, or you can set it to light or dark in **Settings › General › Appearance**.

## Screenshots

| | |
| --- | --- |
| ![Welcome screen](docs/images/welcome.png) | ![Setup: about you, with résumé and details](docs/images/setup-about.png) |
| **First launch.** A short setup, then the speech model download. | **About you.** Your résumé and details, imported or pasted. |
| ![Speech model download](docs/images/setup-speech.png) | ![Settings, General tab](docs/images/settings-general.png) |
| **Speech model.** Downloaded once on first launch. | **Settings › General.** Speech, appearance, shortcuts. |
| ![New interview prompt](docs/images/new-interview.png) | ![Answer as key points](docs/images/key-points.png) |
| **Each new interview.** Keep the same role or add its job description. | **Key points.** The opening line and the beats of the answer. |
| ![Meeting or Interview menu](docs/images/mode-menu.png) | ![Light mode](docs/images/light-mode.png) |
| **Answer mode.** Meeting or Interview, one click away. | **Light mode.** Follows macOS, or set it in Settings › General › Appearance. |
| ![Settings, Interview tab](docs/images/settings-interview.png) | ![Settings, Answers tab](docs/images/settings-answers.png) |
| **Settings › Interview.** Interview mode, auto-answer, key points, résumé. | **Settings › Answers.** Provider, model, depth and style. |

The screenshots use a made-up profile (Jane Doe at Acme Pay) and are regenerated with `node scripts/screenshots.mjs`.

## Download

> **Glance downloads its speech model the first time it opens.** You need an internet connection for that first launch.

- The DMG is about 100 MB for Apple Silicon and about 115 MB for Intel (the speech engine is inside it; the model downloads separately).
- **Setup downloads the speech model once: about 660 MB.** It's NVIDIA's Parakeet TDT 0.6B v2 (English, int8), from [Hugging Face](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8), four files each checked against its SHA-256. It's a required step: **Continue** and **Skip setup** stay disabled until it finishes, a few minutes on a typical connection.
- Downloads resume after a dropped connection and offer **Try again** if they keep failing.
- People updating from an earlier version get the same speech step once, the next time Glance opens. When Parakeet is in, Glance deletes the speech models older versions downloaded (whisper.cpp's `ggml-*.bin` files and the `whisperkit` folder in its models folder) and logs how much space that freed, usually 0.6 to 1.2 GB.

1. Download the latest DMG for your Mac from [Releases](https://github.com/Jchinonso/glance/releases): **Glance-…-arm64.dmg** for Apple Silicon (M1 and later), **Glance-…-x64.dmg** for Intel. Not sure which you have? Open the Apple menu, then **About This Mac**: "Chip: Apple M…" means Apple Silicon, "Processor: Intel" means Intel.
2. Open it and drag **Glance** onto **Applications**.
3. Open Glance from Applications. The app isn't notarized by Apple, so the first time macOS says it can't verify the developer: **right-click Glance › Open › Open**, or go to **System Settings › Privacy & Security** and click **Open Anyway**. After that it opens normally.
4. Follow the setup, and grant **Screen & System Audio Recording** when macOS asks (then quit and reopen Glance).

Nothing else to install: the speech engine ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), on the CPU) is inside the app.

## Requirements

- macOS 14.2 (Sonoma) or later, which Glance needs to hear the call's audio.
- Any Apple Silicon Mac, or an Intel Mac from 2018 or later (iMac 2019 or later; the 2017 iMac Pro also works). Intel Macs from 2017 and earlier can't run macOS 14, so they can't run Glance.
- An internet connection on first launch, for the speech model (about 660 MB, once).
- About 0.7 GB of disk space for the speech model.
- To build from source: Node.js 20 or later. No Homebrew, CMake or Xcode needed: the speech engine comes prebuilt from npm.
- An API key for Anthropic or an OpenAI-compatible service, or a local model server (Ollama, LM Studio) that needs no key.

## Using Glance

### First launch

On first launch Glance walks you through setup: the speech model download (about 660 MB), an API key (only if none is saved), what you'll use it for, your résumé and details, and, for interviews, the job description. For interviews the résumé is required, since answers are built from it; for meetings it's optional. You can change everything later in Settings.

macOS asks for **Screen & System Audio Recording** permission the first time you listen or take a screenshot. Allow it, then reopen Glance once: macOS only sends audio to an app after it reopens. macOS remembers the permission, so this happens only once.

### Listening and answering

1. When the call starts, press **Listen** (⌘⇧\\). The timer shows how long Glance has been listening.
2. When the other side asks a question, it appears under the bar with a **Question** tag.
3. Press **Answer** (⌘↵), or in Interview mode wait a moment: Glance answers on its own once they finish.
4. Type your own question in the box at any time, or take a screenshot (⌘⇧2) to ask about what's on screen.

| Default shortcut | Action |
| --- | --- |
| ⌘⇧\\ | Start or stop listening |
| ⌘↵ | Answer the question just heard, or what you've typed; with nothing new heard, Think harder on the last quick answer |
| ⌘⇧2 | Screenshot and answer |
| ⌘⇧1 | Add a screenshot without asking (collect several first) |
| ⌘\\ | Show or hide Glance |
| ⌘⇧H | Hide from screen sharing (on or off) |
| ⌘ + arrows | Move the window |

Shortcuts work from any app and can be changed in **Settings › General › Shortcuts**. The menu bar icon shows or hides the window; right-click it for more. Esc closes whatever panel is open.

Answers stay at the top while they stream in. Older answers stay in the pager (‹ 1 of 3 ›). An answer cut short by **Stop**, a new question or a typed one is marked "Stopped before the end". Each answer shows its estimated cost (in dollars for the Anthropic models Glance has prices for, otherwise in tokens).

### Notes

**Settings › Session › Save notes** writes a Markdown file to `~/Documents/Glance/` with a summary, decisions, action items, the transcript and every question and answer.

## Interview mode

Glance starts in Interview mode. Switch with the mode menu beside the question box (or **Settings › Interview › Interview mode**); **Meeting** gives Brief or Natural answers about the call and your screen. Auto-answer and the interview prompts below work only in Interview mode.

- **Your résumé and the job description.** Import a PDF, Word, RTF or text file, or paste. Both are sent word for word with every question (up to 20,000 characters each), never compressed, so answers can use your own phrasing. Check imported PDF text: PDFs can merge lines or drop bullets.
- **Your details.** Name, salary expectation, visa status and notice period, used when an interviewer asks.
- **Answers.** First person, spoken prose: a bold opening line, two to four short paragraphs, then an optional note. Stories come from your real roles and projects; added specifics stay modest and are listed in the note. Glance answers honestly when you lack an experience, and never volunteers salary, visa or weaknesses unless asked. Technical, behavioral, system design, coding, HR, case and product questions each get a fitting shape.
- **Auto-answer.** While listening, Glance answers when the interviewer finishes their turn. Turn it off in **Settings › Interview › Answer heard questions automatically**.
  - **Obvious questions** are answered the moment they stop. Glance recognizes them without a question mark, from how they start ("can you", "walk me through", "let's talk about", "help me understand", "what if"…), including a question in the middle of a line or after an announcement ("My first question for you is, tell me about yourself").
  - **Anything else** they say (5 words or more) is checked by your model once they've been quiet for 0.8 s. It answers implied questions ("I'm keen to hear about the project you're proudest of") and skips turns with nothing to answer (greetings, introductions, explaining the format, small talk), which show nothing. Each check reuses the cached prompt, and a skipped one stops after a few tokens.
  - **A follow-up comment** from the interviewer within 10 seconds doesn't cancel the question, and if they carry on after a long pause, the whole question is answered again.
  - **It waits** while you're typing (the last 5 s), while an answer you asked for is still streaming, or while a form or Settings is open. The transcript view doesn't hold it, and it never interrupts an answer you asked for.
- **Key points.** **Key points** on an answer shows the opening line and 3 or 4 phrases; **Full answer** shows the rest. To open every answer that way, turn on **Settings › Interview › Open answers as key points**.
- **I said something else.** Type what you actually said under an answer; later questions build on that, not the suggestion.
- **New interview?** When you start listening in Interview mode, Glance asks whether it's the same role or a new job description (again after 30 minutes, or after Clear session). If no résumé is saved, it asks for that first.

## Settings

The gear opens four tabs (**Answers**, **Interview**, **Session**, **General**). Panels opened from Settings have a Back button that returns to the same tab.

- **Answers:** AI provider and key, model (listed from the provider, searchable, and any model ID can be typed), Depth (Quick, Balanced, Thorough), meeting style (Natural or Brief), custom instructions (compressed automatically when saved), and Screenshot every question (whether typed questions include a screenshot).
- **Interview:** Interview mode, auto-answer, key points, résumé, your details, job description, and a warning when Glance would show in a screen share.
- **Session:** spending so far, the transcript, Save notes, Clear session.
- **General:** Speech (Parakeet, on this Mac, with the download's progress and **Try again** when it's needed), Appearance (System, Light, Dark), words to recognize (names and terms to listen for), hide from screen sharing, shortcuts, show the welcome again, and Delete all Glance data.

### Speech

Glance has one speech engine and one model: NVIDIA's [Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) (English, int8), run by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) on your Mac's CPU. There is nothing to choose: **Settings › General › Speech** reads "Parakeet (on this Mac)", with the download's progress or **Try again** below it when that's needed.

- **Speed, measured on an M1:** about 0.5 to 0.8 s per 7.5 s phrase, about 0.15 s for a short "Sure.", and about 2 s to load the model, which happens when Glance opens so the first Listen is instant. Newer chips are faster.
- **Same on every Mac.** It uses neither the GPU nor the Neural Engine, so there's no per-chip preparation and no GPU code to fail. Intel Macs run the same engine on the CPU and are slower than the M1 figures above.
- **In its own process.** The engine runs outside Glance's main process, so the window never stalls while a phrase is transcribed, and if the engine ever stops, Glance restarts it for the next phrase.
- **Words to recognize.** Names and terms in **Settings › General › Words to recognize** are boosted strongly, while a built-in list of common tech terms (React, Postgres, Kubernetes and so on) gets only a light boost, so everyday words like "job" aren't turned into "Java". A word the model can't spell with its own pieces (an emoji, say) is left out and logged.
- **Open source:** sherpa-onnx is Apache-2.0; the Parakeet model is CC-BY-4.0, by NVIDIA ([model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)), converted to ONNX by the sherpa-onnx authors.

### Depth

**Settings › Answers › Depth** (Quick, Balanced, Thorough) sets how long the model may think on questions that need it. Everyday spoken questions stay fast either way.

- Which questions use it: [Depth and Think harder](#depth-and-think-harder)
- Recommended settings: [Choosing a model](#choosing-a-model)

## AI providers

Choose a provider in **Settings › Answers › AI provider**, or during setup. Both cards open the same form:

| Card | For | Fields |
| --- | --- | --- |
| **OpenAI-compatible** | Any server that speaks the OpenAI API, hosted or on your network | Server address, Model, API key |
| **Anthropic** | Claude through your own key | Model, API key |

**Models**

- Listed by the provider itself: Anthropic's Models API, or the server's `/models` endpoint.
- The **Model** box filters as you type (OpenRouter lists hundreds), and you can type any model ID the list doesn't show.
- Left out: models that can't chat (embeddings, speech, image and moderation models) and OpenRouter's delayed `:batch` versions.
- **Settings › Answers › Model** shows the same list as a dropdown with a **Refresh** link. The line under it gives the price per million tokens for Opus 5.5, Sonnet 5.5 and Haiku 5.5.
- **Depth** appears only for models that support it, so it's hidden for older Claude models such as Haiku 4.5.

**Test connection** sends one tiny request with what's in the form, even before you save, and reports how long the model took to reply. Use it to check a new key, model or server address.

| Provider | Setup | Cost shown |
| --- | --- | --- |
| Anthropic | API key from [console.anthropic.com](https://console.anthropic.com) | Dollars for Opus 5.5, Sonnet 5.5 and Haiku 5.5; tokens for other Claude models |
| OpenAI, Gemini, OpenRouter, Groq, Mistral… | Server address, model and API key | Tokens only |
| Ollama or LM Studio (local) | Server address such as `http://localhost:11434/v1` and model; no key | Tokens only |

**Behind the scenes**

- **Caching:** your résumé, job description and instructions are cached between questions, so repeats cost about a tenth. On Anthropic and for Claude models on OpenRouter the cache lasts an hour; Gemini models on OpenRouter keep it 5 minutes; other OpenRouter models cache automatically.
- **Refusals:** on Anthropic, Glance retries without the server-side refusal fallback if your account doesn't have it.
- **Custom instructions** are compressed with Opus when you save them (Anthropic).
- **Depth** is Anthropic's thinking control; OpenAI-compatible servers get it as a reasoning level.
- **Screenshots:** text-only models can't read them; Glance says so and suggests turning screenshots off.

## Choosing a model

For live calls three things matter: how soon the first word appears, whether the model reads screenshots, and how well it reasons through code and design.

### Recommended setups

On **Anthropic's own API**:

| Interview | Model | Depth | Screenshots |
| --- | --- | --- | --- |
| Behavioral, HR or mixed | **Haiku 5.5** | Quick | Rarely needed |
| Technical (coding, debugging, system design) | **Sonnet 5.5** | Balanced | ⌘⇧2 when a problem is on screen |
| Hardest technical rounds | **Opus 5.5** | Balanced | ⌘⇧2 when a problem is on screen |
| Lowest cost | **Haiku 5.5** | Quick | Rarely needed |

On **OpenRouter** (one key for many companies' models), with a cheaper alternative for each:

| Interview | OpenRouter model | Cheaper alternative | Depth | Screenshots |
| --- | --- | --- | --- | --- |
| Behavioral, HR or mixed | `anthropic/claude-haiku-5.5` | `qwen/qwen3.7-flash` (untested) | Quick | Rarely needed |
| Technical (coding, debugging, system design) | `anthropic/claude-sonnet-5.5` | `google/gemini-3.8-flash` | Balanced | ⌘⇧2 when a problem is on screen |
| Hardest technical rounds | `anthropic/claude-opus-5.5` | `openai/gpt-5.4` (slower) | Balanced | ⌘⇧2 when a problem is on screen |
| Lowest cost | `anthropic/claude-haiku-5.5` | `qwen/qwen3.7-flash` (untested) | Quick | Rarely needed |

### Setting up OpenRouter

1. Open **Settings › Answers › AI provider** and choose **OpenAI-compatible**.
2. Type `openrouter.ai` as the server address. Glance fills in `https://openrouter.ai/api/v1`.
3. Pick the model from the list.
4. Paste your OpenRouter key from [openrouter.ai/keys](https://openrouter.ai/keys).
5. Press **Test connection**, then **Save**.

### For every interview

- Turn on **Interview mode** with auto-answer.
- In a coding or design round, press **Screenshot** (⌘⇧2) when the problem appears. The answer uses the screen and what was just said.

> A spoken question gets a screenshot by itself only when it mentions the screen ("look at this function"). **Settings › Answers › Screenshot every question** only adds one to questions you type.

### Anthropic or OpenRouter

Both cache your résumé, job description and instructions, and warm the cache when you press Listen.

| | Anthropic's own API | OpenRouter |
| --- | --- | --- |
| Models | Claude only | Hundreds, from many companies, with one key |
| Cache | 1 hour | 1 hour for Claude, 5 minutes for Gemini, automatic for others |
| Depth | Exact thinking control | Sent as each model's reasoning level |
| Refused requests | Retried on another model (Opus and Sonnet) | Not retried |
| Costs shown | Dollars | Tokens |
| Key | [console.anthropic.com](https://console.anthropic.com) | [openrouter.ai/keys](https://openrouter.ai/keys) |

For Claude models, Anthropic's own API is the best fit.

### OpenRouter models and prices

If you use screenshots, pick a model that reads images. These all do. Prices are OpenRouter's, in dollars per million tokens, as of November 2026; they change, so check [openrouter.ai](https://openrouter.ai).

| OpenRouter model | Input | Output | Notes |
| --- | --- | --- | --- |
| `anthropic/claude-haiku-5.5` | 0.10 | 0.50 | Cheapest good all-rounder, fast |
| `openai/gpt-5.4-mini` | 0.75 | 4.50 | Mid-priced |
| `google/gemini-3.8-flash` | 0.83 | 4.12 | Strong at screenshots and code for the price |
| `anthropic/claude-sonnet-5.5` | 2.00 | 10.00 | Best balance for technical rounds |
| `openai/gpt-5.4` | 2.50 | 15.00 | Strong, but writes slowly through OpenRouter (about 45 tokens a second in our tests) |
| `anthropic/claude-opus-5.5` | 4.00 | 20.00 | Most capable, for the hardest problems |

**Cost per answer:** a typical answer sends about 8,000 tokens (instructions, résumé, job description and transcript, mostly cached after the first question) and gets about 400 back.

- Haiku 5.5: roughly a tenth of a cent
- Sonnet 5.5: about two cents

### Measured speed

Time from asking to the first word, on a typical connection:

| Model | Spoken question (Quick) | Question that thinks (Balanced) |
| --- | --- | --- |
| Haiku 5.5 | about 1 s | about 6 to 9 s |
| Sonnet 5.5 | about 2 s | several seconds more |
| `openai/gpt-5.4` on OpenRouter | about 1.5 to 2 s (full answer about 8 s) | about 14 s |

## Depth and Think harder

Depth never changes on its own. For each question Glance decides whether to answer at **Quick** (no thinking, fastest) or at **your Depth setting**:

| Question | Level used |
| --- | --- |
| Spoken, everyday ("tell me about yourself", "what is the event loop") | Quick |
| Spoken story ("tell me about a time you…") | Quick |
| Spoken and hard: designing a system, writing code, algorithms, complexity, estimates, scale, trade-offs, debugging, edge cases | Your Depth |
| Typed, a screenshot, or a spoken question about the screen | Your Depth |
| **Think harder** | Your Depth, but at least Balanced |

### What each level means

| Depth | Hard, typed and screenshot questions | Best for |
| --- | --- | --- |
| **Quick** | Answered straight away, in about a second, without working through them. Fine for concepts and most design talk; riskier for algorithm puzzles, complexity, estimates and tricky edge cases. | Behavioral and mixed interviews |
| **Balanced** | Think for a few seconds first | Technical interviews (recommended) |
| **Thorough** | Think longest | Only very hard problems |

Everyday spoken questions are fast at every level.

### Think harder

A spoken answer given at Quick has a **✦ Think harder** button at the top, next to Key points.

1. Press it, or the Answer shortcut (⌘↵) when nothing new has been heard.
2. Glance answers the same question again with thinking, at Balanced or your Depth if higher. The answer says "Thinking it through…" while it works.
3. The quick answer stays on the previous page.

If a new question has already been heard, ⌘↵ answers that question instead.

### On OpenAI-compatible servers

Depth is sent as the reasoning level: `reasoning_effort`, or `reasoning.effort` on OpenRouter.

- **Quick** tries `none`, then `minimal`, then `low`, so each model gets its fastest setting.
- Models that don't reason ignore it.
- Glance remembers what each model accepts.

## Troubleshooting

- **"Glance can't see your screen."** Turn Glance on in System Settings › Privacy & Security › Screen & System Audio Recording, then quit and reopen it.
- **Listening shows nothing.** macOS sends an app system audio only after it reopens following the permission prompt. Until then Glance hears silence, and after 15 seconds of it (once each time Glance opens, and not once sound has come through) it says so with a **Reopen Glance** button. If that doesn't help:
  - Check Glance is on under **Screen & System Audio Recording** and under **System Audio Recording Only**.
- **Answers are slow.** Everyday spoken questions always answer at Quick. If hard, typed or screenshot questions feel slow:
  - Set **Settings › Answers › Depth** to **Quick**, and press **Think harder** only when an answer looks shaky.
  - Use a faster model: Haiku 5.5 starts in about a second (see [Choosing a model](#choosing-a-model)).
  - Check the log for slow transcription (see Logs below): `decodeMs` well over a second per phrase means the Mac is busy.
- **A question gets no answer.**
  - Auto-answer waits while you're typing, while an answer you asked for is still streaming, or while a form or Settings is open.
  - Press **Answer** (⌘↵) to answer the latest question yourself.
  - In the log, look for the interviewer's line followed by `turn check … result=none` (your model judged there was nothing to answer) or by no `question detected` or `turn check` at all.
- **The speech model download fails.** Check the connection, then press **Try again** in setup (or Settings › General › Speech). It resumes from where it stopped. Glance retries 3 times on its own before showing **Try again**.
- **Names or jargon are misheard.** Add them under Settings › General › Words to recognize, separated by commas. The engine boosts them, along with a built-in list of common tech terms; the log lists any it had to leave out (`hotwords skipped`).
- **A shortcut doesn't work.** Another app may own it; Glance says which at startup. Change it in Settings › General › Shortcuts.
- **Answers fail.** The message says why (key rejected, out of credit, model not found, rate limited). Check Settings › Answers › AI provider.
- **Logs.** `~/Library/Logs/Glance/glance.log` records what happens in a session. It stays on your Mac and includes the first 80 characters of what was said.
  - **What it records:** the speech model (`speech model ok`, `speech model download …`, `engine=parakeet loaded loadMs=…`, `old speech models removed: … (… MB freed)`), each heard line (speech length, `transcribeMs`, `decodeMs`, `waitMs`, `queued`, `via=parakeet`), question detected / extended / replaced / dropped, auto-answer fired, turn check sent and its result (`result=none` or `result=answer`), each answer (`sinceSpeechEndMs`, model, `effort` used and your `depth` setting, `hard` and `deep` for hard questions and Think harder, first-token ms, total ms, `cacheRead` and `cacheWrite`), and `prewarm` when Listen warms the cache.
  - **How to read it:**
    - Slow transcription: a long `transcribeMs` or a growing `queued` count means transcription is the bottleneck.
    - Slow first token: a long first token points to Depth or the model; `effort=medium` or `high` means that answer thought first.
    - Cache: `cacheRead` above 0 means the résumé and instructions came from the cache.
    - Missed question: a heard line with no "question detected" after it.

## Privacy and data

- **Audio stays on your Mac.** Transcription runs locally with Parakeet. Only text (and screenshots you take or allow) is sent to your AI provider.
- **The microphone is never recorded.** Glance hears only the Mac's audio, the other side of the call.
- **Keys** are stored in the macOS login keychain, not in files.
- **Where things live.** Settings are in `~/Library/Application Support/Glance/config.json`, the downloaded **speech model** in `~/Library/Application Support/Glance/models`, **logs** in `~/Library/Logs/Glance/glance.log`, **notes** in `~/Documents/Glance/`.
- Glance treats the transcript, screen text, résumé and job description as data, not instructions.
- **Settings › General › Delete all Glance data** removes all of the above in one step (see [Uninstall](#uninstall)).

## Screen sharing: what hiding does and doesn't do

With **Hide from screen sharing** on (the eye icon, ⌘⇧H), macOS leaves Glance out of screen captures and recordings, including Zoom, Meet and Teams screen shares. Glance keeps itself out of its own screenshots either way.

It does **not** hide Glance from a camera pointed at your screen, from interview tools that lock down the browser or watch the camera, or from an interviewer noticing you reading. Many companies don't allow outside help during interviews; check the rules before you use it.

## Uninstall

Dragging an app to the Trash doesn't tell it anything, so on macOS an app's keys and settings stay behind unless you remove them. Glance keeps your API keys and résumé, so remove them first:

1. Open Glance, then **Settings › General › Delete all Glance data**. It lists what it removes and asks you to confirm:
   - your API keys, from the macOS keychain;
   - settings, résumé, job description and your details (`~/Library/Application Support/Glance`);
   - the downloaded speech models (`~/Library/Application Support/Glance/models`);
   - logs (`~/Library/Logs/Glance`);
   - optionally, your saved meeting notes (`~/Documents/Glance`), moved to the Trash.

   Glance then quits.
2. Drag **Glance** from Applications to the Trash.
3. Optional: remove Glance from **System Settings › Privacy & Security › Screen & System Audio Recording**.

Already deleted the app? Remove the leftovers by hand:

```sh
security delete-generic-password -s com.glance.overlay.api-key -a glance   # Anthropic key
security delete-generic-password -s com.glance.overlay.api-key -a openai   # OpenAI-compatible key, if set
rm -rf ~/Library/Application\ Support/Glance ~/Library/Logs/Glance   # includes the speech models
# Saved notes, if you don't want them: ~/Documents/Glance
```

## How it works

```
Mac audio ──► speech detection ──► Parakeet (sherpa-onnx, CPU) ──► transcript
                                                                  │
                        question detection (joins split pieces) ◄─┘
                                                  │
  résumé, job description, details, screenshots ──┼──► prompt ──► AI provider ──► streamed answer
                                                  │
                         earlier answers (or what you said instead)
```

- `src/main.js`: window, shortcuts, screenshots, keychain, settings, notes, logging, the test mode.
- `src/audio.js`: system audio capture (audiotee) and speech detection; each phrase goes to the speech engine in turn.
- `src/asr.js` and `src/asr-worker.js`: the speech engine. Parakeet through sherpa-onnx (`sherpa-onnx-node`, prebuilt for Apple Silicon and Intel) in an Electron utility process, loaded once and kept loaded, restarted if it stops.
- `src/hotwords.js`: Words to recognize, turned into the exact pieces the model writes (its own BPE), checked so a phrase is either boosted correctly or left out.
- `src/models.js`: the model download (four files, resumed, checked against SHA-256) and removing older versions' speech models.
- `src/assistant.js`: prompts and features (answers, Interview mode, instruction compression, notes), independent of any vendor.
- `src/providers.js`: Anthropic and OpenAI-compatible adapters behind one interface. Adding a provider means adding one adapter.
- `src/compress.js`: mechanical compression of the transcript and earlier answers sent with every question; numbers, code, quotes and negations are never touched.
- `src/resume.js`: résumé and job description import (PDFKit and `textutil`, built into macOS).
- `src/ui/`: the interface. `app.js` (window logic), `questions.js` (question detection and joining), `markdown.js` and `highlight.js` (answer rendering), `onboarding.js`, `hints.js`.

## Build from source

```sh
# 1. Dependencies, then build the app (packages and signs it)
npm install
npm run package

# 2. Open it
npm start   # opens dist/Glance-darwin-arm64/Glance.app

# Optional: a DMG for sharing, at dist/Glance-<version>-arm64.dmg
npm run dmg
```

`npm run dev` and the packaged app both download the speech model into `~/Library/Application Support/Glance/models` on first launch. Nothing model-related is packed into the app. The DMG is LZMA-compressed and takes about 4 minutes to build. These scripts build the Apple Silicon app; the Intel DMG on the Releases page is packaged separately with `--arch=x64` and the `sherpa-onnx-darwin-x64` package in place of `sherpa-onnx-darwin-arm64`.

`npm run dev` runs from source, but macOS won't grant it screen recording, so screenshots only work in the packaged app. Quit Glance before running `npm run package` again.

## Development

```sh
npm test                       # unit tests and the UI click-through
GLANCE_SKIP_UI=1 npm test      # skip the UI tests
node scripts/screenshots.mjs   # regenerate docs/images/
ANTHROPIC_API_KEY=… node test/interview-eval.js claude-sonnet-5-5   # real-API interview check
```

- **Speech tests** (`test/ui-speech.test.js`, `test/asr.test.js`, `test/hotwords.test.js`, `test/models.test.js`, `test/segmenter.test.js`) cover setup downloading the model, a model already in place, a file that fails its checksum, Try again, removing older versions' models, the engine process (load, crash, restart) and the hotword splitter against the model's real `tokens.txt`. The app's downloads come from a local server with small stand-in files (`GLANCE_MODELS_URL`, `GLANCE_TEST_MODEL_FILES`), and `GLANCE_TEST_ASR` names a stand-in engine, so tests never download or load the real model.
- **UI tests** (`test/ui.test.js`) launch the real app in test mode and drive it over the DevTools protocol: setup, every Settings tab and form, the provider form (model dropdowns, server addresses, Test connection), the mode menu, answers, key points, "I said something else", Think harder, stopping, waiting for a question to finish, and auto-answer. Test mode (`GLANCE_TEST_DIR=<folder>`) uses its own settings folder, never touches the keychain, registers no global shortcuts and keeps its window invisible. A fake OpenAI-compatible server answers.
- **The interview eval** (`test/interview-eval.js`) asks 21 sample interview questions against a real model and checks shape, placeholders, labels, length, key phrases and consistency. `EVAL_ONLY="salary|visa"` runs a subset; `EVAL_PROVIDER=openai EVAL_BASE_URL=…` targets another vendor. Read the answers too: checks can't judge quality.
- **Roadmap:** see [PLAN.md](PLAN.md).
