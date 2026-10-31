// Loaded before app.js as a plain script (renderMarkdown becomes a global).
// Renders the Markdown subset models write in answers: fenced code (colored
// by highlightCode), headings, bullet and numbered lists, tables, bold,
// italics, inline code and links. Parsed line by line, so a heading or list
// directly under a paragraph still renders. All text is escaped.

function escapeMd(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inlineMd(text) {
  // Inline code first, so its contents are never treated as formatting.
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeMd(part.slice(1, -1))}</code>`;
      return escapeMd(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
        .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![\w_])/g, "$1<em>$2</em>") // _italic_, not snake_case
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<span class="link" title="$2">$1</span>');
    })
    .join("");
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function renderTable(rows) {
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inlineMd(c.trim()));
  const [head, ...body] = rows.filter((r) => !TABLE_RULE.test(r));
  return `<table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body
    .map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function renderBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inlineMd).join("<br>")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) {
      flush();
    } else if (HEADING.test(l)) {
      flush();
      out.push(`<h4>${inlineMd(l.replace(HEADING, ""))}</h4>`);
    } else if (BULLET.test(l) || NUMBERED.test(l)) {
      flush();
      const re = BULLET.test(l) ? BULLET : NUMBERED;
      const items = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ""));
      i--;
      const tag = re === BULLET ? "ul" : "ol";
      out.push(`<${tag}>${items.map((it) => `<li>${inlineMd(it)}</li>`).join("")}</${tag}>`);
    } else if (TABLE_ROW.test(l) && TABLE_RULE.test(lines[i + 1] || "")) {
      flush();
      const rows = [];
      while (i < lines.length && (TABLE_ROW.test(lines[i]) || TABLE_RULE.test(lines[i]))) rows.push(lines[i++]);
      i--;
      out.push(renderTable(rows));
    } else {
      para.push(l);
    }
  }
  flush();
  return out.join("");
}

function renderMarkdown(src) {
  return src
    .split(/```/)
    .map((part, i) => (i % 2 === 1 ? `<pre><code>${highlightCode(part.replace(/^[\w+#.-]*\n/, ""))}</code></pre>` : renderBlocks(part)))
    .join("");
}

// Interview answers carry a "Keys: a · b · c" line under the bold first line
// (same rule as splitKeys in assistant.js). Returns the answer without it.
function splitKeys(text) {
  const lines = (text || "").split("\n");
  // Needs the " · " separator, so an ordinary line starting "Keys:" stays.
  const i = lines.slice(0, 6).findIndex((l) => /^\s*(?:\*\*)?Keys:/i.test(l) && l.includes("·"));
  if (i < 0) return { text: text || "", keys: [] };
  const keys = lines[i].replace(/^\s*(?:\*\*)?Keys:(?:\*\*)?\s*/i, "").split(/\s+·\s+/).map((k) => k.replace(/^[\s·]+|[\s·]+$/g, "")).filter(Boolean);
  // Drop the line and one of the blank lines around it.
  lines.splice(i, !lines[i + 1]?.trim() && !lines[i - 1]?.trim() ? 2 : 1);
  return { text: lines.join("\n"), keys };
}
