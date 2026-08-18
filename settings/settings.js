const MODEL_MAP = {
  local: { fast: "llama3.1:8b", quality: "qwen3:32b" },
  "nyra-cloud": { fast: "auto", quality: "auto" },
  groq: { fast: "openai/gpt-oss-20b", quality: "qwen/qwen3.6-27b" },
  openai: { fast: "gpt-4o-mini", quality: "gpt-4.1" },
  anthropic: { fast: "claude-haiku-4-5-20251001", quality: "claude-sonnet-4-6" },
  gemini: { fast: "gemini-flash-latest", quality: "gemini-pro-latest" },
};

const PROVIDER_LABELS = {
  "nyra-cloud": "Nyra Cloud",
  local: "Local (Ollama)",
  groq: "Groq",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
};

// Just convenience suggestions per agent — always editable/free-text
// regardless, so a model missing from this list (including ones that
// don't exist yet) still works fine.
const MODEL_SUGGESTIONS_BY_AGENT = {
  Claude: ["Sonnet 5", "Opus 5", "Fable 5", "Haiku 4.5"],
  ChatGPT: ["GPT-5", "GPT-4o", "o3"],
  Gemini: ["Gemini 3 Pro", "Gemini 3 Flash"],
};

// Named keys accelerators accept beyond plain letters/digits/function
// keys. Anything not covered here (punctuation, media keys, etc.)
// isn't offered — keeping the recorder simple and predictable rather
// than trying to cover every possible key on every layout.
const CODE_TO_ACCELERATOR_KEY = {
  Space: "Space", Tab: "Tab", Escape: "Esc", Backspace: "Backspace",
  Delete: "Delete", Insert: "Insert", Enter: "Return",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
};

const $ = (id) => document.getElementById(id);

const providerRadios = document.querySelectorAll('input[name="provider"]');
const tierSelect = $("tier");
const targetAgentSelect = $("targetAgent");
const targetModelNameInput = $("targetModelName");
const targetModelNameSuggestions = $("targetModelNameSuggestions");
const apiKeyInput = $("apiKey");
const apiKeyField = $("apiKeyField");
const groqHint = $("groqHint");
const localFields = $("localFields");
const ollamaUrlInput = $("ollamaUrl");
const cloudFields = $("cloudFields");
const backendUrlInput = $("backendUrl");
const modelPreviewEl = $("modelPreview");
const chooseFolderButton = $("chooseFolder");
const clearFolderButton = $("clearFolder");
const projectFolderPathEl = $("projectFolderPath");
const hotkeyField = $("hotkeyField");
const hotkeyKeys = $("hotkeyKeys");
const hotkeySideText = $("hotkeySideText");
const hotkeyHint = $("hotkeyHint");
const automationSection = $("automationSection");
const automationUnavailableHint = $("automationUnavailableHint");
const automationEnabledCheckbox = $("automationEnabled");
const testAutomationButton = $("testAutomation");
const automationTestResultEl = $("automationTestResult");
const saveIndicator = $("saveIndicator");
const statusDot = $("statusDot");
const statusTitle = $("statusTitle");
const statusDetail = $("statusDetail");
const tryItInput = $("tryItInput");
const tryItRun = $("tryItRun");
const tryItResult = $("tryItResult");
const tryItMeta = $("tryItMeta");
const saveHistoryCheckbox = $("saveHistory");
const historyListEl = $("historyList");
const historyEmptyEl = $("historyEmptyState");
const clearHistoryButton = $("clearHistory");
const launchAtStartupCheckbox = $("launchAtStartup");
const launchAtStartupSub = $("launchAtStartupSub");
const userDataPathEl = $("userDataPath");
const checkUpdatesButton = $("checkUpdates");
const updateCheckResultEl = $("updateCheckResult");

let currentSettings = {};
let listeningForHotkey = false;

/* ---------- provider tiles ---------- */

function getProvider() {
  return [...providerRadios].find((r) => r.checked)?.value || "";
}

