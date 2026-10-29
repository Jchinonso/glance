// Loaded before app.js as a plain script (highlightCode becomes a global).
// A small, language-agnostic highlighter: comments, strings, numbers and
// common keywords across Python, JS/TS, Go, Java, C-family and SQL. It works
// on raw code and escapes everything it emits. `#` and `--` only start a
// comment after whitespace and before a space, so `i--` and `#fff` stay code.
const KEYWORDS = new Set(
  (
    "and as async await break case catch class const continue def default defer del do elif else enum except export extends " +
    "false finally fn for from func function go if impl import in interface is lambda let match mut new nil None not null " +
    "or package pass private protected public raise return self static struct super switch this throw throws True true try " +
    "type typeof undefined use var void while with yield select insert update delete where join on group by order limit " +
    "SELECT FROM WHERE JOIN ON GROUP BY ORDER LIMIT INSERT UPDATE DELETE INTO VALUES AND OR NOT NULL AS"
  ).split(" "),
);
const TOKEN = /(\/\/[^\n]*|(?<=^|\s)#(?=\s|$)[^\n]*|(?<=^|\s)--(?=\s)[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b(?=\s*\()|\b([A-Za-z_]\w*)\b/g;

function escapeCode(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function highlightCode(code) {
  let out = "";
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    out += escapeCode(code.slice(last, m.index));
    const [text, comment, string, number, call, word] = m;
    const cls = comment ? "c" : string ? "s" : number ? "n" : KEYWORDS.has(call || word) ? "k" : call ? "f" : null;
    out += cls ? `<span class="tok-${cls}">${escapeCode(text)}</span>` : escapeCode(text);
    last = m.index + text.length;
  }
  return out + escapeCode(code.slice(last));
}
