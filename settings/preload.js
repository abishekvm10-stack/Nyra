const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nyra", {
  getSettings: () => ipcRenderer.invoke("nyra:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("nyra:save-settings", settings),
  setHotkey: (accelerator) => ipcRenderer.invoke("nyra:set-hotkey", accelerator),
  testAutomation: () => ipcRenderer.invoke("nyra:test-automation"),
  chooseProjectFolder: () => ipcRenderer.invoke("nyra:choose-project-folder"),
  clearProjectFolder: () => ipcRenderer.invoke("nyra:clear-project-folder"),
});
