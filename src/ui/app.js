const $ = (id) => document.getElementById(id);
const g = window.glance;

let state = {};
let heard = []; // transcript lines shown in this window
let answers = []; // { id, question, text, status: "streaming" | "done" | "error", error }
let page = -1; // index into answers, -1 when none
let view = "answers"; // "answers" | "transcript"
// The one panel covering the answers, or null: "settings", "key" (changing the
// provider; the key form also shows whenever there's no key), "instructions",
// "doc" (resume or job description, see docKind), "profile", "shortcuts" or
// "wipe" (delete all Glance data).
// A panel opened from Settings (and the transcript) goes back there when
// closed, to the same tab.
let panel = null;
let backToSettings = false;
let docKind = null; // "resume" | "jobDescription" while panel is "doc"
// Setup in progress: { step, needsKey, use }. Null once done or skipped.
let onboarding = null;
// The "New interview?" card is showing.
let askingJob = false;
let collapsed = false;
let pendingQuestion = null; // latest question someone else asked, until answered
// Settings tab, remembered per viewer; settings work without it.
let settingsTab = (() => {
  try {
    return localStorage.getItem("glance.settingsTab") || "answers";
  } catch {
    return "answers";
  }
})();
const STYLE_HINTS = {
  natural: "Natural: complete answers in plain, friendly prose.",
  brief: "Brief: short answers with only what matters.",
};
// Interview mode is the "interview" style. The meeting style is the one used
// outside it, remembered while Interview mode is on.
function meetingStyle() {
  if (state.style !== "interview") return state.style === "natural" ? "natural" : "brief";
  try {
    return localStorage.getItem("glance.styleBeforeInterview") === "natural" ? "natural" : "brief";
  } catch {
    return "brief";
  }
}
const MODEL_HINTS = {
  "claude-opus-5-5": "Opus 5.5: most capable, $4 / $20 per million tokens",
  "claude-sonnet-5-5": "Sonnet 5.5: nearly as good, half the price",
  "claude-haiku-5-5": "Haiku 5.5: fastest, about 1/40 of Opus's price",
};
let recording = null; // action whose shortcut is being recorded
// Interview answers open in full, or as key points (Settings > Interview >
// Open answers as key points). The link on an answer switches just that view.
let answerView = "full";
let editingSaid = false; // the "I said something else" field is open

const SHORTCUT_LABELS = {
  snap: "Screenshot and answer",
  ask: "Answer the question just heard, or what you've typed",
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
}

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
    $("caption").innerHTML = `<span class="qtag">Question</span><span class="qtext" title="${escapeHtml(pendingQuestion.text)}">${escapeHtml(pendingQuestion.text)}</span><button type="button" class="answer-q" id="answerQBtn" title="${waitingForQuestion ? "Waiting for them to finish the question" : "Answer this question (⌘↵)"}"${waitingForQuestion ? " disabled" : ""}>${waitingForQuestion ? "Waiting…" : "Answer"}</button>`;
  } else {
    $("caption").innerHTML = last ? line(last) : "Listening for speech…";
  }
}

function renderMenu() {
  for (const b of $("settingsTabs").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === settingsTab));
  for (const t of document.querySelectorAll("#menu .tab")) t.hidden = t.dataset.tab !== settingsTab;
  $("styleHint").textContent = `${STYLE_HINTS[meetingStyle()]}${state.style === "interview" ? " Used when you switch back to Meeting." : ""}`;
  const interview = state.style === "interview";
  $("interviewToggle").setAttribute("aria-checked", String(interview));
  $("interviewOffNote").hidden = interview;
  $("cloakWarn").hidden = !!state.invisible;
  const openai = state.provider === "openai";
  $("anthropicModelRow").hidden = openai;
  $("effortRow").hidden = openai; // depth is an Anthropic setting
  $("openaiModelRow").hidden = !openai;
  $("openaiModelMeta").textContent = state.openaiModel || "not set";
  $("openaiModelHint").textContent = `OpenAI-compatible, ${hostOf(state.openaiBaseUrl)}`;
  for (const b of $("model").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === state.model));
  $("modelHint").textContent = MODEL_HINTS[state.model] || "";
  for (const b of $("effort").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === state.effort));
  $("cloakToggle").setAttribute("aria-checked", String(!!state.invisible));
  $("compactToggle").setAttribute("aria-checked", String(!!state.compactAnswers));
  $("autoAnswerToggle").setAttribute("aria-checked", String(!!state.autoAnswer));
  $("autoAnswerHint").textContent = state.style === "interview"
    ? "While listening, starts the answer as soon as the interviewer finishes a question, so you don't have to press Answer."
    : "Only works in Interview mode, which is off. Switch with the menu beside the question box.";
  const sp = state.spend || { input: 0, output: 0, dollars: 0 };
  $("spendTotal").textContent = sp.dollars ? `about ${formatDollars(sp.dollars)}` : "";
  $("spendMeta").textContent = sp.dollars
    ? `${sp.input.toLocaleString()} tokens in, ${sp.output.toLocaleString()} out, at list prices`
    : sp.input
      ? `${sp.input.toLocaleString()} tokens in, ${sp.output.toLocaleString()} out (this provider's prices aren't known)`
      : "Nothing spent yet";
  $("saveNotesBtn").disabled = !!state.savingNotes;
  $("saveNotesMeta").textContent = state.savingNotes ? "Writing your notes…" : "Summary, decisions, action items and full transcript, to Documents/Glance";
  const n = state.transcriptCount || 0;
  $("transcriptMeta").textContent = n ? `${n.toLocaleString()} line${n === 1 ? "" : "s"} so far` : "What Glance has heard so far";
  $("instructionsMeta").textContent = state.customInstructions?.trim() ? "on" : "none";
  $("instructionsResumeWarn").hidden = !looksLikeResume(state.customInstructions);
  $("resumeMeta").textContent = docMeta(state.resume);
  const filled = [state.profileName, state.salary, state.visa, state.notice].filter((v) => v?.trim()).length;
  $("profileMeta").textContent = filled ? `${filled} of 4` : "not added";
  $("jobMeta").textContent = docMeta(state.jobDescription);
  const providerLabel = (state.providers || []).find((p) => p.id === state.provider)?.label || "Anthropic";
  $("keyMeta").textContent = state.keyHint ? `${providerLabel}, key ends in ${state.keyHint}` : state.hasKey ? providerLabel : `${providerLabel}, no key yet`;
  $("autoScreenToggle").setAttribute("aria-checked", String(!!state.autoScreen));
  for (const b of $("transcription").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === state.transcription));
  if (document.activeElement !== $("vocabularyInput")) $("vocabularyInput").value = state.vocabulary || "";
  for (const b of $("style").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === meetingStyle()));
}

