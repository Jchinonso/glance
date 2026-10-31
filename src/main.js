import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, shell, systemPreferences, Tray } from "electron";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Listener } from "./audio.js";
import { caveman, keepsFacts } from "./compress.js";
import { extractResume, RESUME_EXTENSIONS } from "./resume.js";
import { isBackchannel, isPromptHallucination } from "./transcript.js";
import { ask, compressInstructions, describeError, splitKeys, summarizeSession } from "./assistant.js";
import { ANTHROPIC_MODELS, createProvider, DEFAULT_ANTHROPIC_MODEL, isAbort, PROVIDERS } from "./providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Files run by external programs (whisper-cli, audiotee) must come from the
// unpacked copy, not from inside app.asar.
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
// GLANCE_TEST_DIR (UI tests): settings and logs in that folder, no keychain,
// no global shortcuts, and a see-through window that never takes focus.
const TEST_DIR = process.env.GLANCE_TEST_DIR;
if (TEST_DIR) {
  app.setPath("userData", TEST_DIR);
  app.setAppLogsPath(path.join(TEST_DIR, "logs"));
}
const configPath = path.join(app.getPath("userData"), "config.json");
const logPath = path.join(app.getPath("logs"), "glance.log");

const LOG_MAX_BYTES = 1_000_000;

function log(...parts) {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    // Keep one previous log; drop anything older.
    if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) renameSync(logPath, `${logPath}.1`);
    appendFileSync(logPath, `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(" ")}\n`);
  } catch {}
}
process.on("uncaughtException", (e) => log("uncaught:", e));
process.on("unhandledRejection", (e) => log("unhandled rejection:", e));

const TRANSCRIPT_LIMIT = 60; // lines sent to the model
const TRANSCRIPT_SYNC = 500; // lines the window gets when it (re)loads
const PREVIOUS_LIMIT = 3; // earlier answers sent for follow-up context
const HEARD_CONTEXT_MS = 60000; // a line heard this recently is what an untyped ask answered
// Interviews need more: answers must stay consistent and not reuse stories.
const INTERVIEW_PREVIOUS_LIMIT = 8;

// provider: which LLM answers (see providers.js). model is the Anthropic model;
// an OpenAI-compatible server uses openaiBaseUrl and openaiModel instead.
const defaults = { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL, openaiBaseUrl: "https://api.openai.com/v1", openaiModel: "", effort: "low", invisible: true, autoScreen: true, style: "brief", customInstructions: "", compressedInstructions: "", shortcuts: null, transcription: "accurate", vocabulary: "", resume: "", jobDescription: "",
  // Setup: onboarded once the welcome and setup steps are done or skipped.
  // Your details go with every question like the resume. jdCheckedAt: when the
  // job description was last confirmed for an interview (ms; 0 = ask again).
  onboarded: false, profileName: "", salary: "", visa: "", notice: "", jdCheckedAt: 0,
  apiKey: null, openaiKey: null };
const PROFILE_FIELDS = ["profileName", "salary", "visa", "notice"];
const profile = () => ({ name: config.profileName, salary: config.salary, visa: config.visa, notice: config.notice });
// Resume and job description are sent word for word (never compressed), so
// interview answers can use their exact wording.
const MAX_DOC = 20000;
const MAX_INSTRUCTIONS = 12000; // characters; the form reads this from state
const MAX_SHOTS = 4;
let config = { ...defaults };
let win = null;
let llm = null; // the provider for the current settings; reset when they change
let listener = null;
let listening = false;
let listeningSince = null;
let transcript = [];
let answers = [];
let current = null;
let nextId = 1;
let shots = []; // screenshots attached to the next question: { id, data, thumb }
let nextShotId = 1;
let spend = { input: 0, output: 0, dollars: 0 }; // this session, all calls

// usage is a provider's normalized { input, output, cacheRead, cacheWrite }.
// Cost is null when the provider has no price list (OpenAI-compatible).
function addUsage(u, model = currentModel()) {
  if (!u) return null;
  const cost = provider().cost(u, model);
  spend = {
    input: spend.input + u.input + u.cacheRead + u.cacheWrite,
    output: spend.output + u.output,
    dollars: spend.dollars + (cost || 0),
  };
  broadcastState();
  return cost;
}

const isLocalUrl = (url) => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(url || "");

function provider() {
  return (llm ??= createProvider({ provider: config.provider, apiKey: apiKey(), baseUrl: config.openaiBaseUrl, model: config.openaiModel }));
}

const currentModel = () => (config.provider === "openai" ? config.openaiModel : config.model);

