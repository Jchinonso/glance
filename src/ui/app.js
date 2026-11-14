const $ = (id) => document.getElementById(id);
const g = window.glance;
// Wrapped so the UI tests can replace them without touching the bridge.
let listModels = (params) => g.listModels(params);
let testConnection = (params) => g.testConnection(params);

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
let recording = null; // action whose shortcut is being recorded
// Interview answers open in full, or as key points (Settings > Interview >
// Open answers as key points). The link on an answer switches just that view.
let answerView = "full";
let editingSaid = false; // the "I said something else" field is open
let questionTypedAt = 0; // when the question box was last edited

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
  cloak.title = state.invisible ? "Hidden from screen sharing and the Dock. Click to show it (⌘⇧H)." : "Visible in screen sharing and the Dock. Click to hide it (⌘⇧H).";
  const last = heard.at(-1);
  $("caption").hidden = !state.listening;
  if (pendingQuestion && state.listening) {
    $("caption").innerHTML = `<span class="qtag">Question</span><span class="qtext" title="${escapeHtml(pendingQuestion.text)}">${escapeHtml(pendingQuestion.text)}</span><button type="button" class="answer-q" id="answerQBtn" title="${waitingForQuestion ? "Waiting for them to finish the question" : "Answer this question (⌘↵)"}"${waitingForQuestion ? " disabled" : ""}>${waitingForQuestion ? "Waiting…" : "Answer"}</button>`;
  } else {
    $("caption").innerHTML = last ? line(last) : "Listening for speech…";
  }
}

let settingsModels = []; // what Settings' model dropdown lists (see makeCombo)
let settingsCombo = null;
// One model dropdown for both providers. The saved model is always shown,
// even before its list has loaded (or when it isn't in the list).
function renderSettingsModel() {
  const current = (state.provider === "openai" ? state.openaiModel : state.model) || "";
  // Anthropic before its list has loaded (no key yet, offline): the models
  // Glance knows, so there's still a choice.
  const fetched = state.modelOptions || [];
  const models = fetched.length || state.provider === "openai" ? fetched : (state.models || []).map((m) => ({ id: m.id, name: `Claude ${m.name}` }));
  settingsModels = models.filter((m) => m?.id);
  // The chosen model shows in the box unless it's being searched.
  if (document.activeElement !== $("settingsModel")) $("settingsModel").value = current;
  settingsCombo?.refresh();
  const hint = modelHint(current);
  $("modelHint").textContent = hint;
  $("modelHint").classList.toggle("caution", hint.endsWith("Choose a model."));
}

// What the Model row says under its name: the price for models Glance knows,
// otherwise where the list comes from and that only tokens are counted.
function modelHint(id) {
  const openai = state.provider === "openai";
  let host = openai ? state.openaiBaseUrl || "" : "Anthropic";
  try {
    if (openai) host = new URL(host).host;
  } catch {}
  // The saved model isn't on the provider's list (e.g. "gpt-5" saved for
  // api.openai.com, but the server is now OpenRouter): answers would fail.
  const listed = state.modelOptions || [];
  if (id && listed.length && !listed.some((m) => m.id === id)) return `${id} isn't listed by ${host || "your server"}. Choose a model.`;
  if (openai) return `From ${host || "your server"} · tokens counted, no prices`;
  const known = (state.models || []).find((m) => m.id === id);
  if (known) return `${known.name}: $${known.input} / $${known.output} per million tokens`;
  return "Listed by Anthropic · tokens counted, no prices";
}

function renderMenu() {
  for (const b of $("settingsTabs").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === settingsTab));
  for (const t of document.querySelectorAll("#menu .tab")) t.hidden = t.dataset.tab !== settingsTab;
  $("aboutVersion").textContent = `Version ${state.version} · ${state.arch === "arm64" ? "Apple Silicon" : "Intel"}`;
  renderAboutUpdate();
  $("styleHint").textContent = `${STYLE_HINTS[meetingStyle()]}${state.style === "interview" ? " Used when you switch back to Meeting." : ""}`;
  const interview = state.style === "interview";
  $("interviewToggle").setAttribute("aria-checked", String(interview));
  $("interviewOffNote").hidden = interview;
  $("cloakWarn").hidden = !!state.invisible;
  const openai = state.provider === "openai";
  $("effortRow").hidden = state.effortSupported === false; // Claude models without effort
  renderSettingsModel();
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
  $("keyMeta").textContent = state.keyFromEnv ? `${providerLabel}, key from ${state.keyFromEnv}` : state.keyHint ? `${providerLabel}, key ends in ${state.keyHint}` : state.hasKey ? providerLabel : `${providerLabel}, no key yet`;
  $("autoScreenToggle").setAttribute("aria-checked", String(!!state.autoScreen));
  for (const b of $("theme").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === state.theme));
  // One engine: Parakeet, on this Mac. Only the download and an engine
  // that won't start get a line here.
  const speech = state.speech || {};
  const pct = Math.floor((100 * (speech.received || 0)) / (speech.total || 1));
  const speechText =
    speech.status === "error" ? speech.error || "The speech model download failed."
    : speech.status === "downloading" ? `Downloading the speech model: ${pct}%`
    : speech.status === "checking" ? "Checking the speech model…"
    : speech.engine === "loading" ? "Loading the speech model…"
    : speech.engine === "failed" ? "The speech engine stopped. Quit and reopen Glance."
    : "";
  $("speechStatus").hidden = !speechText;
  $("speechStatus").classList.toggle("caution", speech.status === "error" || speech.engine === "failed");
  $("speechStatusText").textContent = speechText;
  $("speechRetry").hidden = speech.status !== "error";
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
  // The speech step finishes itself once the model is ready, but only if it
  // was shown while the download was still going. During first setup, move on
  // to the next step; someone who already finished setup came back only for
  // the model, so close it again (unless the resume is missing). Clearing the
  // flag means Back onto the step shows it as installed instead of bouncing.
  if (onboarding?.step === "speech" && state.speech?.status === "ready" && onboarding.sawSpeechDownloading) {
    onboarding.sawSpeechDownloading = false;
    if (state.onboarded && !resumeMissing()) finishOnboarding();
    else onboarding.step = nextStep(1);
  }
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
  if (!needsKey) {
    keyFormOpen = false;
    keyCombo?.close();
    keyModelToken++;
    clearTimeout(keyModelTimer);
  }
  const changing = needsKey && state.hasKey;
  if (needsKey) renderKeyForm(changing);
  // Cancel whenever the form was opened from Settings; Remove only with a key.
  $("keyManage").hidden = panel !== "key";
  $("cancelKeyBtn").hidden = panel !== "key";
  $("removeKeyBtn").hidden = !state.keyHint || !!state.keyFromEnv;
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
  $("jdSame").textContent = hasJob ? "Same role" : "Not now";
  $("jdSame").hidden = needResume; // the resume isn't optional for interviews
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
    $("answer").classList.toggle("deep", !!a.deep);
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
    // Think harder sits in the answer's header, so it's on screen without
    // scrolling, with its shortcut (the Answer shortcut) shown on the button.
    const askKeys = plainKeys(state.shortcuts?.ask || "");
    $("thinkHarder").hidden = !canThinkHarder(a);
    $("thinkHarderKeys").textContent = askKeys;
    $("thinkHarderKeys").hidden = !askKeys;
    $("thinkHarder").title = `This answer didn't stop to think. Answer the question again with more thinking${askKeys ? ` (${askKeys})` : ""}.`;
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
$("question").addEventListener("input", () => {
  questionTypedAt = Date.now();
  renderAskBtn();
});

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

