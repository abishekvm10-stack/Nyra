// DETECT + RESEARCH for model-knowledge.json (per-individual-model
// prompting structure — see prompt-kit.js and model-knowledge.json's
// own header comments for the full picture). Dev-only, excluded from
// the packaged app the same way tools/eval-prompts.js is.
//
// Runs from CI (.github/workflows/research.yml, not built yet) on a
// schedule, but every command here works identically run by hand —
// deliberately, so the whole pipeline can be exercised and debugged
// locally before ever depending on a real Actions run.
//
// Usage:
//   node tools/model-research.js                 detect only, print candidates, write nothing
//   node tools/model-research.js --research       detect + research + verify, writes model-knowledge.json
//   GROQ_API_KEY=... node tools/model-research.js --research   (RESEARCH needs a Groq key; DETECT does not)
//
// Exit code 0 with nothing written = nothing new found, or research
// didn't produce anything that passed verification — this is the
// expected, common outcome on most days, not a failure.

const fs = require("fs");
const path = require("path");

const KNOWLEDGE_PATH = path.join(__dirname, "..", "model-knowledge.json");
const RESEARCH = process.argv.includes("--research");

// --- DETECT --------------------------------------------------------
//
// Honest about where this actually works. Groq has a real, free,
// keyless-enough (one already-provisioned key, no billing) model-list
// API — genuinely automatable. The other vendors don't have an
// equally reliable free way to enumerate their current model lineup,
// so DETECT for them is a best-effort scan of their own public docs
// page, wrapped so a changed page layout or an unreachable URL just
// means "found nothing this run," never a crash — the same
// degradation the parked auto-detect plan's MODEL_PROBES design uses.
const VENDOR_SOURCES = [
  {
    vendor: "groq",
    family: "open-weight",
    type: "api-list",
    // Groq re-hosts many vendors' open-weight models under one
    // endpoint — this is genuinely how new open-weight releases (a
    // new DeepSeek, a new Qwen, a new Llama) show up fastest.
    url: "https://api.groq.com/openai/v1/models",
    needsKey: "GROQ_API_KEY",
  },
  {
    vendor: "anthropic",
    family: "claude",
    type: "docs-scan",
    url: "https://docs.claude.com/en/docs/about-claude/models/overview",
    // Matches things like "Claude Opus 5", "Claude Sonnet 5", "Claude Haiku 4.5"
    pattern: /Claude\s+(Opus|Sonnet|Haiku|Fable)\s+[\d.]+/gi,
  },
  {
    vendor: "openai",
    family: "gpt",
    type: "docs-scan",
    url: "https://platform.openai.com/docs/models",
    pattern: /\bGPT-[\d.]+\b|\bo[1-9]\b/g,
  },
  {
    vendor: "google",
    family: "gemini",
    type: "docs-scan",
    url: "https://ai.google.dev/gemini-api/docs/models",
    pattern: /Gemini\s+[\d.]+\s+(Pro|Flash|Ultra)/gi,
  },
];

function loadKnowledge() {
  const raw = fs.readFileSync(KNOWLEDGE_PATH, "utf8");
  return JSON.parse(raw);
}

function saveKnowledge(data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(KNOWLEDGE_PATH, JSON.stringify(data, null, 2) + "\n");
}

// A candidate name is "known" if it fuzzy-matches an existing entry's
// id, displayName, or any alias — deliberately loose (normalized,
// punctuation-insensitive) so trivial formatting differences between
// a vendor's docs page and our own naming don't produce false "new
// model" positives.
function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isKnownModel(candidateName, knownEntries) {
  const n = normalize(candidateName);
  return knownEntries.some((entry) => {
    const haystacks = [entry.id, entry.displayName, ...(entry.aliases || [])];
    return haystacks.some((h) => normalize(h) === n || normalize(h).includes(n) || n.includes(normalize(h)));
  });
}

async function detectViaApiList(source, knownEntries) {
  const apiKey = process.env[source.needsKey];
  if (!apiKey) return []; // no key available — not an error, just can't check this source right now

  try {
    const res = await fetch(source.url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return [];
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id).filter(Boolean);
    return ids
      .filter((id) => !isKnownModel(id, knownEntries))
      .map((id) => ({ vendor: source.vendor, family: source.family, candidateName: id, sourceUrl: source.url }));
  } catch {
    return []; // network failure, bad JSON, whatever — DETECT degrading to "nothing found" is the designed behavior
  }
}

async function detectViaDocsScan(source, knownEntries) {
  try {
    const res = await fetch(source.url);
    if (!res.ok) return [];
    const html = await res.text();
    const matches = [...html.matchAll(source.pattern)].map((m) => m[0]);
    const unique = [...new Set(matches)];
    return unique
      .filter((name) => !isKnownModel(name, knownEntries))
      .map((name) => ({ vendor: source.vendor, family: source.family, candidateName: name, sourceUrl: source.url }));
  } catch {
    return [];
  }
}

async function detectNewModels(knownEntries) {
  const results = await Promise.all(
    VENDOR_SOURCES.map((source) =>
      source.type === "api-list" ? detectViaApiList(source, knownEntries) : detectViaDocsScan(source, knownEntries)
    )
  );
  return results.flat();
}

module.exports = {
  VENDOR_SOURCES,
  normalize,
  isKnownModel,
  detectNewModels,
  loadKnowledge,
  saveKnowledge,
  KNOWLEDGE_PATH,
};

// --- CLI entry point (only when run directly, not when required) --

if (require.main === module) {
  (async () => {
    const data = loadKnowledge();
    console.log(`Loaded model-knowledge.json: ${data.models.length} known models.\n`);

    console.log("=== DETECT ===");
    const candidates = await detectNewModels(data.models);
    if (candidates.length === 0) {
      console.log("No new models found (or no sources were reachable — this is the normal, expected outcome most days).");
    } else {
      candidates.forEach((c) => console.log(`  candidate: [${c.vendor}] "${c.candidateName}" (from ${c.sourceUrl})`));
    }

    if (!RESEARCH || candidates.length === 0) {
      console.log(RESEARCH ? "\nNothing to research." : "\nRun with --research to also research and propose entries for these.");
      return;
    }

    console.log("\n=== RESEARCH ===");
    const { researchCandidate } = require("./model-research-worker");
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      console.log("GROQ_API_KEY not set — RESEARCH needs it (used purely as a free-tier reader/summarizer, see plan). Skipping.");
      return;
    }

    let wrote = false;
    const newIds = [];
    for (const candidate of candidates) {
      const entry = await researchCandidate(candidate, groqKey);
      if (entry) {
        data.models.push(entry);
        wrote = true;
        newIds.push(entry.id);
        console.log(`  researched: ${entry.id} (source: ${entry.source})`);
      } else {
        console.log(`  skipped: ${candidate.candidateName} (research produced nothing usable)`);
      }
    }

    if (wrote) {
      saveKnowledge(data);
      console.log("\nmodel-knowledge.json updated. This process does NOT commit or open a PR itself, and has NOT run VERIFY yet — see .github/workflows/research.yml for the compare + propose steps that follow.");
      // GitHub Actions reads GITHUB_OUTPUT to pass values between
      // steps in the same job. Writing to it is a no-op outside CI
      // (the env var simply won't exist when run by hand locally).
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_ids=${newIds.join(",")}\n`);
      }
    } else {
      console.log("\nNothing usable came out of research this run — model-knowledge.json left unchanged.");
    }
  })().catch((err) => {
    console.error("model-research.js failed:", err.message);
    process.exit(1);
  });
}
