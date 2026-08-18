const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, Notification, ipcMain, dialog, nativeImage } = require("electron");
const path = require("path");
const Store = require("electron-store");
const { autoUpdater } = require("electron-updater");
const { compilePrompt, getTargetModelLabel } = require("./compiler");
const { getRelevantContext } = require("./context");
const automation = require("./automation");

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

const DEFAULT_HOTKEY = "Alt+P";
const DEFAULT_BACKEND_URL = "https://nyra-pddf.onrender.com";

// Mirrors the agent dropdown in settings.html — kept here so the tray
// submenu offers the same choices without the renderer being open.
const TARGET_AGENTS = [
  { value: "", label: "Generic" },
  { value: "Claude", label: "Claude" },
  { value: "ChatGPT", label: "ChatGPT" },
  { value: "Gemini", label: "Gemini" },
];

// The hotkey currently registered with the OS, which is not always the
// same as the stored preference: a saved combo can stop working if
// another app claims it between sessions, and we fall back rather than
// leaving Nyra with no hotkey at all.
let activeHotkey = null;

function currentHotkey() {
  return activeHotkey || DEFAULT_HOTKEY;
}

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
    hotkey: currentHotkey(),
    // True when the active hotkey isn't the one actually saved — it
    // fell back because the saved combo stopped registering (e.g.
    // claimed by another app between sessions). Settings' status line
    // surfaces this instead of silently showing the fallback as normal.
    hotkeyFallback: activeHotkey !== null && activeHotkey !== store.get("hotkey", DEFAULT_HOTKEY),
    automationEnabled: store.get("automationEnabled", false),
    platform: process.platform,
    targetAgent: store.get("targetAgent", ""),
    targetModelName: store.get("targetModelName", ""),
    apiKey: store.get("apiKey", ""),
    ollamaUrl: store.get("ollamaUrl", "http://localhost:11434"),
    backendUrl: store.get("backendUrl", DEFAULT_BACKEND_URL),
    projectFolder: store.get("projectFolder", ""),
  };
}

// Swaps the global hotkey. Returns a result object instead of throwing
// because a rejected combo is a normal thing a user can pick in
// Settings, not an exceptional condition. On any failure the
// previously working hotkey is restored, so there is never a moment
// where Nyra is running with no way to trigger it.
function registerHotkey(accelerator) {
  const previous = activeHotkey;
  if (previous) globalShortcut.unregister(previous);

  let registered = false;
  let error = null;
  try {
    registered = globalShortcut.register(accelerator, handleHotkey);
    if (!registered) error = `${accelerator} is already in use by another app.`;
  } catch {
    // Electron throws on a malformed accelerator rather than returning false.
    error = `${accelerator} isn't a valid shortcut.`;
  }

  if (registered) {
    activeHotkey = accelerator;
    return { ok: true };
  }

  if (previous && globalShortcut.register(previous, handleHotkey)) {
    activeHotkey = previous;
  }
  return { ok: false, error };
}

const AUTOMATION_MAX_CHARS = 8000; // above this it's a document, not a prompt
const AUTOMATION_POLL_INTERVAL_MS = 50;
const AUTOMATION_POLL_TIMEOUT_MS = 800;

// Polls the clipboard until it differs from `sentinel`, or gives up
// after `timeoutMs`. A unique sentinel (not just "was it empty") is
// what lets this tell "the copy genuinely landed" apart from "the
// clipboard already happened to hold this exact text."
async function waitForClipboardChange(sentinel, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = clipboard.readText();
    if (current !== sentinel) return current;
    await new Promise((resolve) => setTimeout(resolve, AUTOMATION_POLL_INTERVAL_MS));
  }
  return null;
}

function automationUsable(settings) {
  return Boolean(settings.automationEnabled) && process.platform === "win32" && automation.isAvailable();
}

