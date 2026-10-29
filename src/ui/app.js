const $ = (id) => document.getElementById(id);
const g = window.glance;

let state = {};
let heard = []; // transcript lines shown in this window
let answers = []; // { id, question, text, status: "streaming" | "done" | "error", error }
let page = -1; // index into answers, -1 when none
let view = "answers"; // "answers" | "transcript"
let editingKey = false;
let editingInstructions = false;
let settingsOpen = false;
let collapsed = false;
let pendingQuestion = null;
let editingShortcuts = false;
let recording = null; // action whose shortcut is being recorded

const SHORTCUT_LABELS = {
  snap: "Screenshot and answer",
  ask: "Ask what you've typed",
  listen: "Start or stop listening",
  toggleWindow: "Show or hide Glance",
  addShot: "Add a screenshot without asking",
  invisible: "Hide from screen sharing",
};
const KEY_SYMBOLS = { CommandOrControl: "⌘", Command: "⌘", Cmd: "⌘", Control: "⌃", Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Enter: "↵", Return: "↵", Up: "↑", Down: "↓", Left: "←", Right: "→", Space: "Space", Backspace: "⌫", Tab: "⇥" };

function accelKeys(accel = "") {
  return accel.split("+").map((k) => KEY_SYMBOLS[k] || k);
}
function keycaps(accel, small = false) {
  return accelKeys(accel).map((k) => `<kbd class="cap${small ? " sm" : ""}">${escapeHtml(k)}</kbd>`).join("");
}
function plainKeys(accel) {
  return accelKeys(accel).join("");
}

