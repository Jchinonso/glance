// Loaded before app.js as a plain script (isQuestion becomes a global).
// Spoken questions often lose their "?" in transcription, so also look at how
// the sentence starts.
const QUESTION_START = /^(?:(?:so|and|okay|ok|alright|right|well|now|um|uh)[,.]?\s+)*(?:what|why|how|when|where|which|who|whose|can you|could you|would you|will you|do you|did you|have you|are you|is there|is it|should|tell me|walk me through|explain|describe|give me|does|did|is that|are there|was there|were you|any questions|anything you|how about|what about|imagine|suppose|let's say|say you|talk me through|take me through|tell us|walk us through|give us|design|implement|write a|write an|i'd like to hear|i'd love to hear|i'm curious)\b/i;
// Checks the whole line and its last sentence, since people often lead with a
// statement: "Thanks for that. Can you walk me through the deploy".
function isQuestion(text) {
  const t = text.trim();
  if (/\?\s*$/.test(t) || QUESTION_START.test(t)) return true;
  const sentences = t.split(/(?<=[.!?])\s+|,\s+(?=(?:so|and|but)\s)/i);
  return sentences.length > 1 && QUESTION_START.test(sentences.at(-1).replace(/^(?:so|and|but)\s+/i, ""));
}

// The question the Answer button sends ({ text, at } or null), after a new
// line from the other side (the mic is never used for questions). Clicking
// Answer clears it.
// - A line starting within CONTINUE_MS of the question's end continues it:
//   transcription often splits one question at a short pause. A longer gap
//   means the user was answering aloud, so it's a new turn.
// - A new question replaces the old one.
// - Otherwise a substantial line that isn't a question means the talk moved
//   on (the interviewer asked something isQuestion missed), so the old
//   question is dropped and the model picks the latest one from the transcript.
// - Short lines ("take your time") keep it.
const MAX_PENDING = 400;
const CONTINUE_MS = 2000;
function nextPendingQuestion(pending, { role, text, at, start = at }) {
  if (role !== "them") return pending;
  const t = text.trim();
  if (pending && at < pending.at) return pending;
  if (pending && start - pending.at < CONTINUE_MS && pending.text.length + t.length < MAX_PENDING) return { text: `${pending.text} ${t}`, at };
  if (isQuestion(t)) return { text: t, at };
  return t.split(/\s+/).length >= 6 ? null : pending;
}

// A heard question about something shown ("the code on screen") needs a
// screenshot; other heard questions are answered from the transcript alone.
const SCREEN_REF = /\b(?:on (?:the |your |my )?screen|(?:this|that|the) (?:code|function|snippet|query|diagram|bug|error|editor|problem here)|i(?:'ve)? (?:pasted|shared)|you can see|look at|in the (?:editor|doc|chat))\b/i;
function mentionsScreen(text) {
  return SCREEN_REF.test(text || "");
}
