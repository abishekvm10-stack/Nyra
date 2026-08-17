const MODEL_MAP = {
  local: { fast: "llama3.1:8b", quality: "qwen3:32b" },
  "nyra-cloud": { fast: "auto", quality: "auto" },
  groq: { fast: "openai/gpt-oss-20b", quality: "qwen/qwen3.6-27b" },
  openai: { fast: "gpt-4o-mini", quality: "gpt-4.1" },
  anthropic: { fast: "claude-haiku-4-5-20251001", quality: "claude-sonnet-4-6" },
  gemini: { fast: "gemini-flash-latest", quality: "gemini-pro-latest" },
};

const providerSelect = document.getElementById("provider");
const tierSelect = document.getElementById("tier");
const targetAgentSelect = document.getElementById("targetAgent");
const targetModelNameInput = document.getElementById("targetModelName");
const targetModelNameSuggestions = document.getElementById("targetModelNameSuggestions");

// Just convenience suggestions per agent — always editable/free-text
// regardless, so a model missing from this list (including ones that
// don't exist yet) still works fine.
const MODEL_SUGGESTIONS_BY_AGENT = {
  Claude: ["Sonnet 5", "Opus 5", "Fable 5", "Haiku 4.5"],
  ChatGPT: ["GPT-5", "GPT-4o", "o3"],
  Gemini: ["Gemini 3 Pro", "Gemini 3 Flash"],
};

const apiKeyInput = document.getElementById("apiKey");
const apiKeyField = document.getElementById("apiKeyField");
const groqHint = document.getElementById("groqHint");
const localFields = document.getElementById("localFields");
const ollamaUrlInput = document.getElementById("ollamaUrl");
const cloudFields = document.getElementById("cloudFields");
const backendUrlInput = document.getElementById("backendUrl");
const saveButton = document.getElementById("save");
const statusEl = document.getElementById("status");
const modelPreviewEl = document.getElementById("modelPreview");
const chooseFolderButton = document.getElementById("chooseFolder");
const clearFolderButton = document.getElementById("clearFolder");
const projectFolderPathEl = document.getElementById("projectFolderPath");
const hotkeyInput = document.getElementById("hotkeyInput");
const hotkeyHint = document.getElementById("hotkeyHint");

// Named keys accelerators accept beyond plain letters/digits/function
// keys. Anything not covered here (punctuation, media keys, etc.)
// isn't offered — keeping the recorder simple and predictable rather
// than trying to cover every possible key on every layout.
const CODE_TO_ACCELERATOR_KEY = {
  Space: "Space",
  Tab: "Tab",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Enter: "Return",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

// Derived from e.code, not e.key: e.key reflects what the held
// modifiers turn the key INTO (e.g. Alt can shift what a key reports
// on some layouts), while e.code identifies the physical key
// regardless of modifiers — the correct source for a shortcut.
function codeToAcceleratorKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_TO_ACCELERATOR_KEY[code] || null;
}

function setHotkeyHint(text, color) {
  hotkeyHint.textContent = text;
  hotkeyHint.style.color = color;
}

function updateFieldVisibility() {
  const provider = providerSelect.value;
  const isLocal = provider === "local";
  const isCloud = provider === "nyra-cloud";
  localFields.classList.toggle("hidden", !isLocal);
  cloudFields.classList.toggle("hidden", !isCloud);
  apiKeyField.classList.toggle("hidden", isLocal || isCloud);
  groqHint.classList.toggle("hidden", provider !== "groq");
}

function updateModelPreview() {
  const provider = providerSelect.value;
  const tier = tierSelect.value;
  if (provider === "nyra-cloud") {
    modelPreviewEl.textContent = "Model choice happens on the shared backend.";
    return;
  }
  const model = MODEL_MAP[provider]?.[tier];
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
  if (folderPath) {
    projectFolderPathEl.textContent = `Connected: ${folderPath}`;
    clearFolderButton.classList.remove("hidden");
  } else {
    projectFolderPathEl.textContent = "No folder connected.";
    clearFolderButton.classList.add("hidden");
  }
}