function renderShortcutHints() {
  const k = state.shortcuts;
  if (!k) return;
  // In call order: listen, answer, then the rest.
  $("guide").innerHTML = [
    ["listen", "Start or stop listening to your call"],
    ["ask", "Answer the question just heard, or what you've typed"],
    ["snap", "Screenshot your screen and get an answer"],
    ["toggleWindow", "Show or hide Glance"],
  ]
    .map(([a, label]) => `<li><span class="keys">${keycaps(k[a])}</span><span>${label}</span></li>`)
    .join("");
  $("hints").innerHTML = [["listen", "Listen"], ["ask", "Answer"], ["snap", "Screenshot"]]
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
  for (const b of document.querySelectorAll("[data-back]")) b.hidden = !backToSettings;
  // Setup covers everything; its key step uses the key form itself.
  const onb = !!onboarding && onboarding.step !== "key";
  $("onboard").hidden = !onb;
  // During setup only the logo and minimise stay in the top bar.
  document.body.classList.toggle("onboarding", !!onboarding);
  if (onb) renderOnboarding();
  $("keyStepLabel").hidden = onboarding?.step !== "key";
  $("keyStepBack").hidden = onboarding?.step !== "key";
  if (onboarding?.step === "key") $("keyStepLabel").textContent = stepLabel(onboardingSteps(onboarding), "key");
  // No key yet: the key form is the main view, but Settings and its forms
  // still open over it (and close back to it).
  const needsKey = (panel === "key" || (!state.hasKey && !panel)) && !onb;
  // Listening and screenshots wait for a key, like answers.
  document.body.classList.toggle("needs-key", !state.hasKey && !onb);
  $("keyForm").hidden = !needsKey;
  const changing = needsKey && state.hasKey;
  if (needsKey) renderKeyForm(changing);
  // Cancel whenever the form was opened from Settings; Remove only with a key.
  $("keyManage").hidden = panel !== "key";
  $("cancelKeyBtn").hidden = panel !== "key";
  $("removeKeyBtn").hidden = !state.keyHint;
  const shortcutsOpen = !needsKey && panel === "shortcuts";
  $("shortcutsPanel").hidden = !shortcutsOpen;
  if (shortcutsOpen) renderShortcutList();
  const settings = !needsKey && !onb && panel === "settings";
  $("menu").hidden = !settings;
  $("menuBtn").setAttribute("aria-expanded", String(settings));
  $("menuBtn").title = settings ? "Close settings" : "Settings";
  document.body.classList.toggle("settings-open", settings);
  const instr = !needsKey && panel === "instructions";
  $("instructionsForm").hidden = !instr;
  if (instr) updateInstructionsCount();
  const doc = !needsKey && panel === "doc";
  $("docForm").hidden = !doc;
  if (doc) updateDocCount();
  const prof = !needsKey && !onb && panel === "profile";
  $("profileForm").hidden = !prof;
  const wipe = !needsKey && !onb && panel === "wipe";
  $("wipeForm").hidden = !wipe;
  const covered = needsKey || onb || instr || doc || prof || wipe || settings || shortcutsOpen;
  $("jdCard").hidden = !askingJob || covered;
  $("jdCloak").hidden = !!state.invisible;
  // No job description saved yet: there's no "same role" to keep.
  // The résumé comes first: without it, interview answers can't sound like you.
  const hasJob = !!state.jobDescription?.trim();
  const needResume = !state.resume?.trim();
  $("jdText").textContent = needResume
    ? "Add your resume so interview answers sound like you."
    : hasJob
      ? "New interview? Keep the same role, or add its job description."
      : "Interviewing for a specific role? Add its job description so answers fit it.";
  $("jdSame").textContent = hasJob && !needResume ? "Same role" : "Not now";
  $("jdNew").textContent = needResume ? "Add resume" : hasJob ? "New job description" : "Add job description";
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
    const { text: body, keys } = splitKeys(a.text, { streaming: a.status === "streaming" });
    const compact = keys.length > 0 && answerView === "compact";
    const first = body.split("\n").find((l) => l.trim()) || "";
    // The note (details Glance added, to check) shows in both views.
    const note = body.trim().split("\n").at(-1);
    const noteMd = /^\*[^*].*\*$/.test(note?.trim() || "") && note !== first ? renderMarkdown(note) : "";
    $("answerBody").innerHTML =
      (compact ? `${renderMarkdown(first)}<ul class="keys">${keys.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul>${noteMd}` : renderMarkdown(body)) +
      (a.error ? `<p class="err">${escapeHtml(a.error)}</p>` : "") +
      (a.stopped ? `<p class="stopped">Stopped before the end.</p>` : "");
    $("viewToggle").hidden = !keys.length;
    $("viewToggle").textContent = compact ? "Full answer" : "Key points";
    $("viewToggle").title = compact ? "Show the whole answer to say" : "Show only the key points";
    // Interview answers only: what the user actually said goes with later questions.
    const saidable = a.status === "done" && !a.error && state.style === "interview";
    $("saidBox").hidden = !saidable && !a.said;
    $("saidOpen").hidden = editingSaid;
    $("saidOpen").textContent = a.said ? "Edit what you said" : "I said something else";
    $("saidText").hidden = !a.said || editingSaid;
    if (a.said) $("saidText").innerHTML = `You said: <strong>${escapeHtml(a.said)}</strong>. Follow-ups build on this.`;
    $("saidForm").hidden = !editingSaid;
    $("answerUsage").hidden = !a.usage;
    if (a.usage) $("answerUsage").textContent = `${a.usage.cost != null ? `About ${formatDollars(a.usage.cost)} with` : "With"} ${a.usage.model || "the model"} (${a.usage.input.toLocaleString()} tokens in, ${a.usage.output.toLocaleString()} out)`;
  }

  document.querySelector(".dock").hidden = needsKey || onb || instr || doc || prof || wipe || settings || shortcutsOpen;

  const showPager = view === "answers" && answers.length > 1 && !covered;
  $("pager").hidden = !showPager;
  if (showPager) {
    $("pageLabel").textContent = `${page + 1} of ${answers.length}`;
    $("prevBtn").disabled = page <= 0;
    $("nextBtn").disabled = page >= answers.length - 1;
  }

  // Which mode answers are in, always visible: Interview answers as you.
  const interview = state.style === "interview";
  $("modePick").classList.toggle("interview", interview);
  $("modeLabel").textContent = interview ? "Interview" : "Meeting";
  $("modeBtn").title = `Answer mode: ${interview ? "Interview" : "Meeting"}. Click to change.`;
  $("modeMeetingHint").textContent = `${meetingStyle() === "natural" ? "Natural" : "Brief"} answers about the call and your screen`;
  for (const b of $("modeMenu").querySelectorAll("button")) b.setAttribute("aria-checked", String((b.dataset.value === "interview") === interview));

  renderAskBtn();
}

