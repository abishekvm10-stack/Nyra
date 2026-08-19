// The RESEARCH step, split out from model-research.js so it can be
// required and unit-tested (with a mocked fetch/Groq call) without
// pulling in the CLI entry point. Fetches a candidate model's primary
// source, asks a free-tier Groq model to extract structured facts
// into model-knowledge.json's schema, and returns a full entry or
// null. Never throws — every failure path here means "research
// produced nothing usable this run," not a crash.

// Domains trusted enough to research from. Deliberately NOT
// enforcing this via VENDOR_SOURCES' own url field alone (a fixed
// config value someone could edit without thinking about the
// implication) — every candidate is re-checked against this list
// right before the network call, since third-party SEO content can
// misrepresent vendor guidance (confirmed while doing this same
// research manually earlier the same day this plan was written).
const PRIMARY_SOURCE_ALLOWLIST = [
  "docs.claude.com",
  "claude.com",
  "anthropic.com",
  "platform.openai.com",
  "openai.com",
  "developers.openai.com",
  "ai.google.dev",
  "docs.cloud.google.com",
  "docs.together.ai", // hosts DeepSeek's own documented prompting guidance
  "api.groq.com",
];

function isAllowlistedSource(url) {
  try {
    const host = new URL(url).hostname;
    return PRIMARY_SOURCE_ALLOWLIST.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

// Very rough tag stripping — good enough for feeding a doc page's
// prose to a summarizing model, not meant to be a real HTML parser.
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_SOURCE_CHARS = 6000; // keeps the Groq call cheap and fast; a prompting guide's relevant content fits comfortably

const RESEARCH_SYSTEM_PROMPT = `You extract prompt-engineering guidance for a specific AI model from documentation text. You will be given the model's name and an excerpt from its vendor's own documentation.

Extract ONLY what the text actually supports — never invent a claim the text doesn't make. Respond with STRICT JSON only, no markdown fences, no commentary, matching exactly this shape:
{
  "tier": "flagship" | "standard" | "fast",
  "reasoning": true | false,
  "render": "one paragraph of concrete prompting instructions for this model — structural format, what to include or avoid, how it prefers instructions phrased",
  "notes": "one sentence on what in the source text actually supports the above, or noting where you had to make a reasonable inference rather than a directly-stated fact"
}

If the text doesn't give you enough to determine tier or reasoning with any confidence, use your best judgment from the model's name and vendor context (e.g. names containing "flash", "mini", "haiku" usually indicate a faster/smaller tier; names associated with a vendor's extended-thinking/reasoning line indicate reasoning:true) and say so plainly in "notes" rather than stating it as directly confirmed.`;

async function callGroqForResearch(candidateName, sourceText, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b", // Groq's free tier — same model Nyra's own "fast" tier already uses
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        { role: "system", content: RESEARCH_SYSTEM_PROMPT },
        { role: "user", content: `Model: ${candidateName}\n\nDocumentation excerpt:\n${sourceText}` },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Groq research call failed");
  return data.choices[0].message.content.trim();
}

function parseResearchResponse(raw) {
  let json;
  try {
    // Strip accidental code fences even though the prompt asks against them — smaller models sometimes ignore that instruction.
    const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
    json = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!json || typeof json.render !== "string" || !json.render.trim()) return null;
  if (!["flagship", "standard", "fast"].includes(json.tier)) return null;
  if (typeof json.reasoning !== "boolean") return null;
  return json;
}

function deriveId(candidateName) {
  return candidateName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveAliases(candidateName) {
  const lower = candidateName.toLowerCase().trim();
  const hyphenated = lower.replace(/\s+/g, "-");
  const squashed = lower.replace(/[^a-z0-9]/g, "");
  return [...new Set([lower, hyphenated, squashed])];
}

// The main export. `candidate` is one of detectNewModels()'s results
// ({ vendor, family, candidateName, sourceUrl }). Returns a full
// model-knowledge.json entry (with verified: null — VERIFY is a
// separate step, run by the CI workflow via eval-prompts.js --compare
// against real fixtures, not decided here) or null if anything along
// the way didn't produce something usable.
async function researchCandidate(candidate, groqApiKey) {
  if (!isAllowlistedSource(candidate.sourceUrl)) return null;

  let sourceText;
  try {
    const res = await fetch(candidate.sourceUrl);
    if (!res.ok) return null;
    const html = await res.text();
    sourceText = stripHtml(html).slice(0, MAX_SOURCE_CHARS);
    if (!sourceText) return null;
  } catch {
    return null;
  }

  let raw;
  try {
    raw = await callGroqForResearch(candidate.candidateName, sourceText, groqApiKey);
  } catch {
    return null;
  }

  const parsed = parseResearchResponse(raw);
  if (!parsed) return null;

  return {
    id: deriveId(candidate.candidateName),
    family: candidate.family,
    displayName: candidate.candidateName,
    aliases: deriveAliases(candidate.candidateName),
    tier: parsed.tier,
    reasoning: parsed.reasoning,
    researched: true,
    render: parsed.render,
    example: null, // deliberately never fabricated here — an invented example is worse than none, matching the project's own faithfulness rule
    notes: parsed.notes || "",
    source: candidate.sourceUrl,
    verified: null,
    verifyNote: "Researched from primary-source docs; not yet run through a live --compare verification.",
  };
}

module.exports = {
  PRIMARY_SOURCE_ALLOWLIST,
  isAllowlistedSource,
  stripHtml,
  parseResearchResponse,
  deriveId,
  deriveAliases,
  researchCandidate,
};
