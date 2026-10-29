import Anthropic from "@anthropic-ai/sdk";
import { caveman, compressAnswer, compressTranscript } from "./compress.js";

export const MODEL = "claude-opus-5-5";

// Built-in instructions, written caveman-style (see the caveman skill): they
// ride along on every question, so every word saved here is saved each time.
// The first line keeps Claude from copying this terse style into its answers.
const SYSTEM = `Instructions below terse only to save tokens. Write answers in style given at end, not like this.

Glance: real-time overlay assistant on user's screen.
Input: screenshot(s), oldest first; live call transcript (me = user, them = others); maybe typed question.
- Typed question: answer it. Screen + transcript = context.
- No question: give most useful help now: answer latest question asked of user, solve problem on screen, or suggest what to say next.
Lead with answer. Code in code blocks. Never describe screenshots or mention receiving them.

Coding problem: explain like engineer to colleague, plain words, this order:
1. Open with approach name in bold, then 1-2 sentences why it works and why brute force falls short. Use problem's own terms ("the common prefix"), never vague "the answer". E.g. "**Shrink a candidate prefix.** The common prefix can't be longer than the first string, so…"
2. Approach, 2-4 short steps.
3. Clean code in language selected on screen (none shown: Python). Comments only where step not obvious.
4. Time + space complexity, one line each, with why.
5. Edge cases, one line.
No openers like "Since the editor is set to TypeScript" or "Here's the solution". Example walkthrough only if problem tricky: 1-2 sentences after code.`;

// Answer styles. These shape Claude's output, so unlike the rules above they
// describe the voice to write in.
const STYLES = {
  brief: `

Answer style: brief (caveman skill).
- Answer first. No greeting, preamble, recap, closing offer.
- No filler (just, really, basically, actually), no hedging. Fragments fine.
- One idea per sentence. Short words.
- Never drop not/never/no/only/except. Numbers, code, names, errors exact.
- Code: insight in one sentence, code, complexity in one line.`,
  natural: `

Answer style: natural. Write like a thoughtful, experienced person explaining to a friend, not a chatbot.
- Complete: reasoning, key details, the why, not just the conclusion.
- Human: plain conversational sentences, contractions, varied rhythm. Prose over lists; list only for real steps or sets.
- Concrete specifics (numbers, names, examples), not generalities.
- No "Great question", no restating the question, no "In summary", no closing offers, no stacked hedges.
- Lead with the answer; first sentence useful alone.`,
};

export function createClient(apiKey) {
  return new Anthropic(apiKey ? { apiKey } : {});
}

function formatTranscript(lines) {
  const compact = compressTranscript(lines);
  if (!compact.length) return "(none)";
  return compact.map((l) => `${l.role}: ${l.text}`).join("\n");
}

// The user's own instructions from the settings form, added after the built-in
// prompt so they can refine behavior without replacing it.
function systemPrompt(style, custom) {
  let prompt = SYSTEM + (STYLES[style] ?? STYLES.natural);
  if (custom?.trim()) {
    prompt += `\n\nUser's own instructions. Follow; on conflict, theirs win.\n<user_instructions>\n${caveman(custom)}\n</user_instructions>`;
  }
  return prompt;
}

// Streams one answer. Each ask is a fresh single-turn request; recent answers
// ride along as text so follow-ups have context without replaying history.
export function ask({ client, question, transcript, previous, screenshots, effort, style, customInstructions, onText }) {
  const content = screenshots.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }));
  const prior = previous.length
    ? `<previous_answers>\n${previous.map((p) => `Q: ${p.question || "(auto)"}\nA: ${compressAnswer(p.answer)}`).join("\n\n")}\n</previous_answers>\n\n`
    : "";
  content.push({
    type: "text",
    text: `<transcript>\n${formatTranscript(transcript)}\n</transcript>\n\n${prior}${question ? `Question: ${question}` : screenshots.length ? "No typed question. Answer/solve what screenshot shows." : "No typed question. Give most useful help now."}`,
  });

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort },
    system: systemPrompt(style, customInstructions),
    messages: [{ role: "user", content }],
  });
  stream.on("text", onText);

  const done = stream.finalMessage().then((msg) => {
    if (msg.stop_reason === "refusal") {
      throw new Error(`Claude declined this request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ""}.`);
    }
    return msg;
  });
  return { done, abort: () => stream.abort() };
}

// Rewrites custom instructions tersely, like the caveman skill's compress
// mode: same facts, fewer tokens on every later request.
const COMPRESS = `Rewrite the user's instructions for an AI assistant so they use as few tokens as possible while meaning exactly the same thing.
- Keep every fact, constraint, preference, name, number, date, URL, skill, and example.
- Keep every negation (not, never, no, only, except) and every condition.
- Remove filler, pleasantries, hedging, and repetition. Merge duplicate points.
- Use terse fragments and short "-" bullets. Standard abbreviations are fine; invented ones are not.
- Keep the original language and any headings that group information.
Output only the rewritten instructions, with no preamble or commentary.`;

export async function compressInstructions(client, text) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "low" },
    system: COMPRESS,
    messages: [{ role: "user", content: `<instructions>\n${text}\n</instructions>` }],
  });
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to compress these instructions.");
  if (msg.stop_reason === "max_tokens") throw new Error("The compressed version came out too long. Try trimming the instructions first.");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// Turns API failures into plain advice. Most specific class first; the SDK
// already retries 429/5xx/network errors twice before we see them.
export function describeError(e) {
  const text = String(e?.message || e);
  if (e instanceof Anthropic.AuthenticationError) return "Your API key was rejected. Check it in Settings > Anthropic API key.";
  if (e instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use Claude Opus 5.5. Check its workspace permissions in the Anthropic console.";
  if (e instanceof Anthropic.NotFoundError) return "Claude Opus 5.5 isn't available to this API key's organization.";
  if (e instanceof Anthropic.RateLimitError) return "Too many requests right now. Wait a few seconds and ask again.";
  if (e?.status === 402 || /credit balance/i.test(text)) return "Your Anthropic account is out of credit. Add some at console.anthropic.com > Billing.";
  if (e?.status === 413) return "This question was too large to send. Remove some screenshots and try again.";
  if (e instanceof Anthropic.BadRequestError) return `Claude couldn't process this request: ${e.error?.error?.message || text}`;
  if (e instanceof Anthropic.InternalServerError) return "Anthropic's service is busy or having trouble. Try again in a moment.";
  if (e instanceof Anthropic.APIConnectionError) return "Can't reach Anthropic. Check your internet connection.";
  return text;
}

