// The same compiling logic from the browser-extension prototype,
// ported to run in an Electron main process (plain Node, no chrome.*
// APIs). One function, one job: take rough text + the user's chosen
// provider/tier settings, return a structured prompt.

const SYSTEM_PROMPT = `You are a prompt compiler. Rewrite the user's rough
input into a structured, model-ready prompt using exactly these five
labeled fields, each on its own line:

Role: <who the AI should act as>
Context: <the concrete situation, filled in from what the user gave you>
Task: <the specific action to perform>
Constraints: <format, tone, length, or content rules>
Output Format: <exactly what the response should look like>

Your response must start with "Role:" as the very first characters,
with no punctuation, dash, bullet, or repeated fragment of the user's
original input before it. Do not echo or quote any part of the raw
input outside of the five fields themselves. Only output those five
fields. Do not add commentary before or after. If the user's input is
missing a detail, make the most reasonable assumption rather than
leaving a field vague.

Sometimes you will also be given snippets from the user's own project
files, labeled "Project context." Use those snippets to make the
Context field specific and accurate \u2014 real names, terms, and details
from the snippets instead of generic phrasing \u2014 but only when they're
actually relevant to the request. Never invent details that aren't in
either the user's input or the provided project context, and ignore
the project context entirely if it doesn't relate to the request.`;

// Hints for well-known model families, matched by substring against
// whatever the user typed into the free-text "target model" field.
// Deliberately NOT a list of every specific model (Sonnet 5, GPT-5,
// etc.) — that list would need a code update every time a provider
// ships or renames a model (this bit us once already with Groq's
// Llama 3.1/3.3 deprecation). Family-level hints stay valid across
// model versions, and getTargetModelGuidance() below falls back to
// the compiling model's own knowledge for anything unrecognized,
// including models that don't exist yet.
const KNOWN_MODEL_FAMILY_HINTS = [
  {
    match: /claude/i,
    hint: "This is a Claude-family model. It follows XML-style tags well (e.g. <instructions>, <context>, <criteria>) and handles nuanced, clearly-reasoned instructions gracefully. Keep the five labeled fields, and use such tags inside a field's value where it adds clarity.",
  },
  {
    match: /gpt|chatgpt|openai|^o[1-9](\D|$)/i,
    hint: "This is a GPT/ChatGPT-family model. It responds well to direct, explicit instructions and Markdown-formatted structure. Keep the five labeled fields, and make the Output Format field explicit about any Markdown structure expected in the response.",
  },
  {
    match: /gemini/i,
    hint: "This is a Gemini-family model. It benefits from concrete context and unambiguous, step-by-step task instructions stated plainly. Keep the five labeled fields, and spell out multi-step tasks as an explicit sequence.",
  },
  {
    match: /llama|qwen|mistral|deepseek|phi-|ollama/i,
    hint: "This is likely a smaller open-weight model. Favor short, explicit, unambiguous instructions over nuance or implication — don't rely on the model inferring intent it isn't told directly.",
  },
];

function getTargetModelGuidance(targetModel) {
  const trimmed = (targetModel || "").trim();
  if (!trimmed || /^generic$/i.test(trimmed)) {
    return "No specific target model was given — use a clear, model-agnostic style with no target-specific syntax.";
  }
  const known = KNOWN_MODEL_FAMILY_HINTS.find((f) => f.match.test(trimmed));
  const base = `The compiled prompt is intended to be pasted into: ${trimmed}.`;
  if (known) return `${base} ${known.hint}`;
  return `${base} You may not have specific tuning data for this exact model — use your best general knowledge of how models in its likely family/lineage tend to behave (instruction style, structure preferences, verbosity), and fall back to universal structured-prompting best practices for anything uncertain.`;
}

