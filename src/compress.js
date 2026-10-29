// Mechanical caveman-style compression for text sent to Claude on every
// question (transcript, earlier answers, custom instructions). It applies the
// caveman skill's safe rules without an extra API call:
//   - drop articles, filler, hedging and spoken disfluencies
//   - collapse repeated words and whitespace
//   - never touch code, numbers, or negations (not/never/no/only/except)

const FILLER = [
  // spoken disfluencies (transcripts)
  "um+", "uh+", "erm+", "hmm+", "mm+", "ah+",
  "you know,?", "i mean,", "kind of", "sort of",
  // written filler and hedging
  "just", "really", "basically", "actually", "simply", "literally", "very",
  "quite", "pretty much", "i think", "i guess", "i believe", "perhaps",
  "please", "kindly",
];
const FILLER_RE = new RegExp(`\\b(?:${FILLER.join("|")})\\b[,]?\\s*`, "gi");
const ARTICLE_RE = /\b(?:a|an|the)\s+(?=[a-z0-9])/gi;
const REPEAT_RE = /\b(\w+)(?:\s+\1\b)+/gi; // "the the", "I I I"

function compressProse(text) {
  return text
    .replace(FILLER_RE, "")
    .replace(ARTICLE_RE, "")
    .replace(REPEAT_RE, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/^[ \t]*[,.;:]+[ \t]*(?=\S)/gm, "") // stray punctuation left by a removed filler
    .replace(/\n{3,}/g, "\n\n");
}

// Splits out fenced and inline code so only prose is compressed.
export function caveman(text) {
  if (!text) return "";
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : compressProse(part)))
    .join("")
    .trim();
}

// Transcript lines: compress each, drop lines left empty (pure "um"),
// and merge consecutive lines from the same speaker.
export function compressTranscript(lines) {
  const out = [];
  for (const { role, text } of lines) {
    const t = caveman(text);
    if (!/[\p{L}\p{N}]/u.test(t)) continue; // nothing but "um."
    const last = out.at(-1);
    if (last && last.role === role) last.text += ` ${t}`;
    else out.push({ role, text: t });
  }
  return out;
}

// Earlier answers only give follow-ups context, so keep a compressed head.
export function compressAnswer(text, max = 700) {
  const t = caveman(text);
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}