function setProvider(value) {
  providerRadios.forEach((r) => (r.checked = r.value === value));
}

/* ---------- sidebar navigation ---------- */

function wireNav() {
  const navItems = [...document.querySelectorAll(".nav-item")];
  const views = document.querySelectorAll(".view");

  function activate(item) {
    navItems.forEach((n) => n.classList.toggle("active", n === item));
    views.forEach((v) => v.classList.toggle("active", v.dataset.view === item.dataset.view));
    if (item.dataset.view === "history") loadHistory();
  }

  navItems.forEach((item, i) => {
    item.addEventListener("click", () => activate(item));
    item.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const next = navItems[(i + (e.key === "ArrowDown" ? 1 : -1) + navItems.length) % navItems.length];
      next.focus();
      activate(next);
    });
  });
}

wireNav();

/* ---------- history ---------- */

function formatHistoryTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function iconButton(label, glyph, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.textContent = glyph;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderHistoryEntry(entry) {
  const card = document.createElement("div");
  card.className = "history-card";

  const header = document.createElement("div");
  header.className = "history-card-header";

  const meta = document.createElement("span");
  meta.className = "history-meta";
  meta.textContent = [formatHistoryTime(entry.at), entry.agentLabel].filter(Boolean).join(" · ");

  const actions = document.createElement("div");
  actions.className = "history-actions";
  actions.append(
    iconButton("Copy compiled prompt", "⧉", () => window.nyra.copyToClipboard(entry.compiled)),
    iconButton("Copy original prompt", "↺", () => window.nyra.copyToClipboard(entry.original)),
    iconButton("Delete", "✕", async () => {
      await window.nyra.deleteHistoryEntry(entry.id);
      loadHistory();
    })
  );

  header.append(meta, actions);

  const original = document.createElement("p");
  original.className = "history-original";
  original.textContent = entry.original;

  const compiled = document.createElement("p");
  compiled.className = "history-compiled";
  compiled.textContent = entry.compiled;

  card.append(header, original, compiled);
  return card;
}

async function loadHistory() {
  const entries = await window.nyra.getHistory();
  historyListEl.innerHTML = "";

  if (currentSettings.saveHistory === false) {
    historyEmptyEl.textContent = "History is turned off — enable “Save history” in General to start keeping a log.";
    historyEmptyEl.classList.remove("hidden");
    return;
  }
  if (!entries.length) {
    historyEmptyEl.textContent = "Nothing compiled yet.";
    historyEmptyEl.classList.remove("hidden");
    return;
  }
  historyEmptyEl.classList.add("hidden");
  entries.forEach((entry) => historyListEl.appendChild(renderHistoryEntry(entry)));
}

clearHistoryButton.addEventListener("click", async () => {
  await window.nyra.clearHistory();
  loadHistory();
});

saveHistoryCheckbox.addEventListener("change", () => save({ immediate: true }));

/* ---------- hotkey rendering ---------- */

function codeToAcceleratorKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_TO_ACCELERATOR_KEY[code] || null;
}

// "CommandOrControl" is the right thing to STORE (it resolves per
// platform at registration) but a useless thing to show a user — they
// want to see the key they actually press.
function prettyKeyName(part) {
  if (part !== "CommandOrControl") return part;
  return currentSettings.platform === "darwin" ? "Cmd" : "Ctrl";
}

function renderHotkeyKeys(accelerator) {
  hotkeyKeys.innerHTML = "";
  const parts = (accelerator || "").split("+").filter(Boolean);
  parts.forEach((part, i) => {
    if (i > 0) {
      const plus = document.createElement("span");
      plus.className = "plus";
      plus.textContent = "+";
      hotkeyKeys.appendChild(plus);
    }
    const kbd = document.createElement("kbd");
    kbd.textContent = prettyKeyName(part);
    hotkeyKeys.appendChild(kbd);
  });
}