async function handleHotkey() {
  const settings = getSettings();
  if (!settings.provider) {
    notify("Nyra", "No provider set up yet \u2014 open Settings from the tray icon.");
    return;
  }

  const useAutomation = automationUsable(settings);
  let rawText;

  if (useAutomation) {
    const sentinel = `__nyra_sentinel_${Date.now()}__`;
    clipboard.writeText(sentinel);

    try {
      await automation.selectAllAndCopy();
    } catch (err) {
      notify("Nyra \u2014 automation error", String(err.message || err));
      return;
    }

    const captured = await waitForClipboardChange(sentinel, AUTOMATION_POLL_TIMEOUT_MS);
    if (captured === null) {
      notify(
        "Nyra",
        "Nothing was captured \u2014 the focused app may be running as administrator (Windows blocks synthetic input into elevated windows), or nothing was focused. Select your text and press Ctrl+C manually instead."
      );
      return;
    }

    rawText = captured.trim();

    if (rawText.length > AUTOMATION_MAX_CHARS) {
      notify(
        "Nyra",
        `Selected text was ${rawText.length} characters \u2014 that looks like a whole document, not a prompt, so nothing was changed. Select just your prompt and try again.`
      );
      return;
    }
  } else {
    // Manual flow: select text and Ctrl+C yourself first, then the hotkey.
    rawText = clipboard.readText().trim();
  }

  if (!rawText) {
    notify("Nyra", `Copy some text first (Ctrl+C), then press ${currentHotkey()}.`);
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

    if (useAutomation) {
      try {
        await automation.paste();
        notify("Nyra", "Compiled and pasted.");
      } catch (err) {
        // Graceful degradation to today's manual behavior \u2014 the
        // compiled text is still on the clipboard either way.
        notify("Nyra", `Compiled \u2014 press Ctrl+V to paste it. (Auto-paste failed: ${String(err.message || err)})`);
      }
    } else {
      notify("Nyra", "Compiled \u2014 press Ctrl+V to paste it.");
    }
  } catch (err) {
    clipboard.writeText(rawText); // put the original back so nothing is lost
    notify("Nyra \u2014 error", String(err.message || err));
  }
}

// The diagnostic that was missing last time automation broke: a real
// end-to-end test against a known value, with a specific reason on
// failure, instead of "it just doesn't work" discovered days later in
// some random chat box.
async function runAutomationSelfTest() {
  if (process.platform !== "win32") {
    return { ok: false, reason: "Automation is Windows-only right now." };
  }
  if (!automation.isAvailable()) {
    return { ok: false, reason: automation.unavailableReason() || "Automation engine failed to load." };
  }

  const knownText = `nyra-self-test-${Date.now()}`;
  const testWindow = new BrowserWindow({
    width: 320,
    height: 120,
    resizable: false,
    title: "Nyra automation test",
    webPreferences: { contextIsolation: true },
  });
  testWindow.setMenuBarVisibility(false);

  const html = `<!DOCTYPE html><html><body style="margin:0;font-family:sans-serif;background:#14161c;color:#e6e8ec;">
    <input id="t" style="width:100%;box-sizing:border-box;padding:12px;font-size:14px;" value="${knownText}" />
    <script>document.getElementById("t").focus(); document.getElementById("t").select();</script>
  </body></html>`;

  try {
    await testWindow.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    // nut-js sends OS-level input to whatever window the OS currently
    // has in the foreground, which is a different thing from in-page
    // DOM focus — explicitly claim it rather than assuming Electron's
    // default show/focus behavior is enough.
    testWindow.show();
    testWindow.focus();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const sentinel = `__nyra_test_sentinel_${Date.now()}__`;
    clipboard.writeText(sentinel);
    await automation.selectAllAndCopy();

    const captured = await waitForClipboardChange(sentinel, AUTOMATION_POLL_TIMEOUT_MS);
    if (captured === null) {
      return {
        ok: false,
        reason: "Keystrokes were sent but nothing was captured — Windows may be blocking synthetic input (this can happen if Nyra needs administrator rights to reach the focused window).",
      };
    }
    if (captured.trim() !== knownText) {
      return { ok: false, reason: `Captured text didn't match what was expected (got "${captured.trim()}") — something intercepted or altered the keystrokes.` };
    }

    // Prove paste works too, not just copy — they use different code
    // paths and either can fail independently.
    const pasteCheck = `nyra-paste-check-${Date.now()}`;
    clipboard.writeText(pasteCheck);
    await automation.paste();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pasted = await testWindow.webContents.executeJavaScript('document.getElementById("t").value');
    if (pasted !== pasteCheck) {
      return { ok: false, reason: "Copy works but paste didn't land — auto-paste may fail in real use; you can still paste manually with Ctrl+V after compiling." };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  } finally {
    testWindow.destroy();
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
    width: 380,
    height: 640,
    minWidth: 340,
    minHeight: 420,
    resizable: true,
    maximizable: true,
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
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, "settings", "tray-icon.png")
  );
  // macOS menu-bar icons must be marked as template images so the OS renders
  // them monochrome and adapts them to light/dark menu bars and click state;
  // Windows/Linux trays render the icon's real colors and ignore this flag.
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  rebuildTrayMenu();
}