function getSystemPrompt(targetModel) {
  return `${SYSTEM_PROMPT}\n\nTarget model guidance: ${getTargetModelGuidance(targetModel)}`;
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

async function compilePrompt(rawText, settings, projectContext = "") {
  const { provider, tier, targetAgent = "", targetModelName = "", apiKey, ollamaUrl, backendUrl } = settings;
  if (!provider) throw new Error("No provider selected. Open Settings first.");

  // UI collects agent + specific model as two separate fields (see
  // settings.html); combined here into one descriptive string since
  // getTargetModelGuidance() below only needs free text to match
  // against, not a structured shape. "Other" is a UI category label
  // for "not in our list", not part of the description itself — the
  // model name field is where the user typed the actual full name
  // (e.g. "Grok 4"), so use that alone rather than prefixing "Other".
  const targetModel =
    targetAgent === "Other"
      ? targetModelName
      : [targetAgent, targetModelName].filter(Boolean).join(" ").trim();

  const model = MODEL_MAP[provider]?.[tier || "fast"];
  if (!model) throw new Error(`No model configured for ${provider} / ${tier}.`);

  if (provider !== "local" && provider !== "nyra-cloud" && !apiKey) {
    throw new Error(`No API key set for ${provider}. Open Settings to add one.`);
  }
  if (provider === "nyra-cloud" && !backendUrl) {
    throw new Error("No backend URL set for Nyra Cloud. Open Settings to add one.");
  }

  const userMessage = projectContext
    ? `Project context (use only if relevant, otherwise ignore):\n${projectContext}\n\n---\nUser's rough prompt: ${rawText}`
    : rawText;

  let result;
  switch (provider) {
    case "local":
      result = await callLocal(userMessage, model, ollamaUrl, targetModel);
      break;
    case "nyra-cloud":
      result = await callNyraCloud(userMessage, tier || "fast", backendUrl, targetModel);
      break;
    case "groq":
      result = await callGroq(userMessage, model, apiKey, targetModel);
      break;
    case "openai":
      result = await callOpenAI(userMessage, model, apiKey, targetModel);
      break;
    case "anthropic":
      result = await callAnthropic(userMessage, model, apiKey, targetModel);
      break;
    case "gemini":
      result = await callGemini(userMessage, model, apiKey, targetModel);
      break;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
  return sanitizeCompiledText(result);
}

// Nyra Cloud: a shared backend (see backend/README.md) that holds one
// API key server-side, so people using Nyra don't need their own.
// Shares Groq's free-tier rate limit across everyone using the same
// backend \u2014 fine for a small group, not a substitute for real scale.
async function callNyraCloud(rawText, tier, backendUrl, targetModel) {
  const url = `${backendUrl.replace(/\/$/, "")}/compile`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: rawText, tier, targetModel }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Nyra Cloud request failed (${res.status}).`);
  }
  return data.compiledText;
}

// Safety net independent of model behavior: no matter what stray
// character, echoed fragment, or encoding artifact (e.g. a mis-decoded
// dash showing up as "\u00e2") a model might prepend, this guarantees
// the text the user actually sees always starts cleanly at "Role:".
function sanitizeCompiledText(text) {
  const roleIndex = text.indexOf("Role:");
  const trimmed = roleIndex > 0 ? text.slice(roleIndex) : text;
  return trimmed.trim();
}

async function callLocal(rawText, model, baseUrl, targetModel) {
  const url = `${(baseUrl || "http://localhost:11434").replace(/\/$/, "")}/api/chat`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: getSystemPrompt(targetModel) },
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

async function callGroq(rawText, model, apiKey, targetModel) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: getSystemPrompt(targetModel) },
        { role: "user", content: rawText },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 429) throw new Error("Groq rate limit hit \u2014 wait a moment or switch tiers.");
    throw new Error(data?.error?.message || "Groq request failed");
  }
  return data.choices[0].message.content.trim();
}

async function callOpenAI(rawText, model, apiKey, targetModel) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: getSystemPrompt(targetModel) },
        { role: "user", content: rawText },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "OpenAI request failed");
  return data.choices[0].message.content.trim();
}

async function callAnthropic(rawText, model, apiKey, targetModel) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      system: getSystemPrompt(targetModel),
      messages: [{ role: "user", content: rawText }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic request failed");
  return data.content[0].text.trim();
}

async function callGemini(rawText, model, apiKey, targetModel) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: getSystemPrompt(targetModel) }] },
        contents: [{ parts: [{ text: rawText }] }],
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gemini request failed");
  return data.candidates[0].content.parts[0].text.trim();
}

module.exports = { compilePrompt, MODEL_MAP };