// Ready to answer: a key (a local server needs none) and, for an
// OpenAI-compatible server, a model name.
function canAsk() {
  if (config.provider === "openai") return !!config.openaiModel.trim() && (!!apiKey() || isLocalUrl(config.openaiBaseUrl));
  return !!apiKey();
}

// API keys live in the login keychain via /usr/bin/security, so they survive
// rebuilds that change the app's code signature. One entry per provider.
const KEYCHAIN = { service: "com.glance.overlay.api-key", accounts: { anthropic: "glance", openai: "openai" } };

function readKeychainKey(account = KEYCHAIN.accounts.anthropic) {
  if (TEST_DIR) return null;
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN.service, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

// API keys from these providers only use these characters; anything else is
// refused rather than passed to `security`.
const KEY_CHARS = /^[A-Za-z0-9_.:-]+$/;

function writeKeychainKey(key, account = KEYCHAIN.accounts.anthropic) {
  if (TEST_DIR) return;
  const base = ["-s", KEYCHAIN.service, "-a", account];
  if (key) {
    if (!KEY_CHARS.test(key)) throw new Error("that doesn't look like an API key");
    // Fed on stdin in interactive mode so the key never shows in the process list.
    execFileSync("/usr/bin/security", ["-i"], {
      input: `add-generic-password -U -s ${KEYCHAIN.service} -a ${account} -w ${key}\n`,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (readKeychainKey(account) !== key) throw new Error("the keychain didn't accept it");
  } else {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", ...base], { stdio: "ignore" });
    } catch {}
  }
}

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {}
  const { apiKeyEnc, apiKey: _ignored, openaiKey: _ignored2, ...settings } = raw;
  // A value of the wrong type (hand edit, older build) falls back to the default.
  for (const [k, v] of Object.entries(settings)) {
    if (k in defaults && defaults[k] !== null && typeof v !== typeof defaults[k]) delete settings[k];
  }
  config = { ...defaults, ...settings, apiKey: readKeychainKey(), openaiKey: readKeychainKey(KEYCHAIN.accounts.openai) };
  if (!(config.provider in PROVIDERS)) config.provider = "anthropic";
  // Migrate a key saved by older builds, if this build can still decrypt it.
  if (!config.apiKey && apiKeyEnc) {
    try {
      config.apiKey = safeStorage.decryptString(Buffer.from(apiKeyEnc, "base64"));
      writeKeychainKey(config.apiKey);
    } catch {}
  }
  // A compressed version saved before compressInstructions checked its
  // output may have lost a fact; drop it so the original is sent instead.
  if (config.compressedInstructions && !keepsFacts(config.customInstructions, config.compressedInstructions)) {
    log("saved compressed instructions dropped a fact; sending the original");
    config.compressedInstructions = "";
    saveConfig();
  } else if (apiKeyEnc) saveConfig();
}

// Written to a temp file and renamed, so a crash mid-write can't corrupt it.
function saveConfig() {
  const { apiKey, openaiKey, ...rest } = config;
  try {
    writeFileSync(`${configPath}.tmp`, JSON.stringify(rest, null, 2));
    renameSync(`${configPath}.tmp`, configPath);
  } catch (e) {
    log("saving settings failed:", e);
  }
}

function apiKey() {
  if (config.provider === "openai") return config.openaiKey || process.env.OPENAI_API_KEY || null;
  return config.apiKey || process.env.ANTHROPIC_API_KEY || null;
}

// Messages sent before the window finishes loading are queued, not lost.
let windowReady = false;
const pending = [];

function send(channel, payload) {
  if (!win || win.isDestroyed()) return;
  if (!windowReady) return void pending.push([channel, payload]);
  win.webContents.send(channel, payload);
}

function state() {
  return {
    listening,
    listeningSince,
    invisible: config.invisible,
    provider: config.provider,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label })),
    model: config.model,
    models: Object.entries(ANTHROPIC_MODELS).map(([id, m]) => ({ id, name: m.name })),
    openaiBaseUrl: config.openaiBaseUrl,
    openaiModel: config.openaiModel,
    keyOptional: config.provider === "openai" && isLocalUrl(config.openaiBaseUrl),
    effort: config.effort,
    style: config.style,
    customInstructions: config.customInstructions,
    compressedInstructions: config.compressedInstructions,
    sentInstructions: sentInstructions(),
    maxInstructions: MAX_INSTRUCTIONS,
    resume: config.resume,
    jobDescription: config.jobDescription,
    maxDoc: MAX_DOC,
    onboarded: config.onboarded,
    profileName: config.profileName,
    salary: config.salary,
    visa: config.visa,
    notice: config.notice,
    jdCheckedAt: config.jdCheckedAt,
    transcription: config.transcription,
    vocabulary: config.vocabulary,
    autoScreen: config.autoScreen,
    shots: shots.map(({ id, thumb }) => ({ id, thumb })),
    hasKey: canAsk(),
    keyHint: apiKey() ? apiKey().slice(-4) : null,
    busy: !!current,
    savingNotes,
    spend,
    shortcuts: shortcuts(),
    transcriptCount: transcript.length,
  };
}