// Opened while the speech model was being checked: set up the speech step if
// the check found it missing.
let speechCheckPending = false;

function render() {
  if (speechCheckPending && state.speech?.status !== "checking") {
    speechCheckPending = false;
    if (state.speech?.status !== "ready" && state.onboarded && !onboarding) startOnboarding("speech");
  }
  renderShortcutHints();
  renderUpdate();
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

// The update bar. Later hides it for that version until Glance reopens; it
// also stays out of the way during a call and during setup.
let updateDismissed = null;
// Updating restarts Glance, which clears the transcript and answers.
const updateSessionNote = () => ((state.transcriptCount || 0) > 0 || answers.length > 0 ? " Save notes first: updating restarts Glance and clears this session." : "");
const updateStatusText = (u) =>
  u.status === "downloading" ? `Downloading Glance ${u.version}: ${Math.floor(((u.received || 0) / (u.total || 1)) * 100)}%`
  : u.status === "installing" ? `Installing Glance ${u.version}. Glance will reopen in a moment.`
  : u.status === "error" ? u.error
  : `Glance ${u.version} is available.${updateSessionNote()}`;
function renderUpdate() {
  const u = state.update || { status: "none" };
  const active = u.status === "downloading" || u.status === "installing";
  $("updateBar").hidden = u.status === "none" || (!active && (updateDismissed === u.version || !!state.listening || !!onboarding));
  $("updateBox").classList.toggle("error", u.status === "error");
  $("updateText").textContent = updateStatusText(u);
  $("updateLater").hidden = active;
  $("updatePage").hidden = u.status !== "error";
  $("updateBtn").hidden = active;
  $("updateBtn").textContent = u.status === "error" ? "Try again" : "Update";
}
// Settings > About: the same update, reachable when the bar is hidden. With
// nothing to install the row checks instead; what the check said shows until
// the tab changes.
let updateCheckResult = null;
const UPDATE_CHECK_TEXT = {
  checking: "Checking…",
  available: "A newer version is ready.",
  latest: "You have the latest version.",
  failed: "Couldn't check right now. Try again in a while.",
  busy: "An update is already on its way.",
  off: "Update checks only run in the installed app.",
};
function renderAboutUpdate() {
  const u = state.update || { status: "none" };
  const ready = u.status === "available" || u.status === "error";
  const active = u.status === "downloading" || u.status === "installing";
  $("updateCheckBtn").disabled = active;
  $("updateCheckTitle").textContent = ready ? `Update to Glance ${u.version}` : active ? `Updating to Glance ${u.version}` : "Check for updates";
  $("updateCheckMeta").textContent =
    u.status === "error" ? `${u.error} Click to try again.`
    : ready ? `Downloads it, installs it and reopens Glance.${updateSessionNote()}`
    : active ? updateStatusText(u)
    : UPDATE_CHECK_TEXT[updateCheckResult] || "Glance also checks by itself when it opens and once a day.";
}
$("updateBtn").addEventListener("click", () => g.installUpdate());
$("updatePage").addEventListener("click", () => g.openUpdatePage());
$("updateLater").addEventListener("click", () => {
  updateDismissed = state.update?.version;
  renderUpdate();
});

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
  // ⌘↵ with nothing new to answer, right after a spoken question answered at
  // Quick: Think harder on it.
  if (!typed && !form && !state.busy && !(state.listening && pendingQuestion) && canThinkHarder(answers.at(-1))) return thinkHarder(answers.at(-1));
  // Typed while an answer streams: send it now (the current answer stops and stays).
  autoAnswerPending = false;
  lastAutoQuestion = null;
  turnCheckPending = false; // replaced by this ask
  $("question").value = "";
  // If Listen stops during the wait, the question waited for (with the last
  // words still being transcribed) is still the one asked.
  let waited = false;
  if (!typed && state.listening && pendingQuestion && (await stillHearing())) {
    waitingForQuestion = waited = true;
    renderStrip();
    const end = Date.now() + FINISH_WAIT_MS;
    while (Date.now() < end && !waitTakenOver && (await stillHearing())) await new Promise((r) => setTimeout(r, 150));
    waitingForQuestion = false;
    if (waitTakenOver) return void (waitTakenOver = false);
  }
  // Nothing typed but a question was just heard: answer exactly that one. It
  // came from the call, so the screen isn't attached unless it refers to it.
  const heard = !typed && (state.listening || waited) && pendingQuestion?.text;
  const heardAt = heard ? pendingQuestion.at : null;
  if (!state.listening) pendingQuestion = null; // Listen stopped during the wait
  view = "answers";
  const spoken = !!heard && !mentionsScreen(heard);
  g.ask(typed || heard || "", { heard: spoken, heardAt, hard: spoken && isHardQuestion(heard) });
}

