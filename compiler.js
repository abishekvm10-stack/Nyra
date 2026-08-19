// The same compiling logic from the browser-extension prototype,
// ported to run in an Electron main process (plain Node, no chrome.*
// APIs). One function, one job: take rough text + the user's chosen
// provider/tier settings, return a structured prompt.
//
// All actual prompt-building (system prompt, task/agent adaptation,
// injection defense, output sanitizing) lives in prompt-kit.js — this
// file just wires it to each provider's API shape.

const { buildSystemPrompt, wrapUserInput, sanitizeCompiledText, refreshModelKnowledge } = require("./prompt-kit");

// Keeps model-knowledge.json (per-individual-model prompting
// structure — see prompt-kit.js's own header comment) fresher than
// the copy bundled at build time, without needing an app update for
// every newly-researched model. GitHub itself serves the file — no
// new hosting, and it's the same trust boundary the release pipeline
// already relies on.
const MODEL_KNOWLEDGE_URL = "https://raw.githubusercontent.com/abishekvm10-stack/Nyra/main/model-knowledge.json";
const MODEL_KNOWLEDGE_CACHE_KEY = "modelKnowledgeCache";
const MODEL_KNOWLEDGE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

// Called once at app startup (main.js). Two independent steps, each
// allowed to fail silently — this must NEVER throw or delay startup,
// since the app is already fully usable on the bundled copy alone:
//
//   1. Apply whatever's in the local cache immediately, no network —
//      even a slightly stale cached copy is presumably fresher than
//      what shipped with this build, so it's preferred over the
//      bundled data on its own, independent of the TTL below.
//   2. If that cache is missing or older than the TTL, attempt a
//      background fetch; on success, apply it AND re-cache with a
//      fresh timestamp. On any failure (offline, timeout, bad JSON,
//      or prompt-kit's own shape validation rejecting it), do
//      nothing further — whatever step 1 already applied (or the
//      bundled copy, if step 1 had nothing) stays in effect.
async function refreshModelKnowledgeFromRemote(store) {
  const cached = store.get(MODEL_KNOWLEDGE_CACHE_KEY);
  if (cached && cached.data) {
    refreshModelKnowledge(cached.data); // best-effort; a bad cached shape just leaves the bundled copy in place
  }

  const fetchedAt = cached && cached.fetchedAt;
  const isFresh = typeof fetchedAt === "number" && Date.now() - fetchedAt < MODEL_KNOWLEDGE_TTL_MS;
  if (isFresh) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(MODEL_KNOWLEDGE_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) return;

    const json = await res.json();
    const applied = refreshModelKnowledge(json);
    if (applied) {
      store.set(MODEL_KNOWLEDGE_CACHE_KEY, { fetchedAt: Date.now(), data: json });
    }
  } catch {
    // Offline, timed out, or malformed response — silently keep
    // whatever step 1 already applied. Never surfaced to the user;
    // this is a background freshness attempt, not a required step.
  }
}

// Same tiering idea as the extension: local = free + unlimited
// (capped only by your hardware), groq = free but rate-limited,
// paid providers = frontier quality at real cost.
const MODEL_MAP = {
  local: { fast: "llama3.1:8b", quality: "qwen3:32b" },
  "nyra-cloud": { fast: "auto", quality: "auto" }, // actual model choice happens server-side
  groq: { fast: "openai/gpt-oss-20b", quality: "qwen/qwen3.6-27b" },
  openai: { fast: "gpt-4o-mini", quality: "gpt-4.1" },
  anthropic: { fast: "claude-haiku-4-5-20251001", quality: "claude-sonnet-4-6" },
  gemini: { fast: "gemini-flash-latest", quality: "gemini-pro-latest" },
};

// Every provider call uses the same low temperature (consistent,
// predictable compiling rather than creative variance) and the same
// token ceiling. The old code capped Anthropic alone at 500 — tight
// enough to silently truncate a rich compiled prompt — while every
// other provider was uncapped; this makes all providers consistent.
const COMPILE_TEMPERATURE = 0.2;
const COMPILE_MAX_TOKENS = 1500;

// UI collects agent + specific model as two separate fields (see
// settings.html); combined here into one descriptive string since
// buildSystemPrompt() only needs free text to match against, not a
// structured shape. "Other" is a UI category label for "not in our
// list", not part of the description itself — the model name field is
// where the user typed the actual full name (e.g. "Grok 4"), so use
// that alone rather than prefixing "Other". Exported so main.js's
// "Try it" preview can show the same tuned-for label without
// re-deriving this logic a second time.
function getTargetModelLabel({ targetAgent = "", targetModelName = "" } = {}) {
  return targetAgent === "Other"
    ? targetModelName
    : [targetAgent, targetModelName].filter(Boolean).join(" ").trim();
}

