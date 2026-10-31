import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { extractResume, tidy } from "../src/resume.js";

const RESUME = "Jane Doe\nBackend engineer, 5 years.\n\nAcme Pay (2021-now): led billing migration to Postgres, cut invoice errors 40%.";

test("tidy keeps every word, drops page breaks and extra blank lines", () => {
  assert.equal(tidy("Jane Doe  \r\n\f\n\n\nSkills: Go"), "Jane Doe\n\nSkills: Go");
});

test("reads text, Word and RTF files word for word", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glance-resume-"));
  const txt = path.join(dir, "cv.txt");
  writeFileSync(txt, RESUME);
  execFileSync("/usr/bin/textutil", ["-convert", "docx", txt, "-output", path.join(dir, "cv.docx")]);
  execFileSync("/usr/bin/textutil", ["-convert", "rtf", txt, "-output", path.join(dir, "cv.rtf")]);
  for (const f of ["cv.txt", "cv.docx", "cv.rtf"]) assert.equal(await extractResume(path.join(dir, f)), RESUME, f);
});

test("rejects unsupported files with a clear message", async () => {
  await assert.rejects(extractResume("/tmp/photo.png"), /can't read \.png/);
});

test("PDF from a browser or word processor keeps its lines and wording", async () => {
  const text = await extractResume(new URL("./fixtures/resume.pdf", import.meta.url).pathname);
  for (const line of [
    "Jane Doe",
    "EXPERIENCE",
    "Acme Pay, Backend Engineer, 2021 – present",
    "Led billing migration to Postgres, cut invoice errors 40%.",
    "Built Kafka event pipeline handling 2M events/day.",
    "BSc Computer Science",
  ]) assert.ok(text.split("\n").includes(line), line);
});