// A finished answer to a spoken question that was answered at Quick (not
// hard, not already Think harder): it can be answered again with more thinking.
function canThinkHarder(a) {
  return !!a && a.quick && a.status === "done" && !a.error && !a.stopped && !!a.question;
}
// Asks the same question again with more thinking, as a new answer; the
// quick one stays.
let deepPending = false;
function thinkHarder(a) {
  autoAnswerPending = false;
  lastAutoQuestion = null;
  turnCheckPending = false;
  view = "answers";
  g.log?.(`think harder id=${a.id}`);
  deepPending = true; // the next answer-start is this one: it says "Thinking it through…" while empty
  g.ask(a.question, { heard: true, deep: true });
}

// Auto-answer (Interview mode, listening, Settings > Interview): once a
// question is pending and the other side has gone quiet (speech over and
// transcribed), answer it on the first 100 ms tick with no extra wait. It never
// interrupts an answer you asked for or a question you're typing: text in the
// question box holds it off for TYPING_HOLD_MS after the last edit. It skips
// while a panel is open (the transcript view doesn't count). Each question is
// answered once; earlier answers stay.
const QUIET_MS = 0;
const TYPING_HOLD_MS = 5000;
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
    const typing = $("question").value.trim() && Date.now() - questionTypedAt < TYPING_HOLD_MS;
    if (own || typing || panel) return; // keep watching
    if (await stillHearing()) return void (turnQuietSince = null);
    quietSince ??= Date.now();
    if (Date.now() - quietSince < QUIET_MS) return;
    stopWatching();
    const { text, at: heardAt } = pendingQuestion;
    const lastHeard = heard.at(-1);
    g.log?.(`auto-answer fired quietWaitMs=${lastHeard ? Date.now() - lastHeard.at : 0}`);
    lastAutoQuestion = { ...pendingQuestion };
    view = "answers";
    autoAnswerPending = true;
    turnCheckPending = false; // replaced by this ask
    const spoken = !mentionsScreen(text);
    g.ask(text, { heard: spoken, heardAt, hard: spoken && isHardQuestion(text) });
  }, 100);
}
function stopWatching() {
  clearInterval(autoTimer);
  autoTimer = null;
}
let autoAnswerPending = false; // the next answer-start is auto-answer's

