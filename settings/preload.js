const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nyra", {
  getSettings: () => ipcRenderer.invoke("nyra:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("nyra:save-settings", settings),
  setHotkey: (accelerator) => ipcRenderer.invoke("nyra:set-hotkey", accelerator),
  testAutomation: () => ipcRenderer.invoke("nyra:test-automation"),
  compileTest: (text) => ipcRenderer.invoke("nyra:compile-test", text),
  onSettingsChanged: (handler) =>
    ipcRenderer.on("nyra:settings-changed", () => handler()),
  chooseProjectFolder: () => ipcRenderer.invoke("nyra:choose-project-folder"),
  clearProjectFolder: () => ipcRenderer.invoke("nyra:clear-project-folder"),
  openExternal: (url) => ipcRenderer.invoke("nyra:open-external", url),
  getHistory: () => ipcRenderer.invoke("nyra:get-history"),
  clearHistory: () => ipcRenderer.invoke("nyra:clear-history"),
  deleteHistoryEntry: (id) => ipcRenderer.invoke("nyra:delete-history-entry", id),
  copyToClipboard: (text) => ipcRenderer.invoke("nyra:copy-to-clipboard", text),
  setLaunchAtStartup: (enabled) => ipcRenderer.invoke("nyra:set-launch-at-startup", enabled),
  openDataDir: () => ipcRenderer.invoke("nyra:open-data-dir"),
  checkForUpdates: () => ipcRenderer.invoke("nyra:check-for-updates"),
});