async function compilePrompt(rawText, settings, projectContext = "") {
  const { provider, tier, apiKey, ollamaUrl, backendUrl, taskType } = settings;
  if (!provider) throw new Error("No provider selected. Open Settings first.");

  const targetModel = getTargetModelLabel(settings);
  const systemPrompt = buildSystemPrompt(targetModel, taskType);

  const model = MODEL_MAP[provider]?.[tier || "fast"];
  if (!model) throw new Error(`No model configured for ${provider} / ${tier}.`);

  if (provider !== "local" && provider !== "nyra-cloud" && !apiKey) {
    throw new Error(`No API key set for ${provider}. Open Settings to add one.`);
  }
  if (provider === "nyra-cloud" && !backendUrl) {
    throw new Error("No backend URL set for Nyra Cloud. Open Settings to add one.");
  }

  // Only the user's own raw text gets the injection-defense wrapper —
  // project context comes from the user's own selected folder and
  // isn't the untrusted part of the input (arbitrary clipboard content
  // is).
  const wrappedRaw = wrapUserInput(rawText);
  const userMessage = projectContext
    ? `Project context (use only if relevant, otherwise ignore):\n${projectContext}\n\n---\n${wrappedRaw}`
    : wrappedRaw;

  let result;
  switch (provider) {
    case "local":
      result = await callLocal(userMessage, model, ollamaUrl, systemPrompt);
      break;
    case "nyra-cloud":
      result = await callNyraCloud(userMessage, tier || "fast", backendUrl, systemPrompt, targetModel);
      break;
    case "groq":
      result = await callGroq(userMessage, model, apiKey, systemPrompt);
      break;
    case "openai":
      result = await callOpenAI(userMessage, model, apiKey, systemPrompt);
      break;
    case "anthropic":
      result = await callAnthropic(userMessage, model, apiKey, systemPrompt);
      break;
    case "gemini":
      result = await callGemini(userMessage, model, apiKey, systemPrompt);
      break;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
  return sanitizeCompiledText(result);
}

// Nyra Cloud: a shared backend (see backend/README.md) that holds one
// API key server-side, so people using Nyra don't need their own.
// Shares Groq's free-tier rate limit across everyone using the same
// backend — fine for a small group, not a substitute for real scale.
// Sends the fully-built systemPrompt so the backend never needs its
// own copy of the prompt logic (and never needs a redeploy when this
// file changes) — targetModel is still sent alongside for older
// backend deployments that only understand that field.
async function callNyraCloud(rawText, tier, backendUrl, systemPrompt, targetModel) {
  const url = `${backendUrl.replace(/\/$/, "")}/compile`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: rawText, tier, systemPrompt, targetModel }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Nyra Cloud request failed (${res.status}).`);
  }
  return data.compiledText;
}

async function callLocal(rawText, model, baseUrl, systemPrompt) {
  const url = `${(baseUrl || "http://localhost:11434").replace(/\/$/, "")}/api/chat`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: COMPILE_TEMPERATURE },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: rawText },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Local model request failed (${res.status}). Is Ollama running?`);
  }
  const data = await res.json();
  return data.message.content.trim();
}

async function callGroq(rawText, model, apiKey, systemPrompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: COMPILE_TEMPERATURE,
      max_tokens: COMPILE_MAX_TOKENS,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: rawText },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 429) throw new Error("Groq rate limit hit — wait a moment or switch tiers.");
    throw new Error(data?.error?.message || "Groq request failed");
  }
  return data.choices[0].message.content.trim();
}

async function callOpenAI(rawText, model, apiKey, systemPrompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: COMPILE_TEMPERATURE,
      max_tokens: COMPILE_MAX_TOKENS,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: rawText },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "OpenAI request failed");
  return data.choices[0].message.content.trim();
}

async function callAnthropic(rawText, model, apiKey, systemPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      temperature: COMPILE_TEMPERATURE,
      max_tokens: COMPILE_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: rawText }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic request failed");
  return data.content[0].text.trim();
}

async function callGemini(rawText, model, apiKey, systemPrompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: COMPILE_TEMPERATURE, maxOutputTokens: COMPILE_MAX_TOKENS },
        contents: [{ parts: [{ text: rawText }] }],
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gemini request failed");
  return data.candidates[0].content.parts[0].text.trim();
}

module.exports = { compilePrompt, MODEL_MAP, getTargetModelLabel, refreshModelKnowledgeFromRemote };
