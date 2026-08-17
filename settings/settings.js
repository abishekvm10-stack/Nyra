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
