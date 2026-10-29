// Loaded before app.js as a plain script (isQuestion becomes a global).
// Spoken questions often lose their "?" in transcription, so also look at how
// the sentence starts.
const QUESTION_START = /^(?:(?:so|and|okay|ok|alright|right|well|now|um|uh)[,.]?\s+)*(?:what|why|how|when|where|which|who|whose|can you|could you|would you|will you|do you|did you|have you|are you|is there|is it|should|tell me|walk me through|explain|describe|give me)\b/i;
// Checks the whole line and its last sentence, since people often lead with a
// statement: "Thanks for that. Can you walk me through the deploy".
function isQuestion(text) {
  const t = text.trim();
  if (/\?\s*$/.test(t) || QUESTION_START.test(t)) return true;
  const sentences = t.split(/(?<=[.!?])\s+|,\s+(?=(?:so|and|but)\s)/i);
  return sentences.length > 1 && QUESTION_START.test(sentences.at(-1).replace(/^(?:so|and|but)\s+/i, ""));
}