// Stop while an answer streams, unless something is typed: then it asks
// that instead (see submit).
function renderAskBtn() {
  const stop = !!state.busy && !$("question").value.trim();
  $("askBtn").classList.toggle("stop", stop);
  $("askBtn").textContent = stop ? "Stop" : "Ask";
  $("askBtn").title = stop ? "Stop this answer" : `Ask (${plainKeys(state.shortcuts?.ask || "")})`;
}
$("question").addEventListener("input", renderAskBtn);

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
  $("question").placeholder = shots.length ? `Ask about ${shots.length === 1 ? "this screenshot" : `these ${shots.length} screenshots`}, or press Ask` : "Type a question, or press Ask";
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
  // The view keeps the latest 1,000 lines; saved notes still get every line.
  const lines = $("transcript").querySelectorAll(".line");
  if (lines.length > 1000) lines[0].remove();
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
  // "audio-access": no sound since Listen; settings, then a reopen.
  const buttons = { "screen-settings": ["Open Screen Recording settings"], "audio-access": ["Open settings", "Reopen Glance"] }[action] || [];
  for (const label of buttons) {
    const b = document.createElement("button");
    b.className = "notice-action";
    b.textContent = label;
    b.addEventListener("click", () => (label === "Reopen Glance" ? g.relaunch() : g.openScreenSettings()));
    n.append(" ", b);
  }
  clearTimeout(showNotice.t);
  showNotice.t = setTimeout(() => (n.hidden = true), action ? 30000 : 8000);
}

function snapSubmit() {
  if (onboarding || state.busy) return;
  const q = $("question").value;
  $("question").value = "";
  view = "answers";
  g.snapAsk(q);
}