// Electron accelerator from a key press; null until a real key is pressed.
function accelFromEvent(e) {
  const named = { Enter: "Enter", " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Backspace: "Backspace", Tab: "Tab" };
  if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return null;
  let key = named[e.key];
  if (!key && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  if (!key && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (!key) key = { Backslash: "\\", Slash: "/", Period: ".", Comma: ",", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`" }[e.code];
  if (!key) return null;
  const mods = [e.metaKey && "CommandOrControl", e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  if (!mods.some((m) => m !== "Shift")) return null;
  return [...mods, key].join("+");
} // latest question someone else asked, until answered



function setCollapsed(on) {
  collapsed = on;
  document.body.classList.toggle("collapsed", on);
  $("collapseBtn").setAttribute("aria-pressed", String(on));
  $("collapseBtn").title = on ? "Expand" : "Collapse to the top bar";
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function line({ role, text }) {
  const who = role === "me" ? "You" : "Them";
  return `<span class="who ${role}">${who}</span>${escapeHtml(text)}`;
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function renderTimer() {
  $("timer").textContent = state.listening && state.listeningSince ? formatElapsed(Date.now() - state.listeningSince) : "";
}
setInterval(renderTimer, 1000);

function renderStrip() {
  document.body.classList.toggle("listening", !!state.listening);
  document.body.classList.toggle("answering", !!state.busy);
  renderTimer();
  const cloak = $("cloakBtn");
  cloak.setAttribute("aria-pressed", String(!!state.invisible));
  cloak.title = state.invisible ? "Hidden from screen sharing. Click to show it (⌘⇧H)." : "Visible in screen sharing. Click to hide it (⌘⇧H).";
  const last = heard.at(-1);
  $("caption").hidden = !state.listening;
  if (pendingQuestion && state.listening) {
    $("caption").innerHTML = `<span class="qtag">Question</span><span class="qtext">${escapeHtml(pendingQuestion)}</span><button type="button" class="answer-q" id="answerQBtn" title="Answer this question (⌘↵)">Answer</button>`;
  } else {
    $("caption").innerHTML = last ? line(last) : "Listening for speech…";
  }
}

function renderMenu() {
  for (const b of $("effort").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === state.effort));
  $("cloakToggle").setAttribute("aria-checked", String(!!state.invisible));
  const sp = state.spend || { input: 0, output: 0, dollars: 0 };
  $("spendTotal").textContent = sp.dollars ? `about ${formatDollars(sp.dollars)}` : "";
  $("spendMeta").textContent = sp.dollars
    ? `${sp.input.toLocaleString()} tokens in, ${sp.output.toLocaleString()} out, at Opus 5.5 list prices`
    : "Nothing spent yet";
  $("saveNotesBtn").disabled = !!state.savingNotes;
  $("saveNotesMeta").textContent = state.savingNotes ? "Writing your notes…" : "Summary, decisions, action items and full transcript, to Documents/Glance";
  const n = state.transcriptCount || 0;
  $("transcriptMeta").textContent = n ? `${n.toLocaleString()} line${n === 1 ? "" : "s"} so far` : "What Glance has heard so far";
  $("instructionsMeta").textContent = state.customInstructions?.trim() ? "on" : "off";
  $("keyMeta").textContent = state.keyHint ? `ends in ${state.keyHint}` : "not set";
  $("autoScreenToggle").setAttribute("aria-checked", String(!!state.autoScreen));
  for (const b of $("transcription").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === state.transcription));
  if (document.activeElement !== $("vocabularyInput")) $("vocabularyInput").value = state.vocabulary || "";
  for (const b of $("style").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === state.style));
}

function renderShortcutHints() {
  const k = state.shortcuts;
  if (!k) return;
  $("guide").innerHTML = [
    ["snap", "Screenshot your screen and get an answer"],
    ["ask", "Ask what you've typed below"],
    ["listen", "Start or stop listening to your call"],
    ["toggleWindow", "Show or hide Glance"],
  ]
    .map(([a, label]) => `<li><span class="keys">${keycaps(k[a])}</span><span>${label}</span></li>`)
    .join("");
  $("hints").innerHTML = [["snap", "Screenshot"], ["ask", "Ask"], ["listen", "Listen"]]
    .map(([a, label]) => `<span>${keycaps(k[a], true)} ${label}</span>`)
    .join("");
  $("listenBtn").title = `Listen to your call so answers can use what's said (${plainKeys(k.listen)})`;
  $("shotBtn").title = `Screenshot your screen and answer it (${plainKeys(k.snap)}). Shift-click or ${plainKeys(k.addShot)} to collect several first.`;
  $("hideTopBtn").title = `Hide Glance (${plainKeys(k.toggleWindow)}). Bring it back from the menu bar icon.`;
}

function renderShortcutList() {
  const k = state.shortcuts || {};
  $("shortcutList").innerHTML = Object.entries(SHORTCUT_LABELS)
    .map(
      ([a, label]) =>
        `<div class="row"><div class="row-text"><span>${label}</span></div><button type="button" class="keyrec${recording === a ? " recording" : ""}" data-action="${a}">${recording === a ? "Press new keys…" : keycaps(k[a], true)}</button></div>`,
    )
    .join("");
}

function renderStage() {
  const needsKey = !state.hasKey || editingKey;
  $("keyForm").hidden = !needsKey;
  const changing = needsKey && state.hasKey;
  $("keyLead").textContent = changing ? `Replace your API key (current one ends in ${state.keyHint}).` : "Add your Anthropic API key to start.";
  $("keyManage").hidden = !changing;
  const shortcutsOpen = !needsKey && editingShortcuts;
  $("shortcutsPanel").hidden = !shortcutsOpen;
  if (shortcutsOpen) renderShortcutList();
  const settings = !needsKey && !editingInstructions && !shortcutsOpen && settingsOpen;
  $("menu").hidden = !settings;
  $("menuBtn").setAttribute("aria-expanded", String(settings));
  $("menuBtn").title = settings ? "Close settings" : "Settings";
  document.body.classList.toggle("settings-open", settings);
  const instr = !needsKey && editingInstructions;
  $("instructionsForm").hidden = !instr;
  const covered = needsKey || instr || settings || shortcutsOpen;
  $("welcome").hidden = covered || view !== "answers" || answers.length > 0;
  $("answer").hidden = covered || view !== "answers" || page < 0;
  $("transcript").hidden = covered || view !== "transcript";
  // After the first answer, the full guide shrinks to one line of hints.
  const guided = hasSeenAnswer();
  $("guide").hidden = guided;
  $("hints").hidden = !guided;

  const a = answers[page];
  if (a && !$("answer").hidden) {
    $("answer").classList.toggle("streaming", a.status === "streaming");
    $("answerQ").textContent = a.question || "Help with what's on screen";
    $("answerBody").innerHTML = renderMarkdown(a.text) + (a.error ? `<p class="err">${escapeHtml(a.error)}</p>` : "");
    $("answerUsage").hidden = !a.usage;
    if (a.usage) $("answerUsage").textContent = `About ${formatDollars(a.usage.cost)} for this answer (${a.usage.input.toLocaleString()} tokens in, ${a.usage.output.toLocaleString()} out)`;
  }

  document.querySelector(".dock").hidden = needsKey || instr || settings || shortcutsOpen;

  const showPager = view === "answers" && answers.length > 1 && !covered;
  $("pager").hidden = !showPager;
  if (showPager) {
    $("pageLabel").textContent = `${page + 1} of ${answers.length}`;
    $("prevBtn").disabled = page <= 0;
    $("nextBtn").disabled = page >= answers.length - 1;
  }

  const busy = !!state.busy;
  $("askBtn").classList.toggle("stop", busy);
  $("askBtn").textContent = busy ? "Stop" : "Ask";
  $("askBtn").title = busy ? "Stop this answer" : `Ask (${plainKeys(state.shortcuts?.ask || "")})`;
}

function renderShots() {
  const shots = state.shots || [];
  $("shots").hidden = !shots.length;
  $("shotCount").hidden = !shots.length;
  $("shotCount").textContent = shots.length;
  $("shots").innerHTML = shots
    .map(
      (s, i) => `<figure class="shot"><img src="${s.thumb}" alt="Screenshot ${i + 1}" /><button type="button" class="remove" data-id="${s.id}" title="Remove screenshot"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" /></svg></button></figure>`,
    )
    .join("");
  $("question").placeholder = shots.length ? `Ask about ${shots.length === 1 ? "this screenshot" : `these ${shots.length} screenshots`}, or just press Ask` : "Type a question, or just press Ask";
}

function formatDollars(n) {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function render() {
  renderShortcutHints();
  renderStrip();
  renderMenu();
  renderStage();
  renderShots();
}

function renderTranscriptLine(l) {
  $("transcriptEmpty").hidden = true;
  const p = document.createElement("p");
  p.className = "line";
  p.innerHTML = line(l);
  $("transcript").appendChild(p);
  if (view === "transcript") $("stage").scrollTop = $("stage").scrollHeight;
}

function showNotice({ level, text, action }) {
  const n = $("notice");
  n.hidden = false;
  n.className = `notice ${level}`;
  n.textContent = text;
  if (action?.type === "open") {
    const b = document.createElement("button");
    b.className = "notice-action";
    b.textContent = "Open notes";
    b.addEventListener("click", () => g.openNotes(action.path));
    n.append(" ", b);
  }
  if (action === "screen-settings") {
    const b = document.createElement("button");
    b.className = "notice-action";
    b.textContent = "Open Screen Recording settings";
    b.addEventListener("click", () => g.openScreenSettings());
    n.append(" ", b);
  }
  clearTimeout(showNotice.t);
  showNotice.t = setTimeout(() => (n.hidden = true), action ? 30000 : 8000);
}

function snapSubmit() {
  if (state.busy) return;
  const q = $("question").value;
  $("question").value = "";
  view = "answers";
  g.snapAsk(q);
}

function setMenu(open) {
  settingsOpen = open;
  if (open) editingInstructions = false;
  render();
  $("stage").scrollTop = 0;
}

function hasSeenAnswer() {
  try {
    return localStorage.getItem("glance.seenAnswer") === "1";
  } catch {
    return answers.length > 0;
  }
}

function submit() {
  if (state.busy) return g.cancel();
  // Nothing typed but a question was just heard: answer exactly that one.
  const q = $("question").value.trim() || (state.listening && pendingQuestion) || "";
  $("question").value = "";
  view = "answers";
  g.ask(q);
}

g.on("state", (s) => {
  state = s;
  render();
});
g.on("notice", showNotice);
g.on("transcript", (l) => {
  heard.push(l);
  state.transcriptCount = (state.transcriptCount || 0) + 1;
  if (l.role === "them" && isQuestion(l.text)) pendingQuestion = l.text;
  renderStrip();
  renderTranscriptLine(l);
});
g.on("focus-input", () => $("question").focus());
g.on("submit", submit);
g.on("snap-submit", snapSubmit);

g.on("answer-start", ({ id, question }) => {
  answers.push({ id, question, text: "", status: "streaming" });
  page = answers.length - 1;
  view = "answers";
  settingsOpen = false;
  pendingQuestion = null;
  setCollapsed(false);
  renderStrip();
  try {
    localStorage.setItem("glance.seenAnswer", "1");
  } catch {}
  renderStage();
});
g.on("answer-delta", ({ id, text }) => {
  const a = answers.find((x) => x.id === id);
  if (!a) return;
  a.text += text;
  if (answers[page] === a) {
    renderStage();
    $("stage").scrollTop = $("stage").scrollHeight;
  }
});
g.on("answer-end", ({ id, error, aborted, usage }) => {
  const i = answers.findIndex((x) => x.id === id);
  if (i < 0) return;
  const a = answers[i];
  if (aborted && !a.text) {
    answers.splice(i, 1);
    page = Math.min(page, answers.length - 1);
  } else {
    a.status = error ? "error" : "done";
    a.error = error;
    a.usage = usage;
  }
  renderStage();
});

$("askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});
$("keyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("keyInput").value.trim();
  if (!key) return;
  g.setApiKey(key);
  $("keyInput").value = "";
  editingKey = false;
});
$("cancelKeyBtn").addEventListener("click", () => {
  editingKey = false;
  $("keyInput").value = "";
  render();
});
$("removeKeyBtn").addEventListener("click", () => {
  editingKey = false;
  $("keyInput").value = "";
  g.setApiKey("");
});
$("pasteKeyBtn").addEventListener("click", async () => {
  $("keyInput").value = "";
  await pasteInto($("keyInput"));
  $("keyInput").focus();
});
$("listenBtn").addEventListener("click", () => g.toggleListening());
$("menuBtn").addEventListener("click", () => {
  setCollapsed(false);
  setMenu(!settingsOpen);
});
$("saveNotesBtn").addEventListener("click", () => {
  setMenu(false);
  g.saveNotes();
});
$("shortcutsBtn").addEventListener("click", () => {
  settingsOpen = false;
  editingShortcuts = true;
  render();
});
function stopRecording() {
  if (!recording) return;
  recording = null;
  g.pauseShortcuts(false);
  renderShortcutList();
}
$("shortcutList").addEventListener("click", (e) => {
  const action = e.target.closest(".keyrec")?.dataset.action;
  if (!action) return;
  if (recording === action) return stopRecording();
  recording = action;
  g.pauseShortcuts(true);
  renderShortcutList();
});
document.addEventListener(
  "keydown",
  async (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") return stopRecording();
    const accel = accelFromEvent(e);
    if (!accel) return;
    const action = recording;
    recording = null;
    const { error } = await g.setShortcut(action, accel);
    g.pauseShortcuts(false);
    if (error) showNotice({ level: "error", text: error });
    renderShortcutList();
  },
  true,
);
$("shortcutsReset").addEventListener("click", () => g.resetShortcuts());
$("shortcutsDone").addEventListener("click", () => {
  stopRecording();
  editingShortcuts = false;
  render();
});
$("collapseBtn").addEventListener("click", () => setCollapsed(!collapsed));
$("hideTopBtn").addEventListener("click", () => g.hide());
$("copyBtn").addEventListener("click", () => {
  const a = answers[page];
  if (!a?.text) return;
  g.writeClipboard(a.text);
  $("copyBtn").classList.add("done");
  setTimeout(() => $("copyBtn").classList.remove("done"), 1400);
});
$("effort").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (v) g.setSetting("effort", v);
});
$("transcription").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (v) g.setSetting("transcription", v);
});
// Saves when you leave the field or press Return.
$("vocabularyInput").addEventListener("change", () => g.setSetting("vocabulary", $("vocabularyInput").value.trim()));
$("vocabularyInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("vocabularyInput").blur();
});
$("style").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (v) g.setSetting("style", v);
});
$("cloakBtn").addEventListener("click", () => g.setSetting("invisible", !state.invisible));
$("cloakToggle").addEventListener("click", () => g.setSetting("invisible", !state.invisible));
$("autoScreenToggle").addEventListener("click", () => g.setSetting("autoScreen", !state.autoScreen));
// Click: screenshot and answer. Shift-click: add to the tray without asking yet.
$("shotBtn").addEventListener("click", (e) => (e.shiftKey ? g.addShot() : snapSubmit()));
$("shots").addEventListener("click", (e) => {
  const id = Number(e.target.closest(".remove")?.dataset.id);
  if (id) g.removeShot(id);
});
$("transcriptToggle").addEventListener("click", () => {
  view = "transcript";
  setMenu(false);
});
$("clearBtn").addEventListener("click", () => {
  g.clear();
  answers = [];
  page = -1;
  heard = [];
  pendingQuestion = null;
  $("transcript").querySelectorAll(".line").forEach((n) => n.remove());
  $("transcriptEmpty").hidden = false;
  setMenu(false);
  render();
});
// About 4 characters per token for English text; good enough for an estimate.
const approxTokens = (text) => Math.ceil(text.trim().length / 4);

