// Mechanical caveman-style compression for text sent to the model on every
// question (transcript, earlier answers, custom instructions). It applies the
// caveman skill's safe rules without an extra API call:
//   - drop articles, filler, hedging and spoken disfluencies
//   - collapse repeated words and whitespace
//   - never touch code, quotes, numbers, or negations (not/never/no/only/except)

const FILLER = [
  // spoken disfluencies (transcripts)
  "um+", "uh+", "erm+", "hmm+", "mm+", "ah+",
  "you know,?", "i mean,",
  // written filler and hedging
  "just", "really", "basically", "actually", "simply", "literally", "very",
  "quite", "pretty much", "i think", "i guess", "i believe", "perhaps",
  "please", "kindly",
];
// A filler word stays after a negation ("not just slow" is not "not slow")
// and inside hyphenated words ("just-in-time").
const FILLER_RE = new RegExp(`(?<!(?:\\bnot|n't)\\s+)(?<![\\w-])(?:${FILLER.join("|")})\\b(?!-)[,]?\\s*`, "gi");
// Capital "A" is often a name ("plan A", "option A"), so only lowercase "a" goes.
const ARTICLE_RE = /\b(?:a|an|the|An|The)\s+(?=[A-Za-z0-9])/g;
const REPEAT_RE = /\b([A-Za-z]+)(?:\s+\1\b)+/gi; // "the the", "I I I"; never numbers

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

// Splits out fenced and inline code and quoted text so only prose is compressed.
export function caveman(text) {
  if (!text) return "";
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”)/g)
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

const NEGATION_RE = /\b(?:not|never|no|none|nothing|only|except|unless|without|cannot|\w+n't)\b/gi;

// Pieces a rewrite must keep verbatim: code, links and numbers.
function payload(text) {
  const fences = text.match(/```[\s\S]*?```/g) ?? [];
  const rest = fences.reduce((t, f) => t.replace(f, " "), text);
  return [
    ...fences,
    ...(rest.match(/`[^`\n]+`/g) ?? []),
    ...(rest.match(/https?:\/\/[^\s)>\]"']+/g) ?? []),
    ...(rest.match(/\d+(?:[.,:/-]\d+)*/g) ?? []),
  ];
}

// True when an LLM rewrite kept every code span, link and number, and still
// uses every kind of negation the original did. Merged duplicates pass.
export function keepsFacts(original, rewrite) {
  if (!payload(original).every((p) => rewrite.includes(p))) return false;
  // Plain negations are interchangeable ("do not mention" and "never mention"
  // mean the same), so they count as one kind; only, except, unless and
  // without each change meaning differently and must survive as themselves.
  const words = (t) => new Set((t.match(NEGATION_RE) ?? []).map((w) => (/^(?:not|never|no|none|nothing|cannot)$|n't$/i.test(w) ? "not" : w.toLowerCase())));
  const after = words(rewrite);
  return [...words(original)].every((w) => after.has(w));
}
