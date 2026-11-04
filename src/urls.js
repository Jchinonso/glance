// Turns what someone types for a server address into the base URL to use.
// Returns "" when it isn't an address at all. Mirrored in src/ui/urls.js
// (the form's copy); test/urls.test.js checks both agree.
const STANDARD_PATHS = {
  "api.openai.com": "/v1",
  "openrouter.ai": "/api/v1",
  "api.groq.com": "/openai/v1",
  "api.mistral.ai": "/v1",
  "api.together.xyz": "/v1",
  "generativelanguage.googleapis.com": "/v1beta/openai",
  "api.deepseek.com": "/v1",
  "localhost:11434": "/v1",
  "localhost:1234": "/v1",
};
function normalizeBaseUrl(input) {
  let s = String(input ?? "").trim().replace(/\/+$/, "");
  if (!s || /\s/.test(s)) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return "";
    const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(s);
    s = `${local ? "http" : "https"}://${s}`;
  }
  if (!/^https?:\/\//i.test(s)) return "";
  let u;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (!u.hostname) return "";
  s = s.replace(/\/+$/, "");
  const afterHost = s.replace(/^https?:\/\/[^/?#]*/i, "");
  if (!afterHost) {
    const path = STANDARD_PATHS[u.host.toLowerCase()];
    if (path) s += path;
  }
  return s;
}
// Renames a model for the server it is about to be used with, without needing
// the server's list: direct vendor servers drop their own prefix, OpenRouter
// adds one. Other servers keep the name. Mirrored in src/ui/urls.js.
const VENDOR_PREFIX = {
  "api.openai.com": "openai",
  "generativelanguage.googleapis.com": "google",
  "api.mistral.ai": "mistralai",
  "api.deepseek.com": "deepseek",
  "api.x.ai": "x-ai",
};
const OPENROUTER_PREFIXES = [
  [/^(gpt-|o\d|chatgpt-)/, "openai/"],
  [/^claude-/, "anthropic/"],
  [/^gemini-|^gemma-/, "google/"],
  [/^(mistral|codestral|magistral|ministral|pixtral)/, "mistralai/"],
  [/^deepseek/, "deepseek/"],
  [/^grok/, "x-ai/"],
  [/^llama/, "meta-llama/"],
  [/^qwen/, "qwen/"],
];
function renameModelForServer(model, baseUrl) {
  const m = String(model ?? "").trim();
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return m;
  }
  if (!m) return m;
  if (host === "openrouter.ai") {
    if (m.includes("/")) return m;
    const hit = OPENROUTER_PREFIXES.find(([re]) => re.test(m));
    return hit ? hit[1] + m : m;
  }
  const vendor = VENDOR_PREFIX[host];
  if (!vendor) return m;
  let out = m.replace(/^~/, "").replace(/:(free|nitro|floor)$/, "");
  if (out.startsWith(`${vendor}/`)) out = out.slice(vendor.length + 1);
  return out;
}
export { normalizeBaseUrl, renameModelForServer };
