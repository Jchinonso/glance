import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeWord, planHotwords, readTokens, sherpaSplit } from "../src/hotwords.js";

// Parakeet TDT 0.6B v2's real tokens.txt.
const tokens = readTokens(readFileSync(new URL("./fixtures/parakeet-tokens.txt", import.meta.url), "utf8"));
const TECH_TERMS = "React, Next.js, TypeScript, JavaScript, Node.js, Python, Go, Rust, Java, Postgres, PostgreSQL, MySQL, Redis, MongoDB, Kubernetes, Docker, GraphQL, REST, API, AWS, GCP, Azure, SQL, LeetCode".split(", ");

test("reads tokens.txt", () => {
  assert.equal(tokens.size, 1025);
  assert.equal(tokens.get("<unk>"), 0);
  assert.equal(tokens.get("▁t"), 1);
  assert.equal(tokens.get("▁"), 819);
});

test("splits words exactly as the model writes them", () => {
  // The model's own output for these words, from a real transcription.
  assert.deepEqual(encodeWord("Postgres", tokens), ["▁P", "ost", "g", "res"]);
  assert.deepEqual(encodeWord("Kubernetes", tokens), ["▁K", "u", "ber", "n", "et", "es"]);
  assert.deepEqual(encodeWord("Node.js", tokens), ["▁N", "od", "e", ".", "j", "s"]);
  assert.deepEqual(encodeWord("shortener", tokens), ["▁sh", "ort", "en", "er"]);
  assert.deepEqual(encodeWord("differently", tokens), ["▁different", "ly"]);
  assert.equal(encodeWord("🚀", tokens), null);
  assert.equal(encodeWord("", tokens), null);
});

test("every tech term and typical names are encoded, and sherpa's encoder would split them the same way", () => {
  const phrases = ["Priya", "Ledgerly", "pgvector", "Hugging Face", "Señor Ñoño", ...TECH_TERMS];
  const plan = planHotwords(phrases, tokens);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.used.length, phrases.length);
  const scores = new Map(plan.vocab.trim().split("\n").map((l) => l.split("\t")).map(([p, s]) => [p, Number(s)]));
  for (const p of scores.keys()) assert.ok(tokens.has(p), `${p} is a model token`);
  for (const phrase of plan.used) {
    for (const word of phrase.split(" ")) assert.deepEqual(sherpaSplit(word, scores), encodeWord(word, tokens), word);
  }
  assert.match(plan.hotwords, /^Priya :1\.0\/Ledgerly :1\.0\/pgvector :1\.0\/Hugging Face :1\.0\//);
  assert.ok(plan.hotwords.split("/").every((h) => / :1\.0$/.test(h)));
});

test("phrases that can't be spelled with the model's pieces are left out, the rest kept", () => {
  const plan = planHotwords(["Postgres", "rocket 🚀", "日本", ":colon", "  ", "Postgres", "Redis"], tokens);
  assert.deepEqual(plan.used, ["Postgres", "Redis"]);
  assert.deepEqual(plan.skipped, ["rocket 🚀", "日本", ":colon"]);
  assert.equal(plan.hotwords, "Postgres :1.0/Redis :1.0");
});

test("a word that only exists in lower case is used in lower case", () => {
  // "Ä" isn't in the vocabulary, "ä" is.
  assert.equal(encodeWord("Äpfel", tokens), null);
  const plan = planHotwords(["Äpfel"], tokens);
  assert.deepEqual(plan.used, ["Äpfel"]);
  assert.equal(plan.hotwords, "äpfel :1.0");
});

test("each phrase gets its own boost, and a duplicate keeps the first one", () => {
  const plan = planHotwords([{ phrase: "Ledgerly", boost: 2 }, "Postgres"], tokens);
  assert.deepEqual(plan.used, ["Ledgerly", "Postgres"]);
  assert.equal(plan.hotwords, "Ledgerly :2.0/Postgres :1.0");
  const dup = planHotwords([{ phrase: "Ledgerly", boost: 2 }, "Ledgerly"], tokens);
  assert.deepEqual(dup.used, ["Ledgerly"]);
  assert.equal(dup.hotwords, "Ledgerly :2.0");
});

test("nothing to listen for: no vocabulary and no hotwords", () => {
  assert.deepEqual(planHotwords([], tokens), { hotwords: "", vocab: "", used: [], skipped: [] });
});

test("sherpa's encoder copy: a dead end scores 0, which a negative score would prefer", () => {
  // Why the scores are positive: with "▁" at -1 sherpa would pick it and then <unk>.
  const bad = new Map([["▁", -1], ["▁R", -1], ["ea", -1], ["ct", -1]]);
  assert.equal(sherpaSplit("React", bad), null);
  const good = new Map([["▁", 999], ["▁R", 1999], ["ea", 1999], ["ct", 1999]]);
  assert.deepEqual(sherpaSplit("React", good), ["▁R", "ea", "ct"]);
});
