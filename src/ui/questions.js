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
// - A new question keeps the lead-in said just before it ("So looking at
//   your experience with distributed systems, | how would you design…"):
//   earlier lines from the other side, each ending within CONTINUE_MS of the
//   next. `before` is the transcript up to (not including) this line.
const MAX_PENDING = 400;
const CONTINUE_MS = 2000;
const MAX_LEAD_LINES = 2;
function nextPendingQuestion(pending, { role, text, at, start = at }, before = []) {
  if (role !== "them") return pending;
  const t = text.trim();
  if (pending && at < pending.at) return pending;
  if (pending && start - pending.at < CONTINUE_MS && pending.text.length + t.length < MAX_PENDING) return { text: joinPieces(pending.text, t), at };
  if (isQuestion(t)) return { text: joinPieces(leadIn(before, start, MAX_PENDING - t.length), t), at };
  return t.split(/\s+/).length >= 6 ? null : pending;
}

function leadIn(before, start, room) {
  const lead = [];
  let next = start;
  for (let i = before.length - 1; i >= 0 && lead.length < MAX_LEAD_LINES; i--) {
    const l = before[i];
    if (l.role !== "them") continue;
    const line = l.text.trim();
    if (next - l.at >= CONTINUE_MS || isQuestion(line) || line.length + 1 > room) break;
    lead.unshift(line);
    room -= line.length + 1;
    next = l.start ?? l.at;
  }
  return lead.reduceRight((rest, piece) => joinPieces(piece, rest), "");
}

// Transcription ends every piece with a full stop or question mark, so a
// question split by pauses reads "about a time? When you had to…". When the
// next piece carries on the sentence (starts with "and", "when", "for"…; not
// "so", which usually opens a new one), the
// break goes: "about a time when you had to…". A "how/what" clause gets a comma.
const CARRY_ON = /^(?:and|or|but|when|where|while|which|that|who|whose|if|because|for|to|with|without|from|by|of|in|on|at|about|like|during|after|before|than|as)\b/i;
const WH_CLAUSE = /^(?:how|what|why|which)\b/i;
function joinPieces(first, next) {
  if (!first) return next;
  if (!next) return first;
  if (/[.?!]$/.test(first) && (CARRY_ON.test(next) || WH_CLAUSE.test(next))) {
    const glue = CARRY_ON.test(next) ? "" : ",";
    return `${first.slice(0, -1)}${glue} ${next[0].toLowerCase()}${next.slice(1)}`;
  }
  return `${first} ${next}`;
}

// A heard question about something shown ("the code on screen") needs a
// screenshot; other heard questions are answered from the transcript alone.
const SCREEN_REF = /\b(?:on (?:the |your |my )?screen|(?:this|that|the) (?:code|function|snippet|query|diagram|bug|error|editor|problem here)|i(?:'ve)? (?:pasted|shared)|you can see|look at|in the (?:editor|doc|chat))\b/i;
function mentionsScreen(text) {
  return SCREEN_REF.test(text || "");
}