function broadcastState() {
  send("state", state());
}

function applyInvisible() {
  win?.setContentProtection(config.invisible);
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.max(420, Math.min(1000, config.width || 560));
  win = new BrowserWindow({
    width,
    height: 200,
    minWidth: 420,
    minHeight: 44,
    ...startPosition(width, workArea),
    frame: false,
    // Native blur: CSS backdrop-filter can't see the desktop behind the window.
    vibrancy: nativeTheme.shouldUseDarkColors ? "hud" : "popover",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    fullscreenable: false,
    type: "panel",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Users set the width by dragging an edge; height follows the content.
  win.on("resized", () => {
    config.width = win.getSize()[0];
    saveConfig();
  });
  // "moved" fires continuously while dragging; save once it settles.
  let moveTimer = null;
  win.on("moved", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      config.position = { x, y };
      saveConfig();
    }, 400);
  });
  // Light and dark need different native blur materials.
  nativeTheme.on("updated", () => win?.setVibrancy(nativeTheme.shouldUseDarkColors ? "hud" : "popover"));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("did-finish-load", () => {
    windowReady = true;
    for (const [channel, payload] of pending.splice(0)) win.webContents.send(channel, payload);
  });
  win.loadFile(path.join(here, "ui", "index.html"));
  win.once("ready-to-show", () => {
    applyInvisible();
    if (TEST_DIR) {
      win.setOpacity(0);
      win.showInactive();
    } else win.show();
  });
}

function showWindow() {
  if (!win) return;
  win.show();
  send("focus-input");
}

// With no dock icon, a hidden window is easy to lose. The first time, say how
// to bring it back.
function hideWindow() {
  if (!win) return;
  win.hide();
  if (!config.hideTipShown && Notification.isSupported()) {
    new Notification({ title: "Glance is hidden", body: `Click the Glance icon in the menu bar, or press ${formatAccel(shortcuts().toggleWindow)}, to bring it back.` }).show();
    config.hideTipShown = true;
    saveConfig();
  }
}

// Reopen where the user left it, if that spot is still on a connected display.
function startPosition(width, workArea) {
  const p = config.position;
  if (p && screen.getAllDisplays().some((d) => p.x >= d.workArea.x && p.x < d.workArea.x + d.workArea.width && p.y >= d.workArea.y && p.y < d.workArea.y + d.workArea.height)) {
    return { x: p.x, y: p.y };
  }
  return { x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + 24 };
}

// After a monitor is unplugged, move Glance back on-screen if it was left off.
function keepOnScreen() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const visible = screen.getAllDisplays().some((d) => b.x + 40 > d.workArea.x && b.x < d.workArea.x + d.workArea.width - 40 && b.y >= d.workArea.y - 10 && b.y < d.workArea.y + d.workArea.height - 40);
  if (!visible) {
    const { workArea } = screen.getPrimaryDisplay();
    win.setPosition(Math.round(workArea.x + (workArea.width - b.width) / 2), workArea.y + 24);
  }
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) hideWindow();
  else showWindow();
}

// Menu bar icon: a lens (ring with a centre dot), drawn as a template image so
// macOS tints it for light and dark menu bars.
function trayIcon() {
  const size = 36; // 18pt at 2x
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const ring = Math.max(0, 1 - Math.abs(d - 12) / 2.2);
      const dot = Math.max(0, Math.min(1, 5.5 - d));
      const a = Math.round(Math.min(1, ring + dot) * 255);
      buf.writeUInt32LE((a << 24) >>> 0, (y * size + x) * 4); // BGRA, black
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

let tray = null;
function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(`Glance (${formatAccel(shortcuts().toggleWindow)} to show or hide)`);
  tray.on("click", toggleWindow);
  tray.on("right-click", () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: win?.isVisible() ? "Hide Glance" : "Show Glance", accelerator: shortcuts().toggleWindow, click: toggleWindow },
        { label: listening ? "Stop listening" : "Start listening", accelerator: shortcuts().listen, enabled: !setupActive, click: toggleListening },
        { label: "Screenshot and answer", accelerator: shortcuts().snap, enabled: !setupActive, click: () => { showWindow(); send("snap-submit"); } },
        { label: "Save notes", enabled: !savingNotes, click: saveNotes },
        { type: "separator" },
        { label: "Quit Glance", role: "quit" },
      ]),
    );
  });
}

