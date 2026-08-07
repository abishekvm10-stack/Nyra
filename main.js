const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, Notification, ipcMain, dialog } = require("electron");
const path = require("path");
const Store = require("electron-store");
const { autoUpdater } = require("electron-updater");
const { compilePrompt } = require("./compiler");
const { getRelevantContext } = require("./context");

// Prevent a second copy of Nyra from ever running alongside an older
// one. Without this, two instances can both try to register Alt+P,
// and whichever grabbed it FIRST wins silently \u2014 which can mean an
// old, un-updated copy from an earlier session keeps responding to
// the hotkey even after you've fixed a bug and started a fresh one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

const store = new Store();
let tray = null;
let settingsWindow = null;

const HOTKEY = "Alt+P";
const DEFAULT_BACKEND_URL = "https://nyra-pddf.onrender.com";

function notify(title, body) {
  new Notification({ title, body }).show();
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", async (info) => {
    const result = await dialog.showMessageBox({
      type: "info",
      title: "Nyra update available",
      message: `Nyra ${info.version} is available. Download it now?`,
      buttons: ["Download update", "Later"],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        notify("Nyra update failed", String(error.message || error));
      }
    }
  });

  autoUpdater.on("update-downloaded", async () => {
    const result = await dialog.showMessageBox({
      type: "info",
      title: "Nyra update ready",
      message: "The update is ready. Restart Nyra to install it?",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on("error", (error) => {
    console.error("Nyra update check failed:", error.message || error);
  });

  // Give the tray and main window time to finish opening first.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      console.error("Nyra update check failed:", error.message || error);
    });
  }, 5000);
}

function getSettings() {
  return {
    provider: store.get("provider", ""),
    tier: store.get("tier", "fast"),
    targetStyle: store.get("targetStyle", "generic"),
    apiKey: store.get("apiKey", ""),
    ollamaUrl: store.get("ollamaUrl", "http://localhost:11434"),
    backendUrl: store.get("backendUrl", DEFAULT_BACKEND_URL),
    projectFolder: store.get("projectFolder", ""),
  };
}

async function handleHotkey() {
  const settings = getSettings();
  if (!settings.provider) {
    notify("Nyra", "No provider set up yet \u2014 open Settings from the tray icon.");
    return;
  }

  // Manual flow: select text and Ctrl+C yourself first, then Alt+P.
  // (An earlier version tried to simulate Ctrl+A/Ctrl+C/Ctrl+V
  // automatically via a keyboard-automation library, but that
  // library's simulated keystrokes weren't reliably reaching Windows
  // on every machine \u2014 clipboard read/write has no such dependency
  // and just works everywhere, so this is the more robust design.)
  const rawText = clipboard.readText().trim();

  if (!rawText) {
    notify("Nyra", "Copy some text first (Ctrl+C), then press Alt+P.");
    return;
  }

  // Safety net: keep the original around even after we overwrite the
  // clipboard with the compiled version, so it's recoverable from the
  // tray menu if the rewrite goes wrong.
  store.set("lastOriginalPrompt", rawText);

  try {
    const projectContext = settings.projectFolder
      ? getRelevantContext(settings.projectFolder, rawText)
      : "";
    const compiled = await compilePrompt(rawText, settings, projectContext);
    clipboard.writeText(compiled);
    notify("Nyra", "Compiled \u2014 press Ctrl+V to paste it.");
  } catch (err) {
    clipboard.writeText(rawText); // put the original back so nothing is lost
    notify("Nyra \u2014 error", String(err.message || err));
  }
}

function restoreLastOriginal() {
  const last = store.get("lastOriginalPrompt", "");
  if (!last) {
    notify("Nyra", "No original prompt saved yet.");
    return;
  }
  clipboard.writeText(last);
  notify("Nyra", "Original prompt copied to clipboard \u2014 press Ctrl+V (or Cmd+V) to paste it.");
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 340,
    height: 540,
    resizable: false,
    title: "Nyra",
    webPreferences: {
      preload: path.join(__dirname, "settings", "preload.js"),
      contextIsolation: true,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings", "settings.html"));
  settingsWindow.on("closed", () => (settingsWindow = null));
}

// Launching Nyra again should reopen the normal window instead of appearing
// to do nothing when the tray copy is already running.
app.on("second-instance", () => {
  createSettingsWindow();
  setupAutoUpdater();
});

function createTray() {
  tray = new Tray(path.join(__dirname, "settings", "tray-icon.png"));
  tray.setToolTip("Nyra \u2014 Alt+P to compile whatever you're typing");
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  const launchAtStartup = app.isPackaged
    ? app.getLoginItemSettings().openAtLogin
    : false;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Settings\u2026", click: createSettingsWindow },
      { label: "Restore last original prompt", click: restoreLastOriginal },
      { label: `Hotkey: ${HOTKEY}`, enabled: false },
      { type: "separator" },
      {
        label: "Launch at startup",
        type: "checkbox",
        checked: launchAtStartup,
        enabled: app.isPackaged, // only meaningful once actually installed
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
        },
      },
      { type: "separator" },
      { label: "Quit Nyra", click: () => app.quit() },
    ])
  );
}

app.whenReady().then(() => {
  createTray();

  const registered = globalShortcut.register(HOTKEY, handleHotkey);
  if (!registered) {
    notify("Nyra", `Couldn't register ${HOTKEY} \u2014 another app may already be using it.`);
  }

  // Default to launching on login for a real installed copy \u2014 the
  // tray checkbox lets the user turn this off afterward. Guarded by
  // app.isPackaged so `npm start` in development never touches this.
  if (app.isPackaged && !store.has("launchAtStartupSet")) {
    app.setLoginItemSettings({ openAtLogin: true });
    store.set("launchAtStartupSet", true);
  }

  createSettingsWindow();

  if (process.platform === "darwin" && app.dock) app.dock.hide();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", (e) => e?.preventDefault?.());

ipcMain.handle("nyra:get-settings", () => getSettings());
ipcMain.handle("nyra:save-settings", (_event, settings) => {
  store.set(settings);
  return true;
});
ipcMain.handle("nyra:choose-project-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return null;
  store.set("projectFolder", result.filePaths[0]);
  return result.filePaths[0];
});
ipcMain.handle("nyra:clear-project-folder", () => {
  store.delete("projectFolder");
  return true;
});
