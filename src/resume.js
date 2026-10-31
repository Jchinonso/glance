// Pulls the text out of a resume file with tools built into macOS, so nothing
// extra is installed: PDFKit (via JavaScript for Automation) for PDF, textutil
// for Word and RTF. The wording is kept as written; only whitespace is tidied.
// PDFKit keeps line breaks for PDFs from Word, Google Docs and browsers, but
// can join lines it takes for one paragraph and drops bullets drawn as
// shapes, so the form asks the user to check imported PDF text.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const RESUME_EXTENSIONS = ["pdf", "docx", "doc", "rtf", "txt", "md"];

const PDF_SCRIPT = `function run(argv) {
  ObjC.import("PDFKit");
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  return doc.isNil() ? "" : doc.string.js || "";
}`;

function run(binary, args) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// Keeps every word; drops page breaks, trailing spaces and runs of blank lines.
export function tidy(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\f ]/g, (c) => (c === "\f" ? "\n" : " "))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractResume(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!RESUME_EXTENSIONS.includes(ext)) throw new Error(`Glance can't read .${ext} files. Use PDF, Word, RTF, text or Markdown.`);
  let text;
  if (ext === "txt" || ext === "md") text = await readFile(file, "utf8");
  else if (ext === "pdf") text = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", PDF_SCRIPT, file]);
  else text = await run("/usr/bin/textutil", ["-convert", "txt", "-stdout", file]);
  text = tidy(text);
  if (!text) throw new Error(ext === "pdf" ? "No text found in this PDF. It may be a scanned image; paste the text instead." : "No text found in this file.");
  return text;
}