function moveBy(dx, dy) {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

const SCREEN_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

class ScreenAccessError extends Error {}

function screenAccessError() {
  return new ScreenAccessError(
    "Glance can't see your screen. In System Settings > Privacy & Security > Screen & System Audio Recording, turn on Glance, then quit and reopen Glance.",
  );
}

async function captureScreen() {
  // Don't pre-check access: Electron reports "denied" before macOS has ever
  // asked, and only the capture call itself makes macOS show the prompt.
  // The display under the pointer is the one being worked on, which with two
  // monitors is often not the one Glance sits on.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // Keep the overlay out of its own screenshot even when invisibility is off.
  win?.setContentProtection(true);
  try {
    const { width, height } = display.size;
    const scale = display.scaleFactor;
    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: width * scale, height: height * scale },
      });
    } catch (e) {
      log("getSources failed:", e, "screen status:", systemPreferences.getMediaAccessStatus("screen"));
      throw screenAccessError();
    }
    log("getSources ok:", sources.length, "sources", sources.map((x) => `${x.display_id}:${x.thumbnail.isEmpty() ? "empty" : "ok"}`).join(","));
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) throw screenAccessError();
    let img = source.thumbnail;
    const size = img.getSize();
    const longest = Math.max(size.width, size.height);
    // 1280px keeps on-screen text legible at ~1/3 fewer image tokens than 1568px.
    if (longest > 1280) img = img.resize({ width: Math.round((size.width * 1280) / longest), quality: "good" });
    const thumbW = 160;
    const thumb = img.resize({ width: thumbW, height: Math.round((img.getSize().height * thumbW) / img.getSize().width) });
    return { data: img.toJPEG(85).toString("base64"), thumb: thumb.toDataURL() };
  } finally {
    win?.setContentProtection(config.invisible);
  }
}

// heard: the question came from the call transcript, so an automatic screenshot
// would only add tokens.
async function runAsk(question, { heard = false } = {}) {
  if (current) current.abort();
  if (!canAsk()) {
    send("notice", { level: "error", text: config.provider === "openai" ? "Set the model and API key for your OpenAI-compatible server first." : "Add your Anthropic API key first." });
    return;
  }
  const llm = provider();
  const id = nextId++;
  const q = (question || "").trim();
  let cancelled = false;
  // Cancellable from the start, including while the screenshot is taken.
  current = { id, abort: () => (cancelled = true) };
  broadcastState();
  send("answer-start", { id, question: q });

  // Screenshots the user attached win; otherwise grab the screen now if enabled.
  let screenshots = shots.map((s) => s.data);
  shots = [];
  if (!screenshots.length && config.autoScreen && !heard) {
    try {
      screenshots = [(await captureScreen()).data];
    } catch (e) {
      notifyCaptureError(e, " Asking without the screen.");
    }
  }

  if (cancelled) {
    if (current?.id === id) current = null;
    send("answer-end", { id, aborted: true });
    return broadcastState();
  }

  // Nothing typed or heard: remember what the other side said last, so later
  // questions know which one this answered.
  const lastThem = transcript.findLast((l) => l.role === "them");
  const context = !q && listening && lastThem && Date.now() - lastThem.at < HEARD_CONTEXT_MS ? lastThem.text : "";

  let text = "";
  const model = currentModel();
  const job = ask({
    provider: llm,
    model,
    question: q,
    transcript: transcript.slice(-TRANSCRIPT_LIMIT),
    previous: answers.slice(config.style === "interview" ? -INTERVIEW_PREVIOUS_LIMIT : -PREVIOUS_LIMIT),
    screenshots,
    effort: config.effort,
    style: config.style,
    customInstructions: sentInstructions(),
    resume: config.resume,
    jobDescription: config.jobDescription,
    profile: profile(),
    onText: (delta) => {
      text += delta;
      send("answer-delta", { id, text: delta });
    },
  });
  current = { id, abort: () => job.abort() };
  broadcastState();
  try {
    const { result, problem } = await job.done;
    if (text) answers.push({ id, question: q, context, answer: text });
    const u = result.usage;
    const cost = addUsage(u, model);
    send("answer-end", { id, error: problem, usage: { input: u.input + u.cacheRead + u.cacheWrite, output: u.output, cost, model: llm.name(model) } });
  } catch (e) {
    const aborted = isAbort(e);
    if (!aborted) log("answer failed:", e);
    // A stopped answer still shows, so keep it for follow-ups and notes.
    if (aborted && text) answers.push({ id, question: q, context, answer: text });
    send("answer-end", { id, error: aborted ? null : describeError(llm, e, model), aborted });
  } finally {
    if (current?.id === id) current = null;
    broadcastState();
  }
}