// Auto-answer at the end of the interviewer's turn, for what the rules above
// don't recognise as a question ("My first question for you is, tell me about
// yourself", "I'd love to hear about…"). A turn is the other side's lines since
// the last answer started (or Listen started). Once they've gone quiet (same
// test and same holds as watchForQuestion) and the turn has TURN_MIN_WORDS, it
// goes to the model once as a gated ask: the model replies <none> when nothing
// was asked (greetings, intros, the format, small talk), and then nothing shows
// (main sends answer-skipped). A turn where the rules found a question is left
// to watchForQuestion. A line after the check starts a new turn; while the
// check is pending or its answer streams, the new turn carries the old one's
// lines, so its own turn-end asks about all of it and replaces that answer.
const TURN_MIN_WORDS = 5;
// Quiet before the model's check. Obvious questions are answered by the rules
// the moment they stop; this check is the fallback, so it waits out the short
// pauses between sentences instead of sending (and cancelling) one per breath.
const TURN_QUIET_MS = 800;
const TURN_MAX_CHARS = 600;
let turn = null; // { lines, ruled, checked }
let turnTimer = null;
let turnQuietSince = null; // when the current quiet began (reset by each new line)
let turnCheckPending = false; // a gated ask sent that hasn't started an answer or been skipped
let gatedTurnLines = []; // the lines that gated ask was about
function gatedInFlight() {
  const last = answers.at(-1);
  return turnCheckPending || (!!last?.gated && last.status === "streaming");
}
function noteTurn(l) {
  if (l.role !== "them") return;
  if (!turn || turn.checked) turn = { lines: gatedInFlight() ? [...gatedTurnLines] : [], ruled: false, checked: false };
  turn.lines.push(l);
  // Handled by the rules only while a detected question is still pending: if
  // that question was dropped without an answer (the talk moved on), the
  // turn's end gets the model's check like any other.
  turn.ruled = !!pendingQuestion;
  turnQuietSince = null; // they spoke: the quiet starts again
}
function turnText() {
  const text = turn.lines.reduce((all, l) => joinPieces(all, l.text.trim()), "");
  return text.length > TURN_MAX_CHARS ? text.slice(-TURN_MAX_CHARS).replace(/^\S*\s+/, "") : text;
}
const turnOpen = () => autoAnswerOn() && !!turn && !turn.checked && !turn.ruled && !pendingQuestion && !waitingForQuestion;
function watchTurn() {
  if (turnTimer || !turnOpen()) return;
  turnQuietSince = null;
  turnTimer = setInterval(async () => {
    if (!turnOpen()) return stopTurnWatch();
    const own = state.busy && autoAnswerId !== answers.at(-1)?.id;
    const typing = $("question").value.trim() && Date.now() - questionTypedAt < TYPING_HOLD_MS;
    if (own || typing || panel) return;
    if (await stillHearing()) return void (quietSince = null);
    if (!turnOpen()) return stopTurnWatch(); // changed during the await
    turnQuietSince ??= Date.now();
    if (Date.now() - turnQuietSince < TURN_QUIET_MS) return;
    stopTurnWatch();
    const text = turnText();
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < TURN_MIN_WORDS) return; // too little to check; a new line starts watching again
    turn.checked = true;
    turnCheckPending = true;
    gatedTurnLines = turn.lines;
    const heardAt = turn.lines.at(-1).at;
    g.log?.(`turn check sent words=${words} quietWaitMs=${Date.now() - heardAt}`);
    g.ask(text, { heard: true, heardAt, hard: isHardQuestion(text), gated: true });
  }, 100);
}
function stopTurnWatch() {
  clearInterval(turnTimer);
  turnTimer = null;
}

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
  // (Except the one an Answer press is still waiting on: see submit.)
  if (wasListening && !s.listening) {
    if (!waitingForQuestion) pendingQuestion = null;
    lastAutoQuestion = null;
    stopWatching();
    turn = null;
    turnCheckPending = false;
    gatedTurnLines = [];
    stopTurnWatch();
  }
  wasListening = !!s.listening;
  // Interview mode just lost its resume (switched on without one, or the
  // resume was cleared): setup opens at the resume step until one is added.
  const hadResumeOrOtherMode = before.style && (before.style !== "interview" || !!before.resume?.trim());
  const askResume = !onboarding && resumeMissing() && hadResumeOrOtherMode;
  if (askResume) startOnboarding("about");
  render();
  if (askResume) $("obResume").focus();
});
g.on("notice", showNotice);
// A line heard from the call (named so the UI tests can feed lines in).
// Lines a lead-in may look back over (it keeps at most MAX_LEAD_LINES).
const LEAD_LOOKBACK = 10;
function logQuestionChange(before, after, text) {
  let what = null;
  if (before && after) {
    if (after.text !== before.text) {
      const old = before.text.replace(/[.?!]$/, "");
      what = old && after.text.startsWith(old) ? "question extended" : "question replaced";
    }
  } else if (before) what = "question dropped";
  else if (after) what = "question detected";
  if (what) g.log?.(`${what} text="${text.slice(0, 80)}"`);
}
function onTranscript(l) {
  heard.push(l);
  state.transcriptCount = (state.transcriptCount || 0) + 1;
  // The last words before Listen stopped are transcribed after it stops; they
  // belong to that stretch of the call, so they never become a question to
  // show or auto-answer once Listen starts again, unless they finish the
  // question an Answer press is waiting on.
  if (state.listening || waitingForQuestion) {
    const before = pendingQuestion;
    pendingQuestion = nextPendingQuestion(pendingQuestion, l, heard.slice(-1 - LEAD_LOOKBACK, -1));
    // Carries on a question auto-answer already started on: ask the whole thing.
    if (lastAutoQuestion && l.role === "them") {
      // Same rule as nextPendingQuestion: carrying on beats a new question.
      if (l.start - lastAutoQuestion.at < CONTINUE_MS) pendingQuestion = nextPendingQuestion(lastAutoQuestion, l);
      lastAutoQuestion = null;
    }
    logQuestionChange(before, pendingQuestion, l.text);
    noteTurn(l);
  }
  renderStrip();
  renderTranscriptLine(l);
  watchForQuestion();
  watchTurn();
}
g.on("transcript", onTranscript);
g.on("focus-input", () => $("question").focus());
g.on("submit", submit);
g.on("snap-submit", snapSubmit);

// gated: a turn-end check that turned out to have something to answer.
g.on("answer-start", ({ id, question, gated }) => {
  const auto = autoAnswerPending || !!gated;
  answers.push({ id, question, text: "", status: "streaming", auto, gated: !!gated, deep: deepPending });
  deepPending = false;
  autoAnswerId = auto ? id : null;
  autoAnswerPending = false;
  if (gated) turnCheckPending = false;
  // A new turn starts here, except one already under way that carries this
  // check's lines (they carried on while it was being checked).
  if (!(gated && turn && !turn.checked)) {
    turn = null;
    stopTurnWatch();
  }
  answerView = state.compactAnswers ? "compact" : "full";
  editingSaid = false;
  page = answers.length - 1;
  if (view === "transcript") backToSettings = false;
  view = "answers";
  // An answer is starting: close Settings or any other panel so it shows. Blur
  // a focused field first so its change event saves what was typed.
  if (panel) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (panel === "shortcuts") stopRecording();
  }
  panel = null;
  backToSettings = false;
  pendingQuestion = null;
  setCollapsed(false);
  renderStrip();
  try {
    localStorage.setItem("glance.seenAnswer", "1");
  } catch {}
  renderStage();
  $("stage").scrollTop = 0;
});
// A turn-end check found nothing to answer: nothing shows or changes.
g.on("answer-skipped", () => {
  turnCheckPending = false;
});
g.on("answer-delta", ({ id, text }) => {
  const a = answers.find((x) => x.id === id);
  if (!a) return;
  a.text += text;
  // The answer grows below while you read it from the top; no scrolling.
  if (answers[page] === a) renderStage();
});
g.on("answer-end", ({ id, error, aborted, usage, quick }) => {
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
    a.quick = !!quick; // a spoken question answered at Quick (see canThinkHarder)
  }
  renderStage();
});

$("askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  submit({ form: true });
});
// The provider setup screen. Base URL and model fields are filled once each
// time the form opens or the provider changes, so typing isn't overwritten.
let keyFormFor = null;
let keyFormOpen = false;
// The provider form's model list, and its dropdown (see makeCombo).
let keyModels = [];
let keyCombo = null;
let keyModelToken = 0;
let keyModelTimer = null;
let testToken = 0;