function setHotkeyHint(text, color) {
  hotkeyHint.textContent = text;
  hotkeyHint.style.color = color || "#6b7383";
}

function stopListening() {
  listeningForHotkey = false;
  hotkeyField.classList.remove("listening");
  hotkeySideText.textContent = "Click to change";
  renderHotkeyKeys(currentSettings.hotkey);
}

hotkeyField.addEventListener("click", () => {
  listeningForHotkey = true;
  hotkeyField.classList.add("listening");
  hotkeyKeys.innerHTML = "";
  hotkeySideText.textContent = "Press your combo…";
  setHotkeyHint("Include at least one modifier (Ctrl, Alt, or Shift).");
});

hotkeyField.addEventListener("blur", () => {
  if (listeningForHotkey) stopListening();
});

hotkeyField.addEventListener("keydown", async (e) => {
  if (!listeningForHotkey) return;
  e.preventDefault();

  if (e.key === "Escape") {
    stopListening();
    setHotkeyHint("");
    return;
  }
  // A modifier held alone isn't a usable combo yet — wait for a real
  // key on top of it.
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;

  const key = codeToAcceleratorKey(e.code);
  if (!key) {
    setHotkeyHint("That key can't be used — try a letter, number, or function key.", "#e5484d");
    return;
  }

  const modifiers = [];
  if (e.ctrlKey || e.metaKey) modifiers.push("CommandOrControl");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");

  if (modifiers.length === 0) {
    setHotkeyHint("Needs at least one modifier — a bare key would be captured in every app.", "#e5484d");
    return;
  }

  const accelerator = [...modifiers, key].join("+");
  const result = await window.nyra.setHotkey(accelerator);

  if (result.ok) {
    currentSettings.hotkey = accelerator;
    stopListening();
    setHotkeyHint("");
    flashSaved();
    refreshDerivedUI();
  } else {
    hotkeyKeys.innerHTML = "";
    setHotkeyHint(result.error || "That combo didn't register — try another.", "#e5484d");
  }
});

/* ---------- auto-save ---------- */

let saveTimer = null;
let savedFlashTimer = null;

function flashSaved() {
  saveIndicator.textContent = "Saved";
  saveIndicator.style.color = "#6fcf97";
  clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => {
    saveIndicator.textContent = "Changes save as you make them.";
    saveIndicator.style.color = "#6b7383";
  }, 1600);
}

function collectSettings() {
  return {
    provider: getProvider(),
    tier: tierSelect.value,
    targetAgent: targetAgentSelect.value,
    targetModelName: targetModelNameInput.value.trim(),
    automationEnabled: automationEnabledCheckbox.checked,
    saveHistory: saveHistoryCheckbox.checked,
    apiKey: apiKeyInput.value.trim(),
    ollamaUrl: ollamaUrlInput.value.trim() || "http://localhost:11434",
    backendUrl: backendUrlInput.value.trim(),
  };
}

// Text fields debounce so we aren't writing on every keystroke;
// selects and toggles commit immediately since they're discrete.
async function save({ immediate = false } = {}) {
  clearTimeout(saveTimer);
  const run = async () => {
    const values = collectSettings();
    Object.assign(currentSettings, values);
    await window.nyra.saveSettings(values);
    flashSaved();
    refreshDerivedUI();
  };
  if (immediate) return run();
  saveTimer = setTimeout(run, 400);
}

/* ---------- derived UI (status line + summaries) ---------- */

function providerLabel() {
  return PROVIDER_LABELS[currentSettings.provider] || "No provider";
}