function notifyCaptureError(e, suffix = "") {
  log("capture error:", e);
  const access = e instanceof ScreenAccessError;
  send("notice", { level: access ? "error" : "warn", text: e.message + suffix, action: access ? "screen-settings" : null });
}

// Returns true when a screenshot was added to the tray.
async function addShot() {
  if (shots.length >= MAX_SHOTS) {
    send("notice", { level: "warn", text: `You can attach up to ${MAX_SHOTS} screenshots. Remove one to add another.` });
    return false;
  }
  try {
    const { data, thumb } = await captureScreen();
    shots.push({ id: nextShotId++, data, thumb });
    broadcastState();
    return true;
  } catch (e) {
    notifyCaptureError(e);
    return false;
  }
}

// Screenshot now and answer it, along with anything already in the tray.
async function snapAndAsk(question) {
  if (shots.length >= MAX_SHOTS || (await addShot())) await runAsk(question);
}

// Compress custom instructions once when they're saved, so every question
// sends the shorter copy. Compressing per question would cost an extra API
// call each time and save nothing.
const MIN_COMPRESS_CHARS = 300;
const approxTokens = (text) => Math.ceil(text.trim().length / 4);

// What the model receives: the LLM-compressed version as is, or the original
// through the free mechanical pass. Never both, so a compressed version isn't
// mangled again.
const sentInstructions = () => config.compressedInstructions || caveman(config.customInstructions);

async function compressSavedInstructions(text) {
  if (!text.trim()) return send("notice", { level: "ok", text: "Custom instructions cleared." });
  if (text.length < MIN_COMPRESS_CHARS || !canAsk()) {
    return send("notice", { level: "ok", text: "Custom instructions saved. They apply from your next question." });
  }
  send("notice", { level: "ok", text: "Saved. Compressing them to save tokens…" });
  const llm = provider();
  // Compression happens once and must keep every fact, so on Anthropic it
  // always uses the most capable model; elsewhere, the chosen one.
  const model = config.provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : currentModel();
  try {
    const short = (await compressInstructions(llm, model, text, addUsage)).slice(0, MAX_INSTRUCTIONS);
    if (config.customInstructions !== text) return; // edited again meanwhile
    if (short && short.length < text.length) {
      config.compressedInstructions = short;
      saveConfig();
      send("notice", { level: "ok", text: `Saved and compressed: about ${approxTokens(short)} tokens per question instead of ${approxTokens(text)}.` });
    } else {
      send("notice", { level: "ok", text: "Saved. They're already compact, so they're sent as written." });
    }
  } catch (e) {
    log("compress failed:", e);
    send("notice", { level: "warn", text: `Saved, but compression failed: ${describeError(llm, e, model)} They're sent as written.` });
  }
}

// Notes go to ~/Documents/Glance as Markdown: the model's summary (when a key is
// set), then the full transcript and every question asked.
const notesDir = () => path.join(app.getPath("documents"), "Glance");
let savingNotes = false;

function notesFileName(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.md`;
}

async function saveNotes() {
  if (savingNotes) return;
  if (!transcript.length && !answers.length) {
    return send("notice", { level: "warn", text: "Nothing to save yet. Listen to a call or ask something first." });
  }
  savingNotes = true;
  broadcastState();
  const now = new Date();
  const parts = [`# Notes, ${now.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}`];
  try {
    if (canAsk()) {
      send("notice", { level: "ok", text: "Writing your notes…" });
      const llm = provider();
      const model = currentModel();
      try {
        parts.push(await summarizeSession(llm, model, { transcript, answers }, addUsage));
      } catch (e) {
        log("summary failed:", e);
        parts.push(`_Summary unavailable: ${describeError(llm, e, model)}_`);
      }
    }
    if (transcript.length) {
      parts.push("## Transcript", transcript.map((l) => `**${l.role === "me" ? "You" : "Them"}:** ${l.text}`).join("\n\n"));
    }
    if (answers.length) {
      parts.push("## Questions and answers", answers.map((a) => `### ${a.question || a.context || "Help with what's on screen"}\n\n${splitKeys(a.answer).text}${a.said ? `\n\n_You said instead:_ ${a.said}` : ""}`).join("\n\n"));
    }
    mkdirSync(notesDir(), { recursive: true });
    let file = path.join(notesDir(), notesFileName(now));
    for (let n = 2; existsSync(file); n++) file = path.join(notesDir(), notesFileName(now).replace(/\.md$/, ` (${n}).md`));
    await writeFile(file, parts.join("\n\n") + "\n");
    send("notice", { level: "ok", text: `Notes saved to Documents/Glance.`, action: { type: "open", path: file } });
  } catch (e) {
    log("save notes failed:", e);
    send("notice", { level: "error", text: `Couldn't save notes: ${e.message}` });
  } finally {
    savingNotes = false;
    broadcastState();
  }
}

