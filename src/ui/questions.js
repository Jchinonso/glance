// Loaded before app.js as a plain script (isQuestion becomes a global).
// Spoken questions often lose their "?" in transcription, so also look at how
// the sentence starts.
const QUESTION_START = /^(?:(?:so|and|okay|ok|alright|right|well|now|um|uh)[,.]?\s+)*(?:what|why|how|when|where|which|who|whose|can you|could you|would you|will you|do you|did you|have you|are you|is there|is it|should|tell me|walk me through|explain|describe|give me)\b/i;
function isQuestion(text) {
  const t = text.trim();
  return /\?\s*$/.test(t) || QUESTION_START.test(t);
}