// Opening Settings replaces any other panel.
function setMenu(open) {
  if (open) panel = "settings";
  else if (panel === "settings") panel = null;
  backToSettings = false;
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

// Answer pressed while the other side is still finishing the question (or
// its last words are still being transcribed): wait for the rest, so half a
// question isn't sent. Pieces transcribe one at a time (about a second each),
// so a question split by two pauses can take 5 s to come in; the cap only
// matters if they keep talking.
const FINISH_WAIT_MS = 8000;
let waitingForQuestion = false;
let waitTakenOver = false; // a typed question replaced the one being waited for
let stillHearing = () => g.stillHearing(); // replaced in the UI tests

// form: from the question box (Return, or the Ask/Stop button). Otherwise
// ⌘↵ or the Answer button.
async function submit({ form = false } = {}) {
  if (onboarding) return; // shortcuts wait until setup is done
  const typed = $("question").value.trim();
  // Waiting for a heard question to finish: only a typed question takes over.
  if (waitingForQuestion) {
    if (!typed) return;
    waitTakenOver = true;
  }
  if (state.busy && !typed) {
    // ⌘↵ while auto-answer is already answering is asking for that same
    // answer, so it keeps going; the Stop button still stops it.
    const last = answers.at(-1);
    if (!form && last?.auto && last.status === "streaming") return;
    return g.cancel();
  }
  // Typed while an answer streams: send it now (the current answer stops and stays).
  autoAnswerPending = false;
  lastAutoQuestion = null;
  $("question").value = "";
  if (!typed && state.listening && pendingQuestion && (await stillHearing())) {
    waitingForQuestion = true;
    renderStrip();
    const end = Date.now() + FINISH_WAIT_MS;
    while (Date.now() < end && !waitTakenOver && (await stillHearing())) await new Promise((r) => setTimeout(r, 150));
    waitingForQuestion = false;
    if (waitTakenOver) return void (waitTakenOver = false);
  }
  // Nothing typed but a question was just heard: answer exactly that one. It
  // came from the call, so the screen isn't attached unless it refers to it.
  const heard = !typed && state.listening && pendingQuestion?.text;
  view = "answers";
  g.ask(typed || heard || "", { heard: !!heard && !mentionsScreen(heard) });
}

// Auto-answer (Interview mode, listening, Settings > Interview): once a
// question is pending and the other side has gone quiet for QUIET_MS (speech
// over and transcribed), answer it as if Answer were pressed. It never
// interrupts an answer you asked for or a question you're typing, and skips
// while a form is open. Each question is answered once; earlier answers stay.
const QUIET_MS = 300;
let autoTimer = null;
let autoAnswerId = null; // the answer auto-answer started, while it streams
// The question auto-answer last answered ({ text, at }): if they pause longer
// than expected and then carry on, the whole question is answered again.
let lastAutoQuestion = null;
// No key: the listen shortcut still works, but asking would only show an error.
const autoAnswerOn = () => !!state.autoAnswer && state.style === "interview" && !!state.listening && !!state.hasKey && !onboarding;
function watchForQuestion() {
  if (autoTimer || !autoAnswerOn() || !pendingQuestion) return;
  let quietSince = null;
  autoTimer = setInterval(async () => {
    const own = state.busy && autoAnswerId !== answers.at(-1)?.id; // you asked for the one streaming
    if (!autoAnswerOn() || !pendingQuestion || waitingForQuestion) return stopWatching();
    if (own || $("question").value.trim() || panelOpen() || panel === "settings") return; // keep watching
    if (await stillHearing()) return void (quietSince = null);
    quietSince ??= Date.now();
    if (Date.now() - quietSince < QUIET_MS) return;
    stopWatching();
    const text = pendingQuestion.text;
    lastAutoQuestion = { ...pendingQuestion };
    view = "answers";
    autoAnswerPending = true;
    g.ask(text, { heard: !mentionsScreen(text) });
  }, 100);
}
function stopWatching() {
  clearInterval(autoTimer);
  autoTimer = null;
}
let autoAnswerPending = false; // the next answer-start is auto-answer's

let wasListening = false; // as last reported by the app (the UI tests fake state.listening)
g.on("state", (s) => {
  const before = state;
  state = s;
  // The key step finishes itself once a working key is saved.
  if (onboarding?.step === "key" && state.hasKey) onboarding.step = nextStep(1);
  // Start of an interview: Listen pressed, or Interview mode switched on.
  if ((state.listening && !before.listening) || (state.style === "interview" && before.style && before.style !== "interview")) maybeAskJob();
  if (state.style !== "interview") askingJob = false;
  // Listening stopped: a question left unanswered belongs to that stretch of
  // the call, so it's neither shown nor auto-answered when Listen starts again.
  if (wasListening && !s.listening) {
    pendingQuestion = null;
    lastAutoQuestion = null;
    stopWatching();
  }
  wasListening = !!s.listening;
  render();
});
g.on("notice", showNotice);
// A line heard from the call (named so the UI tests can feed lines in).
function onTranscript(l) {
  heard.push(l);
  state.transcriptCount = (state.transcriptCount || 0) + 1;
  pendingQuestion = nextPendingQuestion(pendingQuestion, l, heard.slice(0, -1));
  // Carries on a question auto-answer already started on: ask the whole thing.
  if (lastAutoQuestion && l.role === "them") {
    // Same rule as nextPendingQuestion: carrying on beats a new question.
    if (l.start - lastAutoQuestion.at < CONTINUE_MS) pendingQuestion = nextPendingQuestion(lastAutoQuestion, l);
    lastAutoQuestion = null;
  }
  renderStrip();
  renderTranscriptLine(l);
  watchForQuestion();
}
g.on("transcript", onTranscript);
g.on("focus-input", () => $("question").focus());
g.on("submit", submit);
g.on("snap-submit", snapSubmit);

g.on("answer-start", ({ id, question }) => {
  answers.push({ id, question, text: "", status: "streaming", auto: autoAnswerPending });
  autoAnswerId = autoAnswerPending ? id : null;
  autoAnswerPending = false;
  answerView = state.compactAnswers ? "compact" : "full";
  editingSaid = false;
  page = answers.length - 1;
  if (view === "transcript") backToSettings = false;
  view = "answers";
  if (panel === "settings") panel = null;
  pendingQuestion = null;
  setCollapsed(false);
  // Asked by shortcut while a form is open: keep what's typed there, but say
  // where the answer is.
  if (panel) {
    showNotice({ level: "ok", text: "Answering behind this form. Close it to see the answer." });
  }
  renderStrip();
  try {
    localStorage.setItem("glance.seenAnswer", "1");
  } catch {}
  renderStage();
  $("stage").scrollTop = 0;
});
g.on("answer-delta", ({ id, text }) => {
  const a = answers.find((x) => x.id === id);
  if (!a) return;
  a.text += text;
  // The answer grows below while you read it from the top; no scrolling.
  if (answers[page] === a) renderStage();
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
    a.stopped = !!aborted; // cut short: Stop, a new question, or a typed one
  }
  renderStage();
});

