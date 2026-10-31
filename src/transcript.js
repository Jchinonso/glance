// Filters for transcript lines, applied before a line is shown or kept.
// They catch the two ways a raw transcript goes wrong in practice:
//   - backchannels: "mm-hmm", "uh-huh" add nothing
//   - hallucination: Whisper, primed with vocabulary, invents repeated terms
//     ("React, React, creation.") from unclear audio

const words = (text) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

const BACKCHANNEL = new Set(["mm", "mmm", "mhm", "mm-hmm", "hmm", "hm", "uh", "uh-huh", "um", "ah", "oh", "huh"]);

export function isBackchannel(text) {
  const w = text.toLowerCase().match(/[\p{L}-]+/gu) || [];
  return w.length > 0 && w.every((x) => BACKCHANNEL.has(x));
}

// A short line built around a vocabulary term said twice in a row is almost
// always Whisper filling unclear audio with the prompt.
export function isPromptHallucination(text, terms) {
  const w = words(text);
  if (!w.length || w.length > 6) return false;
  const vocab = new Set(terms.flatMap((t) => words(t)));
  return w.some((x, i) => i > 0 && x === w[i - 1] && vocab.has(x));
}