async function toggleListening() {
  listener ??= createListener();
  if (listening) {
    listener.stop();
    listening = false;
    listeningSince = null;
  } else {
    if (!listener.start()) return;
    listening = true;
    listeningSince = Date.now();
  }
  broadcastState();
}

// "fast" = base.en, "accurate" = small.en (about 2x slower, much better with
// jargon, accents and noise; still faster than real time on Apple Silicon).
// Falls back to base.en if the bigger model is missing.
const TECH_TERMS = "React, Next.js, TypeScript, JavaScript, Node.js, Python, Go, Rust, Java, Postgres, PostgreSQL, MySQL, Redis, MongoDB, Kubernetes, Docker, GraphQL, REST, API, AWS, GCP, Azure, SQL, CI/CD, LeetCode";

function transcriptionOptions() {
  const model = (name) => unpacked(path.join(here, "..", "models", `ggml-${name}.bin`));
  const accurate = config.transcription === "accurate" && existsSync(model("small.en"));
  const words = config.vocabulary.trim();
  return {
    modelPath: model(accurate ? "small.en" : "base.en"),
    prompt: `Terms: ${TECH_TERMS}.${words ? ` Names and terms: ${words}.` : ""}`,
  };
}

function createListener() {
  const l = new Listener({
    ...transcriptionOptions(),
    audioteePath: unpacked(path.join(here, "..", "node_modules", "audiotee", "bin", "audiotee")),
  });
  const keep = (line) => {
    // Kept whole for notes, in spoken order; only the tail goes to the model.
    let i = transcript.length;
    while (i > 0 && transcript[i - 1].at > line.at) i--;
    transcript.splice(i, 0, line);
    send("transcript", line);
  };
  l.on("line", (line) => {
    if (isBackchannel(line.text)) return;
    if (isPromptHallucination(line.text, [...TECH_TERMS.split(", "), ...config.vocabulary.split(",")])) return;
    keep(line);
  });
  l.on("error", (text) => send("notice", { level: "error", text }));
  // Capture stopped on its own (system audio lost, permission revoked).
  l.on("ended", () => {
    if (!listening) return;
    listening = false;
    listeningSince = null;
    broadcastState();
  });
  return l;
}

// Remappable global shortcuts. Moving the window with ⌘ + arrows stays fixed.
const DEFAULT_SHORTCUTS = {
  toggleWindow: "CommandOrControl+\\",
  ask: "CommandOrControl+Enter",
  listen: "CommandOrControl+Shift+\\",
  snap: "CommandOrControl+Shift+2",
  addShot: "CommandOrControl+Shift+1",
  invisible: "CommandOrControl+Shift+H",
};

// True while the welcome and setup screens are open: listening and screenshot
// shortcuts wait until setup is done. Not saved.
let setupActive = false;
const SHORTCUT_ACTIONS = {
  toggleWindow,
  ask: () => {
    if (!win?.isVisible()) win?.show();
    // Renderer submits whatever is typed (or nothing, for an auto answer).
    send("submit");
  },
  listen: () => setupActive || toggleListening(),
  snap: () => {
    if (!win?.isVisible()) win?.show();
    send("snap-submit");
  },
  addShot: () => {
    if (setupActive) return;
    if (!win?.isVisible()) showWindow();
    addShot();
  },
  // Works from any app, so say what changed: a stray press shouldn't leave
  // Glance visible in a screen share unnoticed.
  invisible: () => {
    config.invisible = !config.invisible;
    saveConfig();
    applyInvisible();
    broadcastState();
    const keys = formatAccel(shortcuts().invisible);
    send("notice", config.invisible ? { level: "ok", text: `Hidden from screen sharing (${keys}).` } : { level: "warn", text: `Glance is now visible in screen sharing. Press ${keys} to hide it again.` });
  },
};

function shortcuts() {
  return { ...DEFAULT_SHORTCUTS, ...(config.shortcuts || {}) };
}