$("askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  submit({ form: true });
});
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url || "";
  }
};
// The provider setup screen. Base URL and model fields are filled once each
// time the form opens or the provider changes, so typing isn't overwritten.
let keyFormFor = null;
function renderKeyForm(changing) {
  const openai = state.provider === "openai";
  for (const b of $("keyProvider").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === state.provider));
  $("openaiFields").hidden = !openai;
  if (keyFormFor !== state.provider) {
    keyFormFor = state.provider;
    $("keyBaseUrl").value = state.openaiBaseUrl || "";
    $("keyModel").value = state.openaiModel || "";
  }
  $("keyLead").textContent = changing
    ? `Change who answers${state.keyHint ? ` (current key ends in ${state.keyHint})` : ""}.`
    : "Choose who answers, then add an API key.";
  $("keyHint").textContent = openai
    ? "Works with any OpenAI-compatible API: OpenAI, Google Gemini, OpenRouter, Groq, Mistral, or a local Ollama or LM Studio (no key needed on localhost). Saved in your macOS keychain."
    : "Create one at console.anthropic.com. It's saved in your macOS keychain.";
  $("keyInput").placeholder = openai ? (state.keyOptional ? "API key (optional for this local server)" : "API key") : "sk-ant-…";
}
$("keyProvider").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (v && v !== state.provider) g.setSetting("provider", v);
});
$("keyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("keyInput").value.trim();
  if (state.provider === "openai") {
    const url = $("keyBaseUrl").value.trim();
    const model = $("keyModel").value.trim();
    if (!model) return showNotice({ level: "error", text: "Enter the model name, for example gpt-4o, gemini-2.5-pro or llama3.1." });
    if (url !== state.openaiBaseUrl) g.setSetting("openaiBaseUrl", url);
    if (model !== state.openaiModel) g.setSetting("openaiModel", model);
  } else if (!key && !state.keyHint) return;
  if (key) g.setApiKey(key);
  closePanel();
});
$("cancelKeyBtn").addEventListener("click", closePanel);
// With no key left, the key form stays up until a new one is saved.
$("removeKeyBtn").addEventListener("click", () => {
  panel = null;
  backToSettings = false;
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
  setMenu(panel !== "settings");
});
$("saveNotesBtn").addEventListener("click", () => {
  setMenu(false);
  g.saveNotes();
});
$("shortcutsBtn").addEventListener("click", () => openPanel("shortcuts"));
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
  closePanel();
});
$("collapseBtn").addEventListener("click", () => setCollapsed(!collapsed));
$("hideTopBtn").addEventListener("click", () => g.hide());
$("copyBtn").addEventListener("click", () => {
  const a = answers[page];
  if (!a?.text) return;
  g.writeClipboard(splitKeys(a.text).text.trim());
  $("copyBtn").classList.add("done");
  setTimeout(() => $("copyBtn").classList.remove("done"), 1400);
});
$("viewToggle").addEventListener("click", () => {
  answerView = answerView === "compact" ? "full" : "compact";
  renderStage();
});
// Clicking the key phrases opens the full answer.
$("answerBody").addEventListener("click", (e) => {
  if (e.target.closest(".keys")) $("viewToggle").click();
});
$("saidOpen").addEventListener("click", () => {
  editingSaid = true;
  $("saidInput").value = answers[page]?.said || "";
  renderStage();
  $("saidInput").focus();
});
$("saidForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const a = answers[page];
  editingSaid = false;
  if (a) {
    a.said = $("saidInput").value.trim();
    g.setSaid(a.id, a.said);
  }
  renderStage();
});
$("model").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (v) g.setSetting("model", v);
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
// In Interview mode this picks the style for later; Interview stays on.
$("style").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (!v) return;
  if (state.style !== "interview") return g.setSetting("style", v);
  try {
    localStorage.setItem("glance.styleBeforeInterview", v);
  } catch {}
  render();
});
$("cloakBtn").addEventListener("click", () => g.setSetting("invisible", !state.invisible));
$("cloakToggle").addEventListener("click", () => g.setSetting("invisible", !state.invisible));
$("autoAnswerToggle").addEventListener("click", () => g.setSetting("autoAnswer", !state.autoAnswer));
$("compactToggle").addEventListener("click", () => {
  answerView = state.compactAnswers ? "full" : "compact"; // the answer on screen follows
  g.setSetting("compactAnswers", !state.compactAnswers);
});
$("autoScreenToggle").addEventListener("click", () => g.setSetting("autoScreen", !state.autoScreen));
// Click: screenshot and answer. Shift-click: add to the tray without asking yet.
$("shotBtn").addEventListener("click", (e) => (e.shiftKey ? g.addShot() : snapSubmit()));
$("shots").addEventListener("click", (e) => {
  const id = Number(e.target.closest(".remove")?.dataset.id);
  if (id) g.removeShot(id);
});
$("transcriptToggle").addEventListener("click", () => {
  backToSettings = panel === "settings";
  panel = null;
  view = "transcript";
  render();
  $("stage").scrollTop = 0;
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
  $("instructionsFormWarn").hidden = !looksLikeResume(text);
  // Show exactly what's sent with each question, while it matches what's saved.
  const sent = state.sentInstructions;
  const unchanged = text === state.customInstructions;
  $("sentBox").hidden = !(sent && unchanged);
  if (sent && unchanged) {
    $("sentSummary").textContent = `What Glance sends with each question: about ${approxTokens(sent)} tokens`;
    $("sentText").textContent = sent;
  }
  const max = state.maxInstructions || 12000;
  $("instructionsInput").maxLength = max;
  $("instructionsCount").textContent = `${text.length.toLocaleString()} of ${max.toLocaleString()} characters, about ${approxTokens(text)} tokens before compression`;
}
// Resume and job description share one form. Both are sent word for word.
const DOCS = {
  resume: {
    lead: "Resume",
    hint: "Used whenever a question is about you, in any style. Sent word for word and never compressed, so answers can use your own phrasing. Import a PDF, Word, RTF or text file, or paste it. Check the text after importing: PDFs can lose bullets or join lines.",
    placeholder: "Paste your resume, or press Import file…",
  },
  jobDescription: {
    lead: "Job description",
    hint: "The role you're interviewing for, used for questions about the role. Sent word for word. Answers match your experience to its requirements and use the company's name. Import a file or paste the posting.",
    placeholder: "Paste the job posting, or press Import file…",
  },
};
function docMeta(text) {
  const words = text?.trim() ? text.trim().split(/\s+/).length : 0;
  return words ? `${words.toLocaleString()} words` : "not added";
}
function updateDocCount() {
  const text = $("docInput").value;
  const max = state.maxDoc || 20000;
  $("docInput").maxLength = max;
  $("docCount").textContent = `${text.length.toLocaleString()} of ${max.toLocaleString()} characters, about ${approxTokens(text)} tokens`;
}
function openDoc(kind) {
  docKind = kind;
  const d = DOCS[kind];
  $("docLead").textContent = d.lead;
  $("docHint").textContent = d.hint;
  $("docInput").placeholder = d.placeholder;
  $("docInput").value = state[kind] || "";
  openPanel("doc");
  // Start at the top (the name and summary), not the end.
  $("docInput").focus();
  $("docInput").setSelectionRange(0, 0);
  $("docInput").scrollTop = 0;
}
const closeDoc = () => closePanel();
$("resumeBtn").addEventListener("click", () => openDoc("resume"));
$("jobBtn").addEventListener("click", () => openDoc("jobDescription"));
$("docInput").addEventListener("input", updateDocCount);
$("docImport").addEventListener("click", async () => {
  const kind = docKind;
  const r = await g.importDoc(kind);
  if (!r || panel !== "doc" || docKind !== kind) return;
  if (r.error) return showNotice({ level: "error", text: r.error });
  $("docInput").value = r.text;
  updateDocCount();
  const check = r.pdf ? "PDF text can lose bullets or join lines, so check it against your PDF, then press Save." : "Check it, then press Save.";
  showNotice({ level: r.truncated || r.pdf ? "warn" : "ok", text: `Imported ${r.name}${r.truncated ? ", cut to the 20,000-character limit" : ""}. ${check}` });
});
$("docForm").addEventListener("submit", (e) => {
  e.preventDefault();
  g.setSetting(docKind, $("docInput").value);
  closeDoc();
});
$("docCancel").addEventListener("click", closeDoc);
$("docClear").addEventListener("click", () => {
  $("docInput").value = "";
  updateDocCount();
  $("docInput").focus();
});

const closeInstructions = () => closePanel();
// Opens a panel over the answers; one opened from Settings returns there.
function openPanel(name) {
  backToSettings = panel === "settings";
  panel = name;
  render();
  $("stage").scrollTop = 0;
}
// Closes whichever panel is open, as Save, Back, Cancel and Esc do: back to
// Settings if it came from there, otherwise to the answers.
function closePanel() {
  if (panel === "shortcuts") stopRecording();
  if (panel === "key") {
    keyFormFor = null;
    $("keyInput").value = "";
  }
  if (view === "transcript") view = "answers";
  panel = backToSettings ? "settings" : null;
  backToSettings = false;
  render();
  $("stage").scrollTop = 0;
}
const panelOpen = () => (!!panel && panel !== "settings") || view === "transcript";
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-back]")) closePanel();
});
$("instructionsBtn").addEventListener("click", () => {
  $("instructionsInput").value = state.customInstructions || "";
  openPanel("instructions");
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
$("openaiModelRow").addEventListener("click", () => $("keyBtn").click());
$("keyBtn").addEventListener("click", () => {
  keyFormFor = null;
  openPanel("key");
  $("keyInput").focus();
});
$("quitBtn").addEventListener("click", () => g.quit());
$("settingsTabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (!tab) return;
  settingsTab = tab;
  try {
    localStorage.setItem("glance.settingsTab", tab);
  } catch {}
  render();
  $("stage").scrollTop = 0;
});
// Interview mode is Style > Interview, switched from Settings > Interview or the
// main screen; turning it off goes back to the style used before.
function toggleInterview() {
  if (state.style === "interview") {
    let previous = "brief";
    try {
      previous = localStorage.getItem("glance.styleBeforeInterview") || "brief";
    } catch {}
    g.setSetting("style", previous);
  } else {
    try {
      localStorage.setItem("glance.styleBeforeInterview", state.style);
    } catch {}
    g.setSetting("style", "interview");
  }
}
$("interviewToggle").addEventListener("click", toggleInterview);
function setModeMenu(open) {
  $("modeMenu").hidden = !open;
  $("modeBtn").setAttribute("aria-expanded", String(open));
}
$("modeBtn").addEventListener("click", () => setModeMenu($("modeMenu").hidden));
$("modeMenu").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (!v) return;
  setModeMenu(false);
  if ((v === "interview") !== (state.style === "interview")) toggleInterview();
});
document.addEventListener("click", (e) => {
  if (!$("modeMenu").hidden && !e.target.closest("#modePick")) setModeMenu(false);
});
$("cloakFix").addEventListener("click", () => g.setSetting("invisible", true));
$("jdCloakFix").addEventListener("click", () => g.setSetting("invisible", true));
$("prevBtn").addEventListener("click", () => {
  editingSaid = false;
  page = Math.max(0, page - 1);
  renderStage();
});
$("nextBtn").addEventListener("click", () => {
  editingSaid = false;
  page = Math.min(answers.length - 1, page + 1);
  renderStage();
});
// Glance is a non-activating panel, so macOS sends ⌘C/⌘V/⌘X/⌘A/⌘Z to the
// frontmost app's menu instead of ours. Handle them here.
async function pasteInto(input) {
  const raw = await g.readClipboard();
  let text = input instanceof HTMLTextAreaElement ? raw.replace(/\r\n/g, "\n") : raw.replace(/\r?\n/g, " ").trim();
  if (!text) return;
  // Programmatic edits ignore maxlength, so enforce it here and say what was cut.
  if (input.maxLength > 0) {
    const room = input.maxLength - (input.value.length - (input.selectionEnd - input.selectionStart));
    if (text.length > room) {
      showNotice({ level: "warn", text: `Only the first ${Math.max(0, room).toLocaleString()} characters were pasted. The limit is ${input.maxLength.toLocaleString()}.` });
      text = text.slice(0, Math.max(0, room));
    }
  }
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
    if (onboarding) return; // setup has its own Back and Skip setup
    if (!$("modeMenu").hidden) return setModeMenu(false);
    if (editingSaid) {
      editingSaid = false;
      return renderStage();
    }
    if (panelOpen()) closePanel();
    else if (panel === "settings") setMenu(false);
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

// Welcome and setup: welcome, then (only if needed) the key, about you, the
// job description for interviews, and a ready screen. Shown on first launch
// and from Settings > General > Show welcome again.
function startOnboarding() {
  g.setSetting("setupActive", true);
  panel = null;
  backToSettings = false;
  onboarding = {
    step: "welcome",
    needsKey: !state.hasKey,
    use: state.style === "interview" ? "interviews" : state.resume?.trim() ? "both" : "interviews",
  };
  // Prefill with what's already saved.
  $("obResume").value = state.resume || "";
  $("obJob").value = state.jobDescription || "";
  $("obName").value = state.profileName || "";
  $("obSalary").value = state.salary || "";
  $("obVisa").value = state.visa || "";
  $("obNotice").value = state.notice || "";
  // Hiding defaults on during setup for interviews; the ready step can undo it.
  onboarding.hide = state.invisible || onboarding.use !== "meetings";
}
function nextStep(dir) {
  const steps = onboardingSteps(onboarding);
  let i = steps.indexOf(onboarding.step) + dir;
  // A key saved meanwhile: going back skips the key step.
  if (steps[i] === "key" && state.hasKey) i += dir;
  return steps[Math.max(0, Math.min(steps.length - 1, i))];
}
function renderOnboarding() {
  const { step } = onboarding;
  const steps = onboardingSteps(onboarding);
  for (const el of document.querySelectorAll("#onboard .ob-step")) el.hidden = el.dataset.step !== step;
  $("onboardStepLabel").textContent = stepLabel(steps, step);
  $("onboardHead").hidden = step === "welcome";
  $("onboardSkip").hidden = step === "ready";
  $("obBack").hidden = step === "welcome";
  $("obNext").textContent = step === "welcome" ? "Get started" : step === "ready" ? "Start using Glance" : "Next";
  for (const b of $("obUse").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === onboarding.use));
  const words = $("obResume").value.trim() ? $("obResume").value.trim().split(/\s+/).length : 0;
  $("obResumeMeta").textContent = words ? `${words.toLocaleString()} words` : "";
  // Interview answers are built from the resume, so interviews need one;
  // meetings don't. Skip setup still leaves without it.
  const needResume = step === "about" && resumeRequired();
  $("obResumeNeed").textContent = onboarding.use === "meetings" ? "(optional)" : "(required for interviews)";
  $("obAboutHint").textContent = onboarding.use === "meetings"
    ? "So answers about you are accurate. All optional; change it later in Settings > Interview."
    : "Interview answers are built from your resume, so add it to continue. The rest is optional; change any of it later in Settings > Interview.";
  $("obNext").disabled = needResume && !words;
  $("obNext").title = $("obNext").disabled ? "Add your resume to continue" : "";
  $("obCloak").setAttribute("aria-checked", String(!!onboarding.hide));
  $("obListenKey").textContent = plainKeys(state.shortcuts?.listen || "");
  $("obAskKey").textContent = plainKeys(state.shortcuts?.ask || "");
}
const resumeRequired = () => onboarding?.use !== "meetings";
// Saves what the current step collected, then moves on.
function saveStep() {
  const { step } = onboarding;
  if (step === "about") {
    const resume = $("obResume").value;
    if (resume !== (state.resume || "")) g.setSetting("resume", resume);
    for (const [id, name] of [["obName", "profileName"], ["obSalary", "salary"], ["obVisa", "visa"], ["obNotice", "notice"]]) {
      const v = $(id).value.trim();
      if (v !== (state[name] || "")) g.setSetting(name, v);
    }
    const style = onboarding.use === "meetings" ? meetingStyle() : "interview";
    if (style !== state.style) g.setSetting("style", style);
  } else if (step === "job") {
    const job = $("obJob").value;
    if (job !== (state.jobDescription || "")) g.setSetting("jobDescription", job);
    else if (job.trim()) g.setSetting("jdCheckedAt", Date.now()); // confirmed as is
  } else if (step === "ready") {
    if (!!onboarding.hide !== !!state.invisible) g.setSetting("invisible", !!onboarding.hide);
  }
}
function finishOnboarding() {
  g.setSetting("setupActive", false);
  g.setSetting("onboarded", true);
  onboarding = null;
  render();
  $("question").focus();
}
$("obNext").addEventListener("click", () => {
  if (onboarding.step === "about" && resumeRequired() && !$("obResume").value.trim()) return $("obResume").focus();
  saveStep();
  if (onboarding.step === "ready") return finishOnboarding();
  onboarding.step = nextStep(1);
  render();
  $("stage").scrollTop = 0;
  if (onboarding.step === "key") $("keyInput").focus();
});
$("obBack").addEventListener("click", () => {
  onboarding.step = nextStep(-1);
  render();
  $("stage").scrollTop = 0;
});
$("onboardSkip").addEventListener("click", finishOnboarding);
$("keyStepBack").addEventListener("click", () => {
  onboarding.step = "welcome";
  render();
});
$("obUse").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (!v) return;
  onboarding.use = v;
  onboarding.hide = state.invisible || v !== "meetings";
  render();
});
$("obResume").addEventListener("input", () => renderOnboarding());
$("obCloak").addEventListener("click", () => {
  onboarding.hide = !onboarding.hide;
  render();
});
for (const [button, field, kind] of [["obResumeImport", "obResume", "resume"], ["obJobImport", "obJob", "jobDescription"]]) {
  $(button).addEventListener("click", async () => {
    const r = await g.importDoc(kind);
    if (!r || !onboarding) return;
    if (r.error) return showNotice({ level: "error", text: r.error });
    $(field).value = r.text;
    renderOnboarding();
    const check = r.pdf ? "PDF text can lose bullets or join lines, so check it." : "Check it, then press Next.";
    showNotice({ level: r.truncated || r.pdf ? "warn" : "ok", text: `Imported ${r.name}${r.truncated ? ", cut to the 20,000-character limit" : ""}. ${check}` });
  });
}
$("welcomeAgainBtn").addEventListener("click", () => {
  startOnboarding();
  render();
  $("stage").scrollTop = 0;
});