providerSelect.addEventListener("change", () => {
  updateFieldVisibility();
  updateModelPreview();
});
tierSelect.addEventListener("change", updateModelPreview);

targetAgentSelect.addEventListener("change", () => {
  targetModelNameInput.value = "";
  updateTargetModelField();
});

hotkeyInput.addEventListener("focus", () => {
  setHotkeyHint("Press your combo now…", "#6b7383");
});

hotkeyInput.addEventListener("blur", () => {
  setHotkeyHint("Click the field above, then press the combo you want.", "#6b7383");
});

hotkeyInput.addEventListener("keydown", async (e) => {
  e.preventDefault();

  // A modifier held alone isn't a usable combo yet — wait for a real
  // key on top of it.
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;

  const key = codeToAcceleratorKey(e.code);
  if (!key) {
    setHotkeyHint("That key can't be used as a shortcut here — try a letter, number, or function key.", "#e5484d");
    return;
  }

  const modifiers = [];
  if (e.ctrlKey || e.metaKey) modifiers.push("CommandOrControl");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");

  if (modifiers.length === 0) {
    setHotkeyHint("Include at least one modifier (Ctrl, Alt, or Shift) — a bare key would be captured everywhere, in every app.", "#e5484d");
    return;
  }

  const accelerator = [...modifiers, key].join("+");
  setHotkeyHint("Checking…", "#6b7383");

  const result = await window.nyra.setHotkey(accelerator);
  if (result.ok) {
    hotkeyInput.value = accelerator;
    setHotkeyHint("Saved — this hotkey is active now.", "#6fcf97");
  } else {
    setHotkeyHint(result.error || "That combo didn't register — try another.", "#e5484d");
  }
});

chooseFolderButton.addEventListener("click", async () => {
  const folderPath = await window.nyra.chooseProjectFolder();
  if (folderPath) updateProjectFolderDisplay(folderPath);
});

clearFolderButton.addEventListener("click", async () => {
  await window.nyra.clearProjectFolder();
  updateProjectFolderDisplay(null);
});

async function loadSettings() {
  const settings = await window.nyra.getSettings();
  providerSelect.value = settings.provider || "";
  tierSelect.value = settings.tier || "fast";
  targetAgentSelect.value = settings.targetAgent || "";
  targetModelNameInput.value = settings.targetModelName || "";
  updateTargetModelField();
  hotkeyInput.value = settings.hotkey || "";
  apiKeyInput.value = settings.apiKey || "";
  ollamaUrlInput.value = settings.ollamaUrl || "http://localhost:11434";
  backendUrlInput.value = settings.backendUrl || "";
  updateFieldVisibility();
  updateModelPreview();
  updateProjectFolderDisplay(settings.projectFolder || null);
}

saveButton.addEventListener("click", async () => {
  const provider = providerSelect.value;
  const tier = tierSelect.value;
  const targetAgent = targetAgentSelect.value;
  const targetModelName = targetModelNameInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const ollamaUrl = ollamaUrlInput.value.trim() || "http://localhost:11434";
  const backendUrl = backendUrlInput.value.trim();

  if (!provider) {
    statusEl.textContent = "Pick a provider.";
    statusEl.style.color = "#e5484d";
    return;
  }
  if (provider !== "local" && provider !== "nyra-cloud" && !apiKey) {
    statusEl.textContent = "Enter an API key for this provider.";
    statusEl.style.color = "#e5484d";
    return;
  }
  if (provider === "nyra-cloud" && !backendUrl) {
    statusEl.textContent = "Enter the Nyra Cloud backend URL.";
    statusEl.style.color = "#e5484d";
    return;
  }

  await window.nyra.saveSettings({ provider, tier, targetAgent, targetModelName, apiKey, ollamaUrl, backendUrl });
  statusEl.textContent = "Saved. Nyra is ready \u2014 Alt+P anywhere.";
  statusEl.style.color = "#6fcf97";
});

loadSettings();
