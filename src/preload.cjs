const { contextBridge, ipcRenderer } = require("electron");

const channels = ["state", "transcript", "answer-start", "answer-delta", "answer-end", "notice", "focus-input", "submit", "snap-submit"];

contextBridge.exposeInMainWorld("glance", {
  on(channel, fn) {
    if (!channels.includes(channel)) throw new Error(`Unknown channel ${channel}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
  getState: () => ipcRenderer.invoke("get-state"),
  ask: (question) => ipcRenderer.invoke("ask", question),
  cancel: () => ipcRenderer.invoke("cancel"),
  toggleListening: () => ipcRenderer.invoke("toggle-listening"),
  setApiKey: (key) => ipcRenderer.invoke("set-api-key", key),
  setSetting: (name, value) => ipcRenderer.invoke("set-setting", name, value),
  readClipboard: () => ipcRenderer.invoke("clipboard-read"),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard-write", text),
  setShortcut: (action, accel) => ipcRenderer.invoke("set-shortcut", action, accel),
  resetShortcuts: () => ipcRenderer.invoke("reset-shortcuts"),
  pauseShortcuts: (paused) => ipcRenderer.invoke("pause-shortcuts", paused),
  saveNotes: () => ipcRenderer.invoke("save-notes"),
  openNotes: (file) => ipcRenderer.invoke("open-notes", file),
  addShot: () => ipcRenderer.invoke("add-shot"),
  snapAsk: (question) => ipcRenderer.invoke("snap-ask", question),
  openScreenSettings: () => ipcRenderer.invoke("open-screen-settings"),
  removeShot: (id) => ipcRenderer.invoke("remove-shot", id),
  clear: () => ipcRenderer.invoke("clear"),
  hide: () => ipcRenderer.invoke("hide"),
  resize: (height) => ipcRenderer.send("resize", height),
  quit: () => ipcRenderer.invoke("quit"),
});