// "New interview?" at the start of each interview (see shouldAskJob).
function maybeAskJob() {
  if (!onboarding && shouldAskJob({ style: state.style, jdCheckedAt: state.jdCheckedAt, now: Date.now() })) askingJob = true;
}
$("jdSame").addEventListener("click", () => {
  askingJob = false;
  g.setSetting("jdCheckedAt", Date.now());
  render();
});
$("jdNew").addEventListener("click", () => {
  askingJob = false;
  openDoc(state.resume?.trim() ? "jobDescription" : "resume"); // saving a job description confirms it for this interview
});

// Your details (Settings > Interview).
$("profileBtn").addEventListener("click", () => {
  $("pfName").value = state.profileName || "";
  $("pfSalary").value = state.salary || "";
  $("pfVisa").value = state.visa || "";
  $("pfNotice").value = state.notice || "";
  openPanel("profile");
  $("pfName").focus();
});
$("profileForm").addEventListener("submit", (e) => {
  e.preventDefault();
  for (const [id, name] of [["pfName", "profileName"], ["pfSalary", "salary"], ["pfVisa", "visa"], ["pfNotice", "notice"]]) {
    const v = $(id).value.trim();
    if (v !== (state[name] || "")) g.setSetting(name, v);
  }
  closePanel();
});
$("profileCancel").addEventListener("click", closePanel);

// Settings › General › Delete all Glance data (before uninstalling).
$("wipeBtn").addEventListener("click", () => {
  $("wipeNotes").checked = false;
  openPanel("wipe");
});
$("wipeCancel").addEventListener("click", closePanel);
$("wipeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  $("wipeConfirm").disabled = true;
  $("wipeConfirm").textContent = "Deleting…";
  g.deleteAllData({ notes: $("wipeNotes").checked });
});

g.getState().then((s) => {
  const { transcript, ...rest } = s;
  state = rest;
  heard = transcript;
  heard.forEach(renderTranscriptLine);
  if (!state.onboarded) startOnboarding();
  else maybeAskJob(); // opened in Interview mode: likely a new interview
  render();
  if (!onboarding) $("question").focus();
});

// Fade the top edge only once the content has scrolled under it.
$("stage").addEventListener("scroll", () => $("stage").classList.toggle("scrolled", $("stage").scrollTop > 4));

// One click (or ⌘↵) answers the detected question; the model already treats the
// latest question in the transcript as the thing to answer.
$("caption").addEventListener("click", (e) => {
  if (e.target.closest("#answerQBtn")) submit();
});

