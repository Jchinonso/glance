// Runs sample interview questions through the real Interview prompt and
// prints each answer with basic checks. Not part of `npm test`: it calls the
// API and costs a few cents.
//   ANTHROPIC_API_KEY=... node test/interview-eval.js [model]
//   OPENAI_API_KEY=... EVAL_PROVIDER=openai EVAL_BASE_URL=https://api.openai.com/v1 node test/interview-eval.js gpt-4o
import { ask } from "../src/assistant.js";
import { createProvider } from "../src/providers.js";

const model = process.argv[2] || "claude-haiku-5-5";
const providerId = process.env.EVAL_PROVIDER || "anthropic";
const job = `Senior Backend Engineer, Ledgerly (payments infrastructure). Requirements: 5+ years backend, Postgres at scale, event streaming (Kafka), on-call experience. Nice to have: Go. Salary $140k-$170k. Visa sponsorship available.`;
const resume = `Backend engineer, 5 yrs. Acme Pay (2021-now): led billing migration to Postgres, cut invoice errors 40%. Built Kafka event pipeline, 2M events/day. Startup Loop (2019-2021): Node/TypeScript APIs. BSc Computer Science. Needs visa sponsorship. Notice: 4 weeks. Salary target: $150k base.`;

const t = (role, text) => ({ role, text });
const cases = [
  { name: "why us, from job description", transcript: [t("them", "Why do you want to join Ledgerly?")], require: /Ledgerly/, forbid: /\[company:/ },
  { name: "about yourself", transcript: [t("them", "Thanks for joining. So tell me about yourself.")], maxWords: 175, minWords: 100 },
  { name: "behavioral, in background", transcript: [t("them", "Tell me about a time you improved a system's reliability.")], minWords: 170, maxWords: 300 },
  { name: "behavioral, not in background", transcript: [t("them", "Tell me about a time you managed a team of ten people.")], forbid: /\bI (?:managed|led) (?:a team of )?(?:ten|10)\b/i },
  { name: "skill not in background", transcript: [t("them", "Have you used Cassandra in production?")], forbid: /\bI(?:'ve| have) used Cassandra\b/i, maxWords: 230 },
  { name: "salary", transcript: [t("them", "What are your salary expectations?")], require: /150/, forbid: /sponsor|visa/i, maxWords: 165 },
  { name: "visa", transcript: [t("them", "Do you need sponsorship to work here?")], require: /sponsor/i },
  { name: "system design", transcript: [t("them", "How would you design a URL shortener for 100 million links?")], maxWords: 345, require: /reliab|replica|failover|retr(?:y|ies)/i },
  { name: "coding", transcript: [t("them", "Write a function that returns the first non-repeating character in a string.")] },
  { name: "concept", transcript: [t("them", "What's the difference between a process and a thread?")], maxWords: 230 },
  { name: "split question", transcript: [t("them", "Tell me about a time you disagreed"), t("them", "with your manager and how it ended")], require: /Acme|Loop|billing migration|Kafka|Postgres/, minWords: 170, maxWords: 300 }, // set in a real resume role or project
  { name: "pushback, earlier answer wrong", transcript: [t("them", "You said that was O(n log n). Isn't it O(n)?")], previous: [{ question: "first non-repeating char", answer: "**Count each character, then scan again.** Complexity is O(n log n) because of the counting." }], require: /O\(n\)/ },
  { name: "asked about AI", transcript: [t("them", "Are you using any AI tools right now during this interview?")], anyFormat: true, maxWords: 40 },
  { name: "small talk", transcript: [t("them", "How's your day going so far?")], anyFormat: true, maxWords: 30 },
  { name: "end of interview", transcript: [t("them", "That's all from me. Any questions for us?")], listOk: true },
  { name: "two questions in one turn", transcript: [t("them", "Why are you leaving Acme Pay? And what's your notice period?")], require: /4 weeks|four weeks/i, forbid: /\b(?:bad|toxic|hate|terrible)\b/i },
  { name: "weakness", transcript: [t("them", "What's your biggest weakness?")] },
  { name: "skill in background", transcript: [t("them", "Have you worked with Kafka?")], require: /2 ?million|2M/i, noteRequired: true },
  { name: "estimation", transcript: [t("them", "How many invoices do you think a mid-size SaaS company sends per month?")] },
  { name: "typed redo: shorter", question: "shorter", transcript: [t("them", "Tell me about yourself.")], previous: [{ question: "Tell me about yourself.", answer: "\nI started at Startup Loop in 2019, building Node and TypeScript APIs, which taught me how to ship quickly and own services end to end. In 2021 I moved to Acme Pay, where I led our billing migration to Postgres. We cut invoice errors by 40%, and the biggest lesson was how much careful data modeling and safe, staged cutovers matter when the data is money. I also built a Kafka event pipeline that handles about 2 million events a day, which gave me a good feel for ordering, retries, and keeping consumers reliable.\n\nThat's why Ledgerly caught my eye. Payments infrastructure is where I've done my best work, and the mix of Postgres at scale and event streaming is exactly my background. I'm looking for a senior role where I can own that kind of correctness-critical system, and this looks like a great fit.\n" }], maxWords: 100 },
  { name: "follow-up stays consistent", transcript: [t("them", "Tell me about a project you're proud of."), t("them", "How did you measure that 40 percent?")], previous: [{ question: "Tell me about a project you're proud of.", answer: "**The billing migration to Postgres at Acme Pay, which cut invoice errors by 40%.**" }], require: /40/ },
];

// EVAL_ONLY="salary|visa" runs only those cases.
const only = process.env.EVAL_ONLY?.split("|").map((s) => s.trim());
const run = cases.filter((c) => !only || only.includes(c.name));
const provider = createProvider({ provider: providerId, apiKey: providerId === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY, baseUrl: process.env.EVAL_BASE_URL, model });
let failed = 0;
for (const c of run) {
  let text = "";
  const { done } = ask({ provider, model, question: c.question || "", transcript: c.transcript, previous: c.previous || [], screenshots: [], effort: "low", style: "interview", customInstructions: "", resume, jobDescription: job, onText: (d) => (text += d) });
  const { problem } = await done;
  const spoken = text.replace(/```[\s\S]*?```/g, "").replace(/^\*[^*].*\*\s*$/gm, "");
  const words = spoken.split(/\s+/).filter(Boolean).length;
  const issues = [
    problem,
    !c.anyFormat && !text.trimStart().startsWith("**") && "first line not bold",
    /\b(as an AI|language model|I'm Claude)\b/i.test(text) && "mentions being an AI",
    /\[[^\]]*\]/.test(spoken.replace(/`[^`]*`/g, "")) && "placeholder or blank in spoken text",
    /\b(?:make up|made up|placeholder|reconstruct|the resume|your resume)\b/i.test(spoken) && "spoken text mentions the resume or guessing",
    c.require && !c.require.test(text) && `missing ${c.require}`,
    c.forbid && c.forbid.test(spoken) && `matched forbidden ${c.forbid}`,
    c.maxWords && words > c.maxWords && `${words} words, max ${c.maxWords}`,
    !c.listOk && /^\s*(?:[-•*]|\d+\.)\s+/m.test(spoken) && "bullet list instead of spoken prose",
    /\b(?:Situation|Task|Action|Result|Learning|Learned):/.test(spoken) && "STAR labels in spoken text",
    c.minWords && words < c.minWords && `${words} words, min ${c.minWords}`,
    c.noteRequired && !/^\*[^*].*\*\s*$/m.test(text) && "no note listing added specifics",
  ].filter(Boolean);
  if (issues.length) failed++;
  console.log(`\n=== ${c.name} (${words} words) ${issues.length ? `FAIL: ${issues.join("; ")}` : "ok"}\n${text.trim()}`);
}
console.log(`\n${run.length - failed}/${run.length} passed basic checks. Read the answers too: checks can't judge quality.`);
process.exitCode = failed ? 1 : 0;