function refreshStatusLine() {
  const hasProvider = Boolean(currentSettings.provider);
  const needsKey =
    hasProvider &&
    currentSettings.provider !== "local" &&
    currentSettings.provider !== "nyra-cloud" &&
    !currentSettings.apiKey;
  const needsBackend =
    currentSettings.provider === "nyra-cloud" && !currentSettings.backendUrl;

  let dot = "ready";
  let title = "Ready";

  if (currentSettings.hotkeyFallback) {
    dot = "warn";
    title = "Hotkey unavailable";
    statusDetail.textContent = `Saved combo taken — using ${currentSettings.hotkey} instead`;
  } else if (!hasProvider) {
    dot = "setup";
    title = "Needs setup";
    statusDetail.textContent = "Pick a provider to start";
  } else if (needsKey) {
    dot = "setup";
    title = "Needs API key";
    statusDetail.textContent = `${providerLabel()} needs a key`;
  } else if (needsBackend) {
    dot = "setup";
    title = "Needs backend URL";
    statusDetail.textContent = "Nyra Cloud needs its URL";
  } else {
    const bits = [providerLabel(), currentSettings.hotkey];
    if (currentSettings.automationEnabled) bits.push("Auto-paste on");
    statusDetail.textContent = bits.filter(Boolean).join(" · ");
  }

  statusDot.className = `status-dot ${dot}`;
  statusTitle.textContent = title;
}

function refreshDerivedUI() {
  refreshStatusLine();
}

/* ---------- provider-dependent fields ---------- */

function updateFieldVisibility() {
  const provider = getProvider();
  const isLocal = provider === "local";
  const isCloud = provider === "nyra-cloud";
  localFields.classList.toggle("hidden", !isLocal);
  cloudFields.classList.toggle("hidden", !isCloud);
  apiKeyField.classList.toggle("hidden", isLocal || isCloud);
  groqHint.classList.toggle("hidden", provider !== "groq");
}

function updateModelPreview() {
  const provider = getProvider();
  if (provider === "nyra-cloud") {
    modelPreviewEl.textContent = "Model choice happens on the shared backend.";
    return;
  }
  const model = MODEL_MAP[provider]?.[tierSelect.value];
  modelPreviewEl.textContent = model ? `Uses: ${model}` : "";
}

function updateTargetModelField() {
  const agent = targetAgentSelect.value;
  const suggestions = MODEL_SUGGESTIONS_BY_AGENT[agent] || [];
  targetModelNameSuggestions.innerHTML = suggestions
    .map((m) => `<option value="${m}"></option>`)
    .join("");

  const isGeneric = agent === "";
  targetModelNameInput.disabled = isGeneric;
  targetModelNameInput.placeholder = isGeneric
    ? "Pick an agent above first"
    : agent === "Other"
    ? "Type the agent and model, e.g. “Grok 4”"
    : "Pick a suggestion or type a model name…";
}

function updateProjectFolderDisplay(folderPath) {
  currentSettings.projectFolder = folderPath || "";
  projectFolderPathEl.textContent = folderPath
    ? `Connected: ${folderPath}`
    : "No folder connected.";
  clearFolderButton.classList.toggle("hidden", !folderPath);
  refreshDerivedUI();
}

/* ---------- events ---------- */

providerRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    updateFieldVisibility();
    updateModelPreview();
    save({ immediate: true });
  });
});
tierSelect.addEventListener("change", () => {
  updateModelPreview();
  save({ immediate: true });
});
targetAgentSelect.addEventListener("change", () => {
  targetModelNameInput.value = "";
  updateTargetModelField();
  save({ immediate: true });
});
automationEnabledCheckbox.addEventListener("change", () => save({ immediate: true }));

[targetModelNameInput, apiKeyInput, ollamaUrlInput, backendUrlInput].forEach((el) => {
  el.addEventListener("input", () => save());
});

testAutomationButton.addEventListener("click", async () => {
  automationTestResultEl.textContent = "Testing… don't touch the keyboard for a moment.";
  automationTestResultEl.style.color = "#6b7383";
  testAutomationButton.disabled = true;

  const result = await window.nyra.testAutomation();
  testAutomationButton.disabled = false;

  automationTestResultEl.textContent = result.ok
    ? "Passed — automation works on this machine."
    : `Failed: ${result.reason}`;
  automationTestResultEl.style.color = result.ok ? "#6fcf97" : "#e5484d";
});

