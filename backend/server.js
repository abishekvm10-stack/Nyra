// Nyra's shared backend: a tiny server that holds ONE API key
// privately (yours), so anyone using the app doesn't need their own.
//
// This is a thin relay, not a prompt builder. Current app versions
// build their own system prompt client-side (see prompt-kit.js in the
// desktop app) and send it here as `systemPrompt` — this endpoint just
// forwards it to Groq. That split exists because Render deploys this
// folder as its own root (see backend/README.md), so a module shared
// with the desktop app can't be required from here; letting the
// client own the prompt means prompt changes never need a redeploy.
//
// The block below is a FROZEN fallback for app versions older than
// this change, which only send `targetModel` and expect the server to
// build the prompt itself. It never needs to gain new capability —
// every current install sends its own prompt instead.

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(cors());
app.use(express.json({ limit: "200kb" }));

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// --- legacy fallback (frozen) ----------------------------------------------

const LEGACY_SYSTEM_PROMPT = `You are a prompt compiler. Rewrite the user's rough
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

Sometimes the input will also include snippets from the user's own
project files, labeled "Project context." Use those snippets to make
the Context field specific and accurate, but only when relevant, and
never invent details that aren't in what you were given.`;

const LEGACY_MODEL_FAMILY_HINTS = [
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

function legacyTargetModelGuidance(targetModel) {
  const trimmed = (targetModel || "").trim();
  if (!trimmed || /^generic$/i.test(trimmed)) {
    return "No specific target model was given — use a clear, model-agnostic style with no target-specific syntax.";
  }
  const known = LEGACY_MODEL_FAMILY_HINTS.find((f) => f.match.test(trimmed));
  const base = `The compiled prompt is intended to be pasted into: ${trimmed}.`;
  if (known) return `${base} ${known.hint}`;
  return `${base} You may not have specific tuning data for this exact model — use your best general knowledge of how models in its likely family/lineage tend to behave, and fall back to universal structured-prompting best practices for anything uncertain.`;
}

function legacyBuildSystemPrompt(targetModel) {
  return `${LEGACY_SYSTEM_PROMPT}\n\nTarget model guidance: ${legacyTargetModelGuidance(targetModel)}`;
}

function legacySanitize(text) {
  const roleIndex = text.indexOf("Role:");
  return (roleIndex > 0 ? text.slice(roleIndex) : text).trim();
}

// --- relay -------------------------------------------------------------

const MODEL_MAP = {
  fast: "openai/gpt-oss-20b",
  quality: "qwen/qwen3.6-27b",
};

// Cheap guard now that a client can set the system prompt directly —
// the endpoint was already a general-purpose proxy to anyone reading
// the README (it forwards arbitrary user text to Groq behind only IP
// rate limiting), so this isn't a new trust boundary, just a sanity
// cap on request size.
const MAX_SYSTEM_PROMPT_CHARS = 4000;

// Protects the one shared API key from any single person (or bug)
// exhausting it for everyone else using this same backend.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 requests/minute per IP — adjust based on how many friends actually use this
  message: { error: "Too many requests — wait a moment and try again." },
});

app.get("/", (_req, res) => {
  res.send("Nyra backend is running.");
});

app.post("/compile", limiter, async (req, res) => {
  const { text, tier, systemPrompt, targetModel } = req.body || {};

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: "Server misconfigured: GROQ_API_KEY not set." });
  }
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing 'text' in request body." });
  }
  if (systemPrompt !== undefined && (typeof systemPrompt !== "string" || systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS)) {
    return res.status(400).json({ error: "systemPrompt is missing, not a string, or too long." });
  }

  const usingClientPrompt = Boolean(systemPrompt);
  const finalSystemPrompt = usingClientPrompt ? systemPrompt : legacyBuildSystemPrompt(targetModel);
  const model = MODEL_MAP[tier] || MODEL_MAP.fast;

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1500,
        messages: [
          { role: "system", content: finalSystemPrompt },
          { role: "user", content: text },
        ],
      }),
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      const message = data?.error?.message || "Groq request failed";
      return res.status(groqRes.status).json({ error: message });
    }

    const raw = data.choices[0].message.content.trim();
    // Current app versions re-sanitize on their own (prompt-kit.js's
    // delimiter-aware extraction) once this response gets back to
    // them — only the legacy path needs cleanup done here, since old
    // clients only know the old "Role:"-anchor trick.
    const compiledText = usingClientPrompt ? raw : legacySanitize(raw);
    res.json({ compiledText });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Nyra backend listening on port ${PORT}`);
});