function updateInstructionsCount() {
  const text = $("instructionsInput").value;
  $("instructionsCount").textContent = `${text.length} of 4000 characters, about ${approxTokens(text)} tokens before compression`;
}
function closeInstructions() {
  editingInstructions = false;
  render();
}
$("instructionsBtn").addEventListener("click", () => {
  settingsOpen = false;
  editingInstructions = true;
  $("instructionsInput").value = state.customInstructions || "";
  updateInstructionsCount();
  setMenu(false);
  render();
  $("instructionsInput").focus();
});
$("instructionsInput").addEventListener("input", updateInstructionsCount);
$("instructionsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  g.setSetting("customInstructions", $("instructionsInput").value);
  closeInstructions();
});
$("instructionsCancel").addEventListener("click", closeInstructions);
$("instructionsClear").addEventListener("click", () => {
  $("instructionsInput").value = "";
  updateInstructionsCount();
  $("instructionsInput").focus();
});
$("keyBtn").addEventListener("click", () => {
  settingsOpen = false;
  editingKey = true;
  setMenu(false);
  render();
  $("keyInput").focus();
});
$("quitBtn").addEventListener("click", () => g.quit());
$("prevBtn").addEventListener("click", () => {
  page = Math.max(0, page - 1);
  renderStage();
});
$("nextBtn").addEventListener("click", () => {
  page = Math.min(answers.length - 1, page + 1);
  renderStage();
});
// Glance is a non-activating panel, so macOS sends ⌘C/⌘V/⌘X/⌘A/⌘Z to the
// frontmost app's menu instead of ours. Handle them here.
async function pasteInto(input) {
  const raw = await g.readClipboard();
  const text = input instanceof HTMLTextAreaElement ? raw.replace(/\r\n/g, "\n") : raw.replace(/\r?\n/g, " ").trim();
  if (!text) return;
  input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "z" && (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
    e.preventDefault();
    document.execCommand("redo");
    return;
  }
  if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
    const k = e.key.toLowerCase();
    const input = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement ? e.target : null;
    if (k === "v" && input) {
      e.preventDefault();
      pasteInto(input);
      return;
    }
    if (k === "z" && input) {
      e.preventDefault();
      document.execCommand("undo");
      return;
    }
    if (k === "a" && input) {
      e.preventDefault();
      input.select();
      return;
    }
    if (k === "c" || k === "x") {
      const text = input ? input.value.slice(input.selectionStart, input.selectionEnd) : String(window.getSelection());
      if (!text) return;
      e.preventDefault();
      g.writeClipboard(text);
      if (k === "x" && input && input.type !== "password") input.setRangeText("", input.selectionStart, input.selectionEnd, "end");
      return;
    }
  }
  if (e.key === "Escape") {
    if (editingShortcuts) {
      editingShortcuts = false;
      render();
    } else if (settingsOpen) setMenu(false);
    else if (editingInstructions) closeInstructions();
    else if (view === "transcript") {
      view = "answers";
      render();
    }
    else g.hide();
  }
});

// Fit the window to the content so it stays as small as possible.
function fit() {
  const h = [...$("glass").children].reduce((sum, el) => (el.hidden || el.classList.contains("rim") ? sum : sum + el.getBoundingClientRect().height), 0);
  g.resize(Math.ceil(h));
}
const sizer = new ResizeObserver(fit);
for (const el of $("glass").children) sizer.observe(el);
new MutationObserver(fit).observe($("glass"), { subtree: true, attributes: true, attributeFilter: ["hidden"] });

g.getState().then((s) => {
  const { transcript, ...rest } = s;
  state = rest;
  heard = transcript;
  heard.forEach(renderTranscriptLine);
  render();
  $("question").focus();
});

// Fade the top edge only once the content has scrolled under it.
$("stage").addEventListener("scroll", () => $("stage").classList.toggle("scrolled", $("stage").scrollTop > 4));

// One click (or ⌘↵) answers the detected question; Claude already treats the
// latest question in the transcript as the thing to answer.
$("caption").addEventListener("click", (e) => {
  if (e.target.closest("#answerQBtn")) submit();
});

