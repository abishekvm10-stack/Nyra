// Nyra's shared backend: a tiny server that holds ONE API key
// privately (yours), so anyone using the app doesn't need their own.
// The desktop app sends already-compiled context; this server's only
// job is the actual model call, using a key that never reaches the
// client.

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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

Sometimes the input will also include snippets from the user's own
project files, labeled "Project context." Use those snippets to make
the Context field specific and accurate, but only when relevant, and
never invent details that aren't in what you were given.`;

// Hints for well-known model families, matched by substring against
// whatever the desktop app sends as targetModel. Deliberately NOT a
// list of every specific model version — that needs a redeploy every
// time a provider ships/renames a model. Family-level hints stay
// valid across versions; getTargetModelGuidance() falls back to the
// compiling model's own knowledge for anything unrecognized,
// including future models. Keep this in sync with compiler.js's copy.
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

const MODEL_MAP = {
  fast: "openai/gpt-oss-20b",
  quality: "qwen/qwen3.6-27b",
};

function sanitizeCompiledText(text) {
  const roleIndex = text.indexOf("Role:");
  const trimmed = roleIndex > 0 ? text.slice(roleIndex) : text;
  return trimmed.trim();
}

// Protects the one shared API key from any single person (or bug)
// exhausting it for everyone else using this same backend.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 requests/minute per IP \u2014 adjust based on how many friends actually use this
  message: { error: "Too many requests \u2014 wait a moment and try again." },
});

app.get("/", (_req, res) => {
  res.send("Nyra backend is running.");
});

app.post("/compile", limiter, async (req, res) => {
  const { text, tier, targetModel, projectContext } = req.body || {};

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: "Server misconfigured: GROQ_API_KEY not set." });
  }
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing 'text' in request body." });
  }

  const model = MODEL_MAP[tier] || MODEL_MAP.fast;
  const userMessage = projectContext
    ? `Project context (use only if relevant, otherwise ignore):\n${projectContext}\n\n---\nUser's rough prompt: ${text}`
    : text;

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: getSystemPrompt(targetModel) },
          { role: "user", content: userMessage },
        ],
      }),
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      const message = data?.error?.message || "Groq request failed";
      return res.status(groqRes.status).json({ error: message });
    }

    const compiledText = sanitizeCompiledText(data.choices[0].message.content.trim());
    res.json({ compiledText });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Nyra backend listening on port ${PORT}`);
});
