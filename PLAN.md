# Glance: next steps

Ordered by how much each matters in a real interview. Step 0 (commit the
current work) is done: commit `5a59a2a` on branch `providers-interview-setup`.

## 1. Test in real conditions

Everything so far was tested with simulated audio, mock servers and scripted
clicks. Real use is the best way to find what's left.

- **Mock interview (20 minutes).** Zoom or Google Meet with a friend asking
  questions, screen shared, Interview mode on, Listen on.
  - Glance stays out of the shared screen and the recording.
  - Each question appears within about 2 seconds of the interviewer stopping.
  - Answers read naturally aloud; note any that sound off.
  - Follow-up questions stay consistent with earlier answers.
- **Another provider.** Set up OpenAI, Gemini (OpenAI-compatible endpoint) or a
  local Ollama model in Settings > Answers > AI provider. Ask a typed
  question, a screenshot question and a heard question.
- **Other resume PDFs.** Import PDFs exported from Word, Google Docs, Canva and
  LaTeX; check the imported text keeps its lines and bullets.

Done when: a written list of what broke or felt slow, each turned into a fix.

## 2. Faster answers (auto-answer) — done (Settings > Interview, on by default)

Today: speech ends, about 2 s until the question shows, then you press
Answer, then the model starts. Silence in an interview is noticeable.

- Add a setting, Settings > Interview > "Answer heard questions
  automatically", on by default in Interview mode.
- When a question is detected, start the answer at once; if the next line
  continues the question (within the 2 s window), cancel and restart with the
  full question.
- Cap wasted calls: no auto-answer for lines under 4 words or
  backchannels; only one answer in flight.
- Measure: time from end of speech to first word on screen, before and after.

Done when: the first words appear within about 3 s of the interviewer
stopping, and false starts are rare in the mock interview.

## 3. Answers that are quick to read — done

150 to 200 words is right to say, hard to read mid-sentence.

- Add a compact view: the bold first line plus 3 or 4 key phrases, with a
  click (or a shortcut) to expand the full answer.
- Ask the model for the key phrases in the same call (a short list at the end
  that the window hides in full view), so it costs no extra request.
- Re-run the interview eval to make sure full answers don't get worse.

Done when: you can follow an answer with a glance in the mock interview.

## 4. Tell Glance what you actually said — done

Without the mic, Glance assumes you said roughly what it suggested. If you
went off-script, follow-ups may build on a story you never told.

- After an answer, a small "I said something else" field: type a few words
  ("used the Kafka story instead") and it goes with later questions in place of
  the suggested answer.

Done when: a follow-up after an off-script answer builds on what you said.

## 5. Settings code that doesn't drift — done (`test/ui.test.js`)

Every Back/Esc bug this session came from separate on/off flags in
`src/ui/app.js` (`editingKey`, `editingDoc`, `editingProfile`,
`editingInstructions`, `editingShortcuts`, `settingsOpen`) getting out of sync.

- Replace them with one value: `panel = null | "settings" | "key" | "resume" |
  "job" | "profile" | "instructions" | "shortcuts" | "transcript"`, plus where
  Back goes.
- Turn the click-throughs run by hand into automated tests (Electron driven
  over the DevTools protocol): setup from first launch, each Settings tab,
  each form's Back and Esc, the mode menu, the new-interview card.

Done when: the automated click-through runs with `npm test` and passes.

## 6. Know the limits of hiding

Content protection keeps Glance out of screen capture and recordings. It does
not hide it from interview tools that use the camera or lock down the
browser, from a second camera, or from an interviewer noticing you reading.
Many companies ban outside help during interviews, and being caught usually
ends the process. Decide case by case; don't rely on invisibility alone.

## Working on this

Pick one item at a time and give it a concrete goal ("auto-answer within 3
seconds", "works with Gemini"). Rebuild with `npm run package` (quit Glance
first), run `npm test`, and after any prompt change run
`node test/interview-eval.js` and read the answers.