function setModelStatus(kind, text) {
  const el = $("keyModelStatus");
  if (!kind) {
    el.hidden = true;
    el.className = "model-status";
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.className = `model-status ${kind}`;
  el.innerHTML = `${escapeHtml(text)}${kind === "error" ? ' <button type="button" class="textlink" id="keyModelRetry">Retry</button>' : ""}`;
}

// The address as the server sees it: a bare "api.openai.com" becomes
// https://api.openai.com/v1. What can't be an address stays as typed, so
// main reports it.
function keyBaseUrlValue() {
  const typed = $("keyBaseUrl").value.trim();
  return typed ? normalizeBaseUrl(typed) || typed : state.openaiBaseUrl || "";
}

function keyModelParams() {
  const openai = state.provider === "openai";
  return {
    provider: state.provider,
    baseUrl: openai ? keyBaseUrlValue() : "",
    key: $("keyInput").value.trim(),
  };
}

async function loadKeyModels({ delay = 0 } = {}) {
  clearTimeout(keyModelTimer);
  const run = async () => {
    if (!keyFormOpen) return;
    const params = keyModelParams();
    if (params.provider === "openai" && !params.baseUrl) return setModelStatus();
    // Anthropic lists models only for a key: wait for one instead of showing
    // a "key rejected" error before anything was typed.
    // Whether a key is saved (hasKey also needs a model, so it can't tell), and
    // whether the server is local (Ollama, LM Studio), which needs none.
    const keyless = !params.key && !state.keyHint;
    const local = params.provider === "openai" && LOCAL_URL.test(params.baseUrl);
    if (params.provider === "anthropic" && keyless) return setModelStatus("loading", "Paste your API key to load the models.");
    // A key still being typed would only come back rejected.
    if (params.provider === "anthropic" && params.key && !/^sk-ant-\S{30,}$/.test(params.key)) return setModelStatus("loading", "Paste your full API key to load the models.");
    const token = ++keyModelToken;
    setModelStatus("loading", "Loading models…");
    let result;
    try {
      result = await listModels(params);
    } catch (e) {
      result = { error: e?.message || String(e) };
    }
    if (token !== keyModelToken || !keyFormOpen) return;
    if (result?.error) {
      // No key yet: a server that needs one isn't an error worth red text.
      if (keyless && !local) return setModelStatus("loading", "Paste your API key to load the models.");
      return setModelStatus("error", inForm(result.error));
    }
    keyModels = Array.isArray(result) ? result : result?.models || [];
    keyCombo?.refresh();
    setModelStatus();
    matchModelToList(params);
  };
  if (delay) keyModelTimer = setTimeout(run, delay);
  else run();
}

// A searchable model dropdown, used by the provider form and Settings. The
// chevron opens every model; typing filters by ID or name. (A <datalist>
// filters by what's already in the box, so with "gpt-5" typed the rest of the
// list could never be reached.) The list opens in place, so the window grows
// to fit it instead of cutting it off.
//   models(): [{ id, name }]   current(): the chosen ID   pick(id): chosen
//   revertOnBlur: put the current model back if the box is left unpicked
const COMBO_MAX = 500; // OpenRouter lists about 380; more would only slow the list down
function makeCombo({ input, toggle, list, models, current, pick, revertOnBlur = false, emptyText }) {
  let open = false;
  let filter = "";
  let active = -1;
  let shown = [];
  const optId = (i) => `${list.id}Opt${i}`;
  const matches = () => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const all = models();
    const hits = terms.length ? all.filter((m) => terms.every((t) => m.id.toLowerCase().includes(t) || (m.name || "").toLowerCase().includes(t))) : all;
    return hits.slice(0, COMBO_MAX);
  };
  function render() {
    shown = matches();
    const cur = current();
    if (active >= shown.length) active = shown.length - 1;
    list.innerHTML = shown.length
      ? shown
          .map(
            (m, i) =>
              `<li role="option" id="${optId(i)}" data-i="${i}" aria-selected="${m.id === cur}"${i === active ? ' class="active"' : ""}><span class="combo-id">${escapeHtml(m.id)}</span>${m.name && m.name !== m.id ? `<span class="combo-name">${escapeHtml(m.name)}</span>` : ""}</li>`,
          )
          .join("")
      : `<li class="combo-empty">${models().length ? "No model matches. Press Enter to use what you typed." : emptyText || "No models listed yet. Type a model ID."}</li>`;
    if (active >= 0) input.setAttribute("aria-activedescendant", optId(active));
    else input.removeAttribute("aria-activedescendant");
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }
  function show({ showAll = false } = {}) {
    filter = showAll ? "" : input.value.trim();
    open = true;
    active = showAll ? matches().findIndex((m) => m.id === current()) : -1;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    render();
    // Opened on the chosen model: show it, not the top of a long list.
    if (active >= 0) list.querySelector(".active")?.scrollIntoView({ block: "center" });
  }
  function close({ revert = revertOnBlur } = {}) {
    if (!open && !revert) return;
    open = false;
    active = -1;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (revert) input.value = current();
  }
  function choose(id) {
    input.value = id;
    close({ revert: false });
    pick(id);
  }
  toggle.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the box
  toggle.addEventListener("click", () => {
    if (open) return close();
    input.focus();
    if (revertOnBlur) input.select();
    show({ showAll: true });
  });
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) choose(shown[Number(li.dataset.i)].id);
  });
  input.addEventListener("input", () => {
    filter = input.value.trim();
    active = -1;
    if (!open) show();
    else render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show({ showAll: !filter });
      const n = shown.length;
      if (!n) return;
      active = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
      render();
    } else if (e.key === "Enter" && open) {
      // The highlighted model; with none highlighted, what was typed.
      e.preventDefault();
      if (active >= 0) choose(shown[active].id);
      else if (input.value.trim()) choose(input.value.trim());
      else close();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener("blur", () => close());
  return { close: () => close({ revert: false }), refresh: () => open && render(), isOpen: () => open };
}

keyCombo = makeCombo({
  input: $("keyModel"),
  toggle: $("keyModelToggle"),
  list: $("keyModelList"),
  models: () => keyModels,
  current: () => $("keyModel").value.trim(),
  pick: () => {
    keyModelTyped = true; // chosen by the user: a later list load leaves it alone
    resetTestStatus();
  },
});

// After a server's list loads, the model filled in from settings may not be
// on it: "gpt-5" saved for api.openai.com is "openai/gpt-5" on OpenRouter.
// One listed model with that name under a prefix: switch to it and say so.
// None: clear the box so a model is chosen from the list. A model the user
// typed themselves is left alone.
let keyModelTyped = false;
function matchModelToList(params) {
  const box = $("keyModel");
  const v = box.value.trim();
  if (keyModelTyped || !v || !keyModels.length || keyModels.some((m) => m.id === v)) return;
  const host = hostOf(params.baseUrl) || (params.provider === "anthropic" ? "Anthropic" : "this server");
  // Both ways: "gpt-5" -> "openai/gpt-5" (OpenRouter), "openai/gpt-5" -> "gpt-5" (OpenAI).
  const bare = v.includes("/") ? v.slice(v.lastIndexOf("/") + 1) : null;
  const same = keyModels.filter((m) => m.id.endsWith(`/${v}`) || (bare && (m.id === bare || m.id.endsWith(`/${bare}`))));
  if (same.length === 1) {
    box.value = same[0].id;
    setModelStatus("loading", `Changed to ${same[0].id}, the name ${host} uses for ${v}.`);
  } else {
    box.value = "";
    setModelStatus("loading", `${v} isn't listed by ${host}. Choose one from the list.`);
  }
  resetTestStatus();
}
// The address changed: rename the model by rule, without waiting for (or
// needing) the new server's list. matchModelToList still has the final say.
function renameModelNow() {
  if (!keyFormOpen || keyModelTyped || state.provider !== "openai") return;
  const url = keyBaseUrlValue();
  const box = $("keyModel");
  const v = box.value.trim();
  if (!url || !v) return;
  const next = renameModelForServer(v, url);
  if (!next || next === v) return;
  box.value = next;
  setModelStatus("loading", `Changed to ${next}, the name ${hostOf(url)} uses for ${v}.`);
  resetTestStatus();
}
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

// Same rule as main's isLocalUrl: these servers need no API key.
const LOCAL_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i;

// Provider errors end with where to fix them ("Check it in Settings > AI Model >
// AI provider."). In this form that's where the user already is, so drop it.
const inForm = (message) =>
  String(message)
    .replace(/Check the base URL in Settings > AI Model > AI provider, and your connection\./g, "Check the server address and your connection.")
    .replace(/\s*Check (?:it|both)[^.]*Settings > AI Model > AI provider[^.]*\./g, "")
    .trim() || String(message);

function setTestStatus(kind, text) {
  testToken++;
  const el = $("testConnStatus");
  el.className = `test-status${kind ? ` ${kind}` : ""}`;
  $("testConnText").textContent = text;
  $("testConnBtn").disabled = kind === "testing";
}
const resetTestStatus = () => setTestStatus("", "Not tested since your last change");

async function testConnectionNow() {
  const openai = state.provider === "openai";
  const model = $("keyModel").value.trim() || (openai ? state.openaiModel : state.model);
  if (!model) return setTestStatus("error", "Choose a model first.");
  const params = {
    provider: state.provider,
    baseUrl: openai ? keyBaseUrlValue() : "",
    model,
    key: $("keyInput").value.trim(),
  };
  setTestStatus("testing", "Testing…");
  const token = testToken;
  let result;
  try {
    result = await testConnection(params);
  } catch (e) {
    result = { error: e?.message || String(e) };
  }
  if (token !== testToken) return; // a field changed while it ran
  if (result?.ok) setTestStatus("ok", `Connected · ${model} replied in ${(result.ms / 1000).toFixed(1)} s`);
  else setTestStatus("error", inForm(result?.error || "Couldn't connect."));
}

function renderKeyForm(changing) {
  const openai = state.provider === "openai";
  keyFormOpen = true;
  for (const b of $("keyProvider").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === state.provider));
  $("openaiFields").hidden = !openai;
  if (keyFormFor !== state.provider) {
    keyFormFor = state.provider;
    keyModels = []; // the other provider's list doesn't apply
    keyCombo?.close();
    $("keyBaseUrl").value = state.openaiBaseUrl || "";
    $("keyModel").value = openai ? state.openaiModel || "" : state.model || "";
    keyModelTyped = false; // filled in from settings, so it may follow the server's list
    resetTestStatus();
    loadKeyModels();
  }
  $("keyLead").textContent = changing
    ? `Change who answers${state.keyHint ? ` (current key ends in ${state.keyHint})` : ""}.`
    : "Choose who answers, then add an API key.";
  $("keyHint").textContent = openai
    ? "Works with any OpenAI-compatible API: OpenAI, Google Gemini, OpenRouter, Groq, Mistral, or a local Ollama or LM Studio (no key needed on localhost). Saved in your macOS keychain."
    : "Create one at console.anthropic.com. It's saved in your macOS keychain.";
  const saved = !!state.keyHint || !!state.keyFromEnv;
  $("keyInput").placeholder = saved ? "Saved · type a new key to replace it" : "Paste your API key";
}
$("keyProvider").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (v && v !== state.provider) {
    keyFormFor = null; // refill the fields for the new provider
    resetTestStatus();
    g.setSetting("provider", v);
  }
});
$("keyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("keyInput").value.trim();
  const model = $("keyModel").value.trim();
  if (state.provider === "openai") {
    const url = keyBaseUrlValue();
    $("keyBaseUrl").value = url;
    if (!model) return showNotice({ level: "error", text: "Enter the model name, for example gpt-4o, gemini-2.5-pro or llama3.1." });
    if (url !== state.openaiBaseUrl) g.setSetting("openaiBaseUrl", url);
    if (model !== state.openaiModel) g.setSetting("openaiModel", model);
  } else {
    if (model && model !== state.model) g.setSetting("model", model);
    if (!key && !state.keyHint) return;
  }
  if (key) g.setApiKey(key);
  closePanel();
});
$("keyBaseUrl").addEventListener("input", () => {
  // The model and list belong to the old server.
  keyModelTyped = false;
  keyModels = [];
  keyCombo?.refresh();
  keyCombo?.close();
  resetTestStatus();
  clearTimeout(renameTimer);
  renameTimer = setTimeout(renameModelNow, 400);
  loadKeyModels({ delay: 600 });
});
let renameTimer;
$("keyBaseUrl").addEventListener("blur", () => {
  clearTimeout(renameTimer);
  renameModelNow();
  const typed = $("keyBaseUrl").value.trim();
  const url = typed && normalizeBaseUrl(typed);
  if (url && url !== typed) $("keyBaseUrl").value = url;
});
$("keyInput").addEventListener("input", () => {
  resetTestStatus();
  loadKeyModels({ delay: 600 });
});
$("keyModel").addEventListener("input", () => {
  keyModelTyped = true;
  resetTestStatus();
});
$("keyModelStatus").addEventListener("click", (e) => {
  if (e.target.closest("#keyModelRetry")) loadKeyModels();
});
$("testConnBtn").addEventListener("click", testConnectionNow);
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
// Quit from the top bar. During a call it takes a second click, so a slip
// doesn't end the transcript.
// The X stays red while it waits: the notice is hidden when Glance is collapsed.
let quitArmed = null;
$("quitTopBtn").addEventListener("click", () => {
  const b = $("quitTopBtn");
  if (state.listening && !quitArmed) {
    b.classList.add("armed");
    b.title = "Click again to quit Glance";
    quitArmed = setTimeout(() => {
      quitArmed = null;
      b.classList.remove("armed");
      b.title = "Quit Glance";
    }, 5000);
    return showNotice({ level: "warn", text: "Glance is listening to your call. Click the X again to quit." });
  }
  g.quit();
});
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
$("thinkHarder").addEventListener("click", () => {
  const a = answers[page];
  if (canThinkHarder(a)) thinkHarder(a);
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
settingsCombo = makeCombo({
  input: $("settingsModel"),
  toggle: $("settingsModelToggle"),
  list: $("settingsModelList"),
  models: () => settingsModels,
  current: () => (state.provider === "openai" ? state.openaiModel : state.model) || "",
  pick: (id) => g.setSetting(state.provider === "openai" ? "openaiModel" : "model", id),
  revertOnBlur: true,
  emptyText: "No models listed yet. Press Refresh, or type a model ID.",
});
$("refreshModelsBtn").addEventListener("click", async () => {
  const btn = $("refreshModelsBtn");
  if (btn.disabled) return;
  const openai = state.provider === "openai";
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  let result;
  try {
    result = await listModels({ provider: state.provider, baseUrl: openai ? state.openaiBaseUrl : "", key: "" });
  } catch (e) {
    result = { error: e?.message || String(e) };
  }
  btn.disabled = false;
  if (result?.error) {
    btn.textContent = "Refresh";
    return showNotice({ level: "error", text: result.error });
  }
  const count = (Array.isArray(result) ? result : result?.models || []).length;
  btn.textContent = `${count} model${count === 1 ? "" : "s"}`;
  setTimeout(() => (btn.textContent = "Refresh"), 2500);
});
$("effort").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (v) g.setSetting("effort", v);
});
$("theme").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.value;
  if (v) g.setSetting("theme", v);
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
  turn = null;
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
$("keyBtn").addEventListener("click", () => {
  keyFormFor = null;
  openPanel("key");
  $("keyInput").focus();
});
$("quitBtn").addEventListener("click", () => g.quit());
$("updateCheckBtn").addEventListener("click", async () => {
  const status = state.update?.status;
  if (status === "available" || status === "error") {
    updateDismissed = null;
    return g.installUpdate();
  }
  updateCheckResult = "checking";
  renderAboutUpdate();
  updateCheckResult = await g.checkUpdate();
  if (updateCheckResult === "available") updateDismissed = null;
  render();
});
for (const b of document.querySelectorAll("[data-link]")) b.addEventListener("click", () => g.openLink(b.dataset.link));
$("settingsTabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (!tab) return;
  settingsTab = tab;
  updateCheckResult = null;
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
  fit();
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
// The open mode menu floats above the bottom bar and isn't part of the flow,
// so the window grows downward (as it does for answers) until the whole menu
// fits above the bar, then returns to its normal size when the menu closes.
let menuRoom = 0;
function menuClearance() {
  const menu = $("modeMenu");
  if (menu.hidden) return 0;
  const barTop = $("modePick").getBoundingClientRect().top - $("glass").getBoundingClientRect().top - menuRoom;
  return Math.max(0, Math.ceil(menu.offsetHeight + 10 - barTop));
}
function fit() {
  const room = menuClearance();
  if (room !== menuRoom) {
    menuRoom = room;
    document.querySelector(".dock").style.marginTop = room ? `${room}px` : "";
  }
  const h = [...$("glass").children].reduce((sum, el) => (el.hidden || el.classList.contains("rim") ? sum : sum + el.getBoundingClientRect().height), 0);
  g.resize(Math.ceil(h) + menuRoom);
}
const sizer = new ResizeObserver(fit);
for (const el of $("glass").children) sizer.observe(el);
new MutationObserver(fit).observe($("glass"), { subtree: true, attributes: true, attributeFilter: ["hidden"] });

// Welcome and setup: welcome, then (only if needed) the key, about you, the
// job description for interviews, and a ready screen. Shown on first launch
// and from Settings > General > Show welcome again.
// step: where it opens; "about" (the resume) when only the resume is missing.
function startOnboarding(step = "welcome") {
  g.setSetting("setupActive", true);
  panel = null;
  backToSettings = false;
  onboarding = {
    step,
    needsKey: !state.hasKey,
    needsModel: state.speech?.status !== "ready",
    use: state.style === "interview" ? "interviews" : state.resume?.trim() ? "both" : "meetings",
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
  $("onboardSkip").hidden = step === "ready" || !canSkipSetup();
  $("obBack").hidden = step === "welcome";
  $("obNext").textContent = step === "welcome" ? "Get started" : step === "speech" ? "Continue" : step === "ready" ? "Start using Glance" : "Next";
  const speechPending = step === "speech" && state.speech?.status !== "ready";
  if (step === "speech") {
    const speech = state.speech || {};
    if (speech.status !== "ready") onboarding.sawSpeechDownloading = true;
    const total = speech.total || 661_000_000;
    const received = Math.min(speech.received || 0, total);
    const mb = (n) => Math.round(n / 1_000_000).toLocaleString();
    // Rounded to tens: "about 660 MB" for Parakeet.
    $("obSpeechLead").textContent = `Glance needs this to transcribe calls. This one-time download is about ${Math.round(total / 10_000_000) * 10} MB.`;
    $("obSpeechFill").style.width = `${total ? (100 * received) / total : 0}%`;
    $("obSpeechMeta").textContent = `${mb(received)} of ${mb(total)} MB`;
    $("obSpeechProgress").hidden = speech.status === "error";
    $("obSpeechError").hidden = speech.status !== "error";
    $("obSpeechError").textContent = speech.error || "";
    $("obSpeechRetry").hidden = speech.status !== "error";
    $("obSpeechDone").hidden = speech.status !== "ready";
  }
  for (const b of $("obUse").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.value === onboarding.use));
  const words = $("obResume").value.trim() ? $("obResume").value.trim().split(/\s+/).length : 0;
  $("obResumeMeta").textContent = words ? `${words.toLocaleString()} words` : "";
  // Interview answers are built from the resume, so interviews need one;
  // meetings don't. Skip setup stays hidden until one is saved.
  const needResume = step === "about" && resumeRequired();
  $("obResumeNeed").textContent = onboarding.use === "meetings" ? "(optional)" : "(required for interviews)";
  $("obAboutHint").textContent = onboarding.use === "meetings"
    ? "So answers about you are accurate. All optional; change it later in Settings > Interview."
    : "Interview answers are built from your resume, so add it to continue. The rest is optional; change any of it later in Settings > Interview.";
  $("obNext").disabled = speechPending || (needResume && !words);
  $("obNext").title = $("obNext").disabled ? (speechPending ? "Wait for the speech model to download" : "Add your resume to continue") : "";
  $("obCloak").setAttribute("aria-checked", String(!!onboarding.hide));
  $("obListenKey").textContent = plainKeys(state.shortcuts?.listen || "");
  $("obAskKey").textContent = plainKeys(state.shortcuts?.ask || "");
}
const resumeRequired = () => onboarding?.use !== "meetings";
const resumeMissing = () => state.style === "interview" && !state.resume?.trim();
// Skip setup leaves only once the speech model is ready and a resume is saved, or for meetings.
const canSkipSetup = () => state.speech?.status === "ready" && (!resumeRequired() || !!state.resume?.trim());
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
  if (onboarding.step === "speech" && state.speech?.status !== "ready") return;
  if (onboarding.step === "about" && resumeRequired() && !$("obResume").value.trim()) return $("obResume").focus();
  saveStep();
  if (onboarding.step === "ready") return finishOnboarding();
  // Someone who already finished setup came back only for the model: Continue
  // closes setup, or moves on to the resume if Interview mode still needs one.
  if (onboarding.step === "speech" && state.onboarded) {
    if (resumeMissing()) {
      onboarding.step = "about";
      render();
      $("stage").scrollTop = 0;
      $("obResume").focus();
      return;
    }
    return finishOnboarding();
  }
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
$("onboardSkip").addEventListener("click", () => {
  if (!canSkipSetup()) return;
  // Skipped as Meetings: leave Interview mode, which needs a resume.
  if (onboarding.use === "meetings" && state.style === "interview") g.setSetting("style", meetingStyle());
  finishOnboarding();
});
$("keyStepBack").addEventListener("click", () => {
  onboarding.step = "welcome";
  render();
});
function requestSpeechDownload() {
  return g.downloadModel();
}
$("obSpeechRetry").addEventListener("click", () => requestSpeechDownload());
$("speechRetry").addEventListener("click", () => requestSpeechDownload());
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
  wasListening = !!state.listening; // reloaded mid-call: stopping still drops the question
  heard = transcript;
  heard.forEach(renderTranscriptLine);
  // Setup until done; and again while Interview mode has no resume, since
  // interview answers are built from it (Skip setup can't leave without one).
  // A missing speech model brings back just that step. While Glance is
  // still checking the files on disk, wait for the answer (see render).
  if (!state.onboarded) startOnboarding();
  else if (state.speech?.status === "checking") {
    speechCheckPending = true;
    if (resumeMissing()) startOnboarding("about");
  } else if (state.speech?.status !== "ready") startOnboarding("speech");
  else if (resumeMissing()) startOnboarding("about");
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

