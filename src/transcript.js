// Filters for transcript lines, applied before a line is shown or kept.
// They catch the three ways a raw transcript goes wrong in practice:
//   - echo: the mic hears the speakers, so "me" repeats what "them" just said
//   - backchannels: "mm-hmm", "uh-huh" add nothing
//   - hallucination: Whisper, primed with vocabulary, invents repeated terms
//     ("React, React, creation.") from unclear audio

const words = (text) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

const BACKCHANNEL = new Set(["mm", "mmm", "mhm", "mm-hmm", "hmm", "hm", "uh", "uh-huh", "um", "ah", "oh", "huh"]);

export function isBackchannel(text) {
  const w = text.toLowerCase().match(/[\p{L}-]+/gu) || [];
  return w.length > 0 && w.every((x) => BACKCHANNEL.has(x));
}

// True when most of a "me" line already appeared in what "them" said recently.
export function isEcho(text, recentThemText) {
  const mine = words(text);
  if (!mine.length) return false;
  const theirs = new Set(words(recentThemText));
  const shared = mine.filter((w) => theirs.has(w)).length;
  return mine.length >= 3 ? shared / mine.length >= 0.7 : shared === mine.length;
}

// A short line built around a vocabulary term said twice in a row is almost
// always Whisper filling unclear audio with the prompt.
export function isPromptHallucination(text, terms) {
  const w = words(text);
  if (!w.length || w.length > 6) return false;
  const vocab = new Set(terms.flatMap((t) => words(t)));
  return w.some((x, i) => i > 0 && x === w[i - 1] && vocab.has(x));
}