// Also refreshes the hotkey text, so this is what gets called after a
// hotkey change to make the tray reflect it immediately.
function rebuildTrayMenu() {
  if (!tray) return;

  const launchAtStartup = app.isPackaged
    ? app.getLoginItemSettings().openAtLogin
    : false;

  const settings = getSettings();

  tray.setToolTip(`Nyra \u2014 ${currentHotkey()} to compile whatever you're typing`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Settings\u2026", click: createSettingsWindow },
      { label: "Restore last original prompt", click: restoreLastOriginal },
      { type: "separator" },
      // Auto-paste and target agent are the two things that get
      // changed day to day; everything else is set-once. Surfacing
      // them here means normal use never has to open Settings.
      {
        label: "Auto-paste",
        type: "checkbox",
        checked: Boolean(settings.automationEnabled),
        enabled: process.platform === "win32" && automation.isAvailable(),
        click: (item) => {
          store.set("automationEnabled", item.checked);
          notifySettingsChanged();
        },
      },
      {
        label: "Target agent",
        submenu: TARGET_AGENTS.map((agent) => ({
          label: agent.label,
          type: "radio",
          checked: (settings.targetAgent || "") === agent.value,
          click: () => {
            store.set("targetAgent", agent.value);
            store.set("targetModelName", "");
            notifySettingsChanged();
          },
        })),
      },
      { type: "separator" },
      { label: `Hotkey: ${currentHotkey()}`, enabled: false },
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

// A tray change and an open Settings window can disagree about the
// truth otherwise \u2014 rebuild the menu and tell the window to reload.
function notifySettingsChanged() {
  rebuildTrayMenu();
  if (settingsWindow) settingsWindow.webContents.send("nyra:settings-changed");
}

app.whenReady().then(() => {
  const storedHotkey = store.get("hotkey", DEFAULT_HOTKEY);
  let result = registerHotkey(storedHotkey);
  if (!result.ok && storedHotkey !== DEFAULT_HOTKEY) {
    // The saved combo (possibly customized in a prior session) no
    // longer works \u2014 fall back to the default rather than leaving
    // Nyra with no way to trigger it at all.
    result = registerHotkey(DEFAULT_HOTKEY);
  }
  if (!result.ok) {
    notify("Nyra", `Couldn't register ${DEFAULT_HOTKEY} \u2014 another app may already be using it.`);
  } else if (activeHotkey !== storedHotkey) {
    notify("Nyra", `${storedHotkey} is no longer available \u2014 using ${activeHotkey} instead. Change it in Settings.`);
  }

  createTray();

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
  rebuildTrayMenu(); // keep the tray's quick-toggles in step with the window
  return true;
});
// Separate from save-settings: a hotkey needs synchronous validation
// against the OS (globalShortcut.register succeeds or fails right
// there) with the result shown inline, not folded into the generic
// fire-and-forget settings write.
ipcMain.handle("nyra:set-hotkey", (_event, accelerator) => {
  const result = registerHotkey(accelerator);
  if (result.ok) {
    store.set("hotkey", accelerator);
    rebuildTrayMenu();
  }
  return result;
});
ipcMain.handle("nyra:test-automation", () => runAutomationSelfTest());
// Powers the "Try it" box: compiles without touching the clipboard or
// the user's focused app, so they can see what a settings change
// actually does to the output without leaving the window.
ipcMain.handle("nyra:compile-test", async (_event, text) => {
  const settings = getSettings();
  if (!settings.provider) {
    return { ok: false, error: "Pick a provider first." };
  }
  try {
    const projectContext = settings.projectFolder
      ? getRelevantContext(settings.projectFolder, text)
      : "";
    const compiled = await compilePrompt(text, settings, projectContext);
    return { ok: true, compiled, tunedFor: getTargetModelLabel(settings) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
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