// Returns the accelerators that couldn't be registered (taken by another app).
function registerShortcuts() {
  if (TEST_DIR) return [];
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [action, accel] of Object.entries(shortcuts())) {
    try {
      if (!globalShortcut.register(accel, SHORTCUT_ACTIONS[action])) failed.push(accel);
    } catch {
      // Malformed (e.g. a hand-edited settings file): go back to the default.
      log("invalid shortcut replaced with default:", accel);
      delete config.shortcuts?.[action];
      saveConfig();
      try {
        if (!globalShortcut.register(DEFAULT_SHORTCUTS[action], SHORTCUT_ACTIONS[action])) failed.push(DEFAULT_SHORTCUTS[action]);
      } catch {}
    }
  }
  const moves = { Up: [0, -80], Down: [0, 80], Left: [-80, 0], Right: [80, 0] };
  for (const [key, [dx, dy]] of Object.entries(moves)) globalShortcut.register(`CommandOrControl+${key}`, () => moveBy(dx, dy));
  if (failed.length) log("shortcuts not registered:", failed.join(", "));
  tray?.setToolTip(`Glance (${formatAccel(shortcuts().toggleWindow)} to show or hide)`);
  return failed;
}

function formatAccel(accel) {
  const sym = { CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↵", Up: "↑", Down: "↓", Left: "←", Right: "→" };
  return accel.split("+").map((k) => sym[k] || k).join("");
}

ipcMain.handle("set-shortcut", (_e, action, accel) => {
  if (!(action in DEFAULT_SHORTCUTS)) return { error: "Unknown action." };
  const current = shortcuts();
  const clash = Object.entries(current).find(([a, k]) => a !== action && k === accel);
  if (clash) return { error: "Another Glance action already uses that shortcut." };
  config.shortcuts = { ...(config.shortcuts || {}), [action]: accel };
  if (registerShortcuts().includes(accel)) {
    config.shortcuts[action] = current[action];
    registerShortcuts();
    return { error: "macOS or another app already uses that shortcut. Try a different one." };
  }
  saveConfig();
  broadcastState();
  return {};
});
ipcMain.handle("reset-shortcuts", () => {
  config.shortcuts = null;
  saveConfig();
  registerShortcuts();
  broadcastState();
});
// While the user records a new shortcut, the old ones must not fire.
ipcMain.handle("pause-shortcuts", (_e, paused) => {
  if (paused) globalShortcut.unregisterAll();
  else registerShortcuts();
});

ipcMain.handle("get-state", () => ({ ...state(), transcript: transcript.slice(-TRANSCRIPT_SYNC) }));
ipcMain.handle("ask", (_e, question, options) => runAsk(question, { heard: !!options?.heard }));
// Reads a resume or job description file for the form to show; nothing is
// saved until the user presses Save there.
ipcMain.handle("import-doc", async (_e, kind) => {
  const title = kind === "jobDescription" ? "Import job description" : "Import resume";
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title, properties: ["openFile"], filters: [{ name: "Documents", extensions: RESUME_EXTENSIONS }] });
  if (canceled || !filePaths[0]) return null;
  try {
    const text = await extractResume(filePaths[0]);
    return { text: text.slice(0, MAX_DOC), name: path.basename(filePaths[0]), truncated: text.length > MAX_DOC, pdf: /\.pdf$/i.test(filePaths[0]) };
  } catch (e) {
    log("import failed:", e);
    return { error: e.message };
  }
});
ipcMain.handle("cancel", () => current?.abort());
// What the user actually said instead of an answer; later questions get it in
// place of the suggestion. Empty clears it.
ipcMain.handle("set-said", (_e, id, text) => {
  const a = answers.find((x) => x.id === id);
  if (a) a.said = String(text ?? "").trim().slice(0, 1000) || undefined;
});
ipcMain.handle("toggle-listening", () => toggleListening());
// Saves the key for the current provider.
ipcMain.handle("set-api-key", (_e, key) => {
  const value = String(key ?? "").trim() || null;
  const anthropic = config.provider === "anthropic";
  if (value && anthropic && !value.startsWith("sk-ant-")) {
    send("notice", { level: "error", text: "That doesn't look like an Anthropic API key. Keys start with sk-ant-." });
    return broadcastState();
  }
  try {
    writeKeychainKey(value, KEYCHAIN.accounts[config.provider]);
    config[anthropic ? "apiKey" : "openaiKey"] = value;
    llm = null;
  } catch (e) {
    send("notice", { level: "error", text: `Couldn't save the key: ${e.message}.` });
  }
  broadcastState();
});
ipcMain.handle("set-setting", (_e, name, value) => {
  if (name === "setupActive") return void (setupActive = !!value);
  if (name === "model" && value in ANTHROPIC_MODELS) config.model = value;
  else if (name === "provider" && value in PROVIDERS) {
    config.provider = value;
    llm = null;
  } else if (name === "openaiBaseUrl") {
    const url = String(value ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\/\S+$/i.test(url)) {
      send("notice", { level: "error", text: "The base URL should start with https:// (or http:// for a local server), like https://api.openai.com/v1." });
      return broadcastState();
    }
    config.openaiBaseUrl = url;
    llm = null;
  } else if (name === "openaiModel") {
    config.openaiModel = String(value ?? "").trim().slice(0, 200);
    llm = null;
  }
  else if (name === "effort" && ["low", "medium", "high"].includes(value)) config.effort = value;
  else if (name === "autoScreen") config.autoScreen = !!value;
  else if (name === "style" && ["brief", "natural", "interview"].includes(value)) config.style = value;
  else if (name === "transcription" && ["fast", "accurate"].includes(value)) {
    config.transcription = value;
    listener?.setTranscription(transcriptionOptions());
  } else if (name === "vocabulary") {
    config.vocabulary = String(value ?? "").slice(0, 500);
    listener?.setTranscription(transcriptionOptions());
  }
  else if (name === "customInstructions") {
    const text = String(value ?? "").slice(0, MAX_INSTRUCTIONS);
    if (text !== config.customInstructions) {
      config.customInstructions = text;
      config.compressedInstructions = "";
      compressSavedInstructions(text);
    }
  }
  else if (name === "resume" || name === "jobDescription") {
    config[name] = String(value ?? "").slice(0, MAX_DOC);
    // Saving a job description confirms it for the interview at hand.
    if (name === "jobDescription") config.jdCheckedAt = Date.now();
  }
  else if (PROFILE_FIELDS.includes(name)) config[name] = String(value ?? "").trim().slice(0, 200);
  else if (name === "onboarded") config.onboarded = !!value;
  else if (name === "jdCheckedAt" && Number.isFinite(value)) config.jdCheckedAt = value;
  else if (name === "invisible") {
    config.invisible = !!value;
    applyInvisible();
  } else return;
  saveConfig();
  broadcastState();
});
ipcMain.handle("clipboard-read", () => clipboard.readText());
ipcMain.handle("clipboard-write", (_e, text) => clipboard.writeText(String(text ?? "")));
ipcMain.handle("add-shot", () => addShot());
ipcMain.handle("save-notes", () => saveNotes());
// Only opens files Glance itself wrote.
ipcMain.handle("open-notes", (_e, file) => {
  const resolved = path.resolve(String(file));
  if (resolved.startsWith(notesDir() + path.sep)) shell.openPath(resolved);
});
ipcMain.handle("snap-ask", (_e, question) => snapAndAsk(question));
ipcMain.handle("open-screen-settings", () => shell.openExternal(SCREEN_SETTINGS));
ipcMain.handle("remove-shot", (_e, id) => {
  shots = shots.filter((s) => s.id !== id);
  broadcastState();
});
ipcMain.handle("clear", () => {
  // A cleared session is a new interview: ask about the job description again.
  config.jdCheckedAt = 0;
  saveConfig();
  transcript = [];
  answers = [];
  spend = { input: 0, output: 0, dollars: 0 };
  shots = [];
  broadcastState();
});
ipcMain.handle("hide", () => hideWindow());
ipcMain.on("resize", (_e, height) => {
  if (!win || !Number.isFinite(height)) return;
  const [width] = win.getSize();
  // The window's height follows its content.
  const h = Math.max(44, Math.min(720, Math.round(height)));
  if (win.getSize()[1] !== h) win.setSize(width, h);
});
ipcMain.handle("quit", () => app.quit());

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => win?.show());

app.whenReady().then(() => {
  log("start", app.getVersion(), "screen status:", systemPreferences.getMediaAccessStatus("screen"));
  loadConfig();
  if (!existsSync(unpacked(path.join(here, "..", "models", "ggml-base.en.bin")))) {
    console.warn("Whisper model missing: transcription will fail.");
  }
  createWindow();
  createTray();
  screen.on("display-removed", keepOnScreen);
  screen.on("display-metrics-changed", keepOnScreen);
  // Instructions saved before auto-compression existed: compress them once now.
  if (config.customInstructions.length >= MIN_COMPRESS_CHARS && !config.compressedInstructions) {
    compressSavedInstructions(config.customInstructions);
  }
  const failed = registerShortcuts();
  if (failed.length) {
    // Usually another app (Cluely, for example) holds the same keys.
    send("notice", {
      level: "warn",
      text: `${failed.map(formatAccel).join(", ")} ${failed.length === 1 ? "is" : "are"} already used by another app. Change ${failed.length === 1 ? "it" : "them"} in Settings > General > Shortcuts.`,
    });
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  listener?.stop();
});
app.on("window-all-closed", () => app.quit());