tryItRun.addEventListener("click", async () => {
  const text = tryItInput.value.trim() || tryItInput.placeholder;
  tryItRun.disabled = true;
  tryItRun.textContent = "Compiling…";
  tryItResult.classList.remove("hidden");
  tryItResult.textContent = "";
  tryItResult.style.color = "#6b7383";
  tryItMeta.classList.add("hidden");

  const result = await window.nyra.compileTest(text);

  tryItRun.disabled = false;
  tryItRun.textContent = "Compile";

  if (result.ok) {
    tryItResult.textContent = result.compiled;
    tryItResult.style.color = "#c3c9d3";
    tryItMeta.textContent = result.tunedFor
      ? `Tuned for ${result.tunedFor} — switch agent above to compare`
      : "No target agent set — generic output";
    tryItMeta.classList.remove("hidden");
  } else {
    tryItResult.textContent = result.error;
    tryItResult.style.color = "#e5484d";
  }
});

tryItInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryItRun.click();
});

chooseFolderButton.addEventListener("click", async () => {
  const folderPath = await window.nyra.chooseProjectFolder();
  if (folderPath) updateProjectFolderDisplay(folderPath);
});

clearFolderButton.addEventListener("click", async () => {
  await window.nyra.clearProjectFolder();
  updateProjectFolderDisplay(null);
});

$("openSource").addEventListener("click", () => {
  window.nyra.openExternal("https://github.com/abishekvm10-stack/Nyra");
});

$("openDataDir").addEventListener("click", () => window.nyra.openDataDir());

checkUpdatesButton.addEventListener("click", async () => {
  updateCheckResultEl.textContent = "Checking…";
  checkUpdatesButton.disabled = true;
  const result = await window.nyra.checkForUpdates();
  checkUpdatesButton.disabled = false;
  updateCheckResultEl.textContent = result.ok
    ? "Checking in the background — you'll be notified if an update is found."
    : result.reason;
});

launchAtStartupCheckbox.addEventListener("change", async () => {
  await window.nyra.setLaunchAtStartup(launchAtStartupCheckbox.checked);
});

/* ---------- boot ---------- */

async function loadSettings() {
  const settings = await window.nyra.getSettings();
  currentSettings = { ...settings };

  setProvider(settings.provider || "");
  tierSelect.value = settings.tier || "fast";
  targetAgentSelect.value = settings.targetAgent || "";
  targetModelNameInput.value = settings.targetModelName || "";
  apiKeyInput.value = settings.apiKey || "";
  ollamaUrlInput.value = settings.ollamaUrl || "http://localhost:11434";
  backendUrlInput.value = settings.backendUrl || "";

  const automationSupported = settings.platform === "win32";
  automationSection.classList.toggle("hidden", !automationSupported);
  automationUnavailableHint.classList.toggle("hidden", automationSupported);
  automationEnabledCheckbox.checked = automationSupported && Boolean(settings.automationEnabled);
  saveHistoryCheckbox.checked = settings.saveHistory !== false;

  $("appVersion").textContent = settings.appVersion ? `v${settings.appVersion}` : "";
  userDataPathEl.textContent = settings.userDataPath || "";

  launchAtStartupCheckbox.checked = Boolean(settings.launchAtStartup);
  launchAtStartupCheckbox.disabled = !settings.packaged;
  launchAtStartupSub.textContent = settings.packaged
    ? "Opens Nyra automatically when you log in"
    : "Only available in the installed app, not in development";

  renderHotkeyKeys(settings.hotkey);
  updateTargetModelField();
  updateFieldVisibility();
  updateModelPreview();
  updateProjectFolderDisplay(settings.projectFolder || null);
  refreshDerivedUI();
}

// The tray can change auto-paste and the target agent while this
// window is open — reload rather than let the two disagree.
window.nyra.onSettingsChanged(() => loadSettings());

loadSettings();
