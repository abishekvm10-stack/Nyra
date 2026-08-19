// Before/after eval harness for prompt-kit.js. Two tiers:
//
//   node tools/eval-prompts.js
//     Structural checks only, no network, no API key needed. Verifies
//     the system prompt itself is actually different per agent (this
//     is the automatable version of the user's original complaint —
//     "per-agent tuning doesn't feel like it's doing anything" — and
//     it fails loudly and immediately if that regresses, rather than
//     requiring someone to notice by eye).
//
//   GROQ_API_KEY=... node tools/eval-prompts.js --live
//     Also compiles every fixture against every representative agent
//     through the real Groq API and runs the automated assertion
//     tier (differs-per-agent on real output, hallucination check,
//     profile-structure check, intent preservation, sanitizer
//     cleanliness, bloat), dumping full output to a timestamped file
//     under tools/eval-output/ for side-by-side human reading.
//
//   node tools/eval-prompts.js --compare <model-id>
//     The VERIFY step for model-knowledge.json's per-model overrides
//     (see that file's header, and tools/model-research.js). Compares
//     a researched model's OWN render text against what the same
//     target would have gotten from the family-level fallback alone —
//     i.e. "was researching this model specifically actually worth
//     it?" Structural checks always run, free. A real-model live
//     comparison additionally runs ONLY through genuinely free-tier
//     providers (Groq always; Gemini's free tier if GEMINI_API_KEY is
//     set) — deliberately never through a paid provider automatically,
//     see model-knowledge.json's cost-constraint history. On success,
//     writes the result into that model's `verified` field.

const fs = require("fs");
const path = require("path");
const {
  buildSystemPrompt,
  getAgentProfile,
  getEffectiveModelProfile,
  resolveModelId,
  sanitizeCompiledText,
} = require("../prompt-kit");
const { compilePrompt } = require("../compiler");

const LIVE = process.argv.includes("--live");
const COMPARE_INDEX = process.argv.indexOf("--compare");
const COMPARE_MODEL_ID = COMPARE_INDEX !== -1 ? process.argv[COMPARE_INDEX + 1] : null;

// One representative target-model string per agent profile — enough
// to prove each profile actually gets selected and actually changes
// the prompt, without trying to cover the full space of real model
// names (compiler.js's getTargetModelLabel already handles arbitrary
// free text the same way regardless of which example triggered it).
const REPRESENTATIVE_AGENTS = [
  { label: "generic", targetAgent: "", targetModelName: "" },
  { label: "claude", targetAgent: "Claude", targetModelName: "" },
  { label: "gpt", targetAgent: "ChatGPT", targetModelName: "" },
  { label: "gemini", targetAgent: "Gemini", targetModelName: "" },
  { label: "coding-agent", targetAgent: "opencode", targetModelName: "" },
  { label: "open-weight", targetAgent: "Other", targetModelName: "llama3.1" },
];

// Each fixture's bannedTerms are plausible-sounding but UNSTATED
// constraints — if any show up in compiled output, the compiler
// invented something the user never asked for (this is what turns
// "hallucination is hard to detect" into "grep for a planted
// negative"). expectKeywords are terms from the input that a faithful
// compile should preserve somewhere.
const FIXTURES = [
  { taskType: "code", input: "the search endpoint is slow when there are a lot of results", bannedTerms: ["urgent", "Python", "by tomorrow"], expectKeywords: ["search", "slow"] },
  { taskType: "code", input: "fix the login bug where users get logged out randomly", bannedTerms: ["React", "mobile app", "critical"], expectKeywords: ["login", "logged out"] },
  { taskType: "writing", input: "write something for my landlord about the broken heater", bannedTerms: ["formal", "30 days", "urgent"], expectKeywords: ["landlord", "heater"] },
  { taskType: "writing", input: "draft a farewell message to my team, I'm leaving the company", bannedTerms: ["LinkedIn", "two weeks notice", "emotional"], expectKeywords: ["team", "leaving"] },
  { taskType: "analysis", input: "compare postgres and mongodb for a chat app", bannedTerms: ["startup", "high traffic", "AWS"], expectKeywords: ["postgres", "mongodb"] },
  { taskType: "analysis", input: "why might my model be overfitting", bannedTerms: ["beginner", "image classification", "urgent"], expectKeywords: ["overfitting"] },
  { taskType: "research", input: "find out what causes random session logouts in web apps", bannedTerms: ["mobile app", "enterprise", "urgent"], expectKeywords: ["session", "logout"] },
  { taskType: "research", input: "look into why coffee prices have gone up this year", bannedTerms: ["global", "2024", "supply chain"], expectKeywords: ["coffee", "prices"] },
  { taskType: "creative", input: "a short story about a lighthouse keeper who never sees the sea", bannedTerms: ["500 words", "1800s", "tragic ending"], expectKeywords: ["lighthouse"] },
  { taskType: "creative", input: "a poem about waiting for a bus that never comes", bannedTerms: ["haiku", "rhyming", "melancholy"], expectKeywords: ["bus"] },
  { taskType: "general", input: "explain CAP theorem", bannedTerms: ["beginner", "one paragraph", "analogy"], expectKeywords: ["CAP"] },
  { taskType: "general", input: "help me plan a trip", bannedTerms: ["Europe", "budget", "one week"], expectKeywords: ["trip"] },
];

// --- structural tier (always runs, no network) ------------------------

function runStructuralChecks() {
  console.log("=== Structural checks (no network) ===\n");
  let failures = 0;

  const built = REPRESENTATIVE_AGENTS.map((a) => ({
    ...a,
    prompt: buildSystemPrompt([a.targetAgent, a.targetModelName].filter(Boolean).join(" ")),
  }));

  // 1. The core complaint, automated: per-agent tuning must not be a
  // no-op. Every pair of agent system prompts must differ.
  for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
      if (built[i].prompt === built[j].prompt) {
        console.error(`FAIL: ${built[i].label} and ${built[j].label} produced an IDENTICAL system prompt`);
        failures++;
      }
    }
  }
  console.log(`Distinctness: ${built.length} profiles, all pairs ${failures === 0 ? "differ" : "checked"}.`);

  // 2. The deleted "make the most reasonable assumption" instruction
  // must not silently come back.
  for (const b of built) {
    if (/most reasonable assumption/i.test(b.prompt)) {
      console.error(`FAIL: ${b.label} system prompt still contains the assumption-inventing instruction`);
      failures++;
    }
  }

  // 3. Output delimiters must be present so the sanitizer has
  // something to extract.
  for (const b of built) {
    if (!b.prompt.includes("===NYRA_OUTPUT_START===") || !b.prompt.includes("===NYRA_OUTPUT_END===")) {
      console.error(`FAIL: ${b.label} system prompt is missing the output delimiter instruction`);
      failures++;
    }
  }

  // 4. Ordering regression guard: "Claude Code" must resolve to the
  // coding-agent profile, not the claude chat profile, even though it
  // contains the substring "claude" — this is the exact bug class
  // family-regex matching order can silently reintroduce.
  const claudeCodeProfile = getAgentProfile("Claude Code");
  if (claudeCodeProfile.id !== "coding-agent") {
    console.error(`FAIL: "Claude Code" resolved to profile "${claudeCodeProfile.id}", expected "coding-agent"`);
    failures++;
  }
  const githubCopilotProfile = getAgentProfile("GitHub Copilot");
  if (githubCopilotProfile.id !== "coding-agent") {
    console.error(`FAIL: "GitHub Copilot" resolved to profile "${githubCopilotProfile.id}", expected "coding-agent"`);
    failures++;
  }

  // 5. model-knowledge.json regression guards (2026-08-20 per-model
  // override feature). The concrete bug this whole feature was
  // rewritten to avoid: two models with identical tier+reasoning
  // classification collapsing into shared, indistinguishable
  // treatment. Claude Opus 5 and DeepSeek R1 are both
  // tier:flagship/reasoning:true and MUST still produce different
  // render text — if this ever fails, model-knowledge resolution has
  // regressed into exactly the "shared bucket" behavior it exists to
  // prevent.
  const opusProfile = getEffectiveModelProfile("Claude Opus 5");
  const deepseekProfile = getEffectiveModelProfile("Other DeepSeek R1");
  if (opusProfile.reasoning !== true || deepseekProfile.reasoning !== true) {
    console.error("FAIL: Claude Opus 5 and DeepSeek R1 fixture models are no longer both reasoning:true — update this test if the seed data changed intentionally");
    failures++;
  }
  if (opusProfile.render === deepseekProfile.render) {
    console.error("FAIL: Claude Opus 5 and DeepSeek R1 produced IDENTICAL render text despite being different models — per-model overrides have collapsed into a shared bucket");
    failures++;
  }

  // 6. A coding-agent-wrapped model (e.g. "Cursor Sonnet 5") must NOT
  // pick up a chat-family model override — that scope boundary is
  // deliberate (see prompt-kit.js's MODEL_OVERRIDE_FAMILIES comment)
  // and this guards against it silently expanding.
  if (resolveModelId("Cursor Sonnet 5") !== null) {
    console.error(`FAIL: "Cursor Sonnet 5" resolved to a model override (${resolveModelId("Cursor Sonnet 5")}) — coding-agent scope boundary has regressed`);
    failures++;
  }

  // 7. A reasoning:true model's compiled system prompt must omit the
  // worked example (showing an example while also saying "don't rely
  // on examples" is self-contradictory) but include the reasoning-mode
  // instruction; a non-reasoning model must do the opposite.
  const deepseekPrompt = buildSystemPrompt("Other DeepSeek R1");
  if (!deepseekPrompt.includes("reasoning-first model")) {
    console.error("FAIL: reasoning:true model's system prompt is missing the reasoning-mode instruction");
    failures++;
  }
  if (deepseekPrompt.includes("Example,")) {
    console.error("FAIL: reasoning:true model's system prompt still includes a worked example — contradicts its own no-scaffolding instruction");
    failures++;
  }
  const haikuPrompt = buildSystemPrompt("Claude Haiku 4.5");
  if (haikuPrompt.includes("reasoning-first model")) {
    console.error("FAIL: reasoning:false model's system prompt incorrectly includes the reasoning-mode instruction");
    failures++;
  }

  console.log(`\nStructural checks: ${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  return failures;
}

// --- live tier (network, needs GROQ_API_KEY) ---------------------------

function checkFixture(fixture, agentLabel, rawCompiled) {
  const issues = [];
  const compiled = sanitizeCompiledText(rawCompiled);

  if (!compiled) {
    issues.push("sanitized output is empty");
    return { compiled, issues };
  }
  if (/^(here|sure|okay|certainly)\b/i.test(compiled)) {
    issues.push("starts with a conversational preamble word — sanitizer may have missed it");
  }
  if (compiled.includes("===NYRA_")) {
    issues.push("a raw delimiter leaked into the cleaned output");
  }
  for (const banned of fixture.bannedTerms) {
    if (compiled.toLowerCase().includes(banned.toLowerCase())) {
      issues.push(`hallucinated an unstated constraint: "${banned}"`);
    }
  }
  const missingKeywords = fixture.expectKeywords.filter(
    (kw) => !compiled.toLowerCase().includes(kw.toLowerCase())
  );
  if (missingKeywords.length === fixture.expectKeywords.length) {
    issues.push(`lost all intent keywords: ${missingKeywords.join(", ")}`);
  }
  const inputWords = fixture.input.split(/\s+/).length;
  const outputWords = compiled.split(/\s+/).length;
  if (outputWords > inputWords * 15) {
    issues.push(`bloated: ${inputWords} input words -> ${outputWords} output words`);
  }

  return { compiled, issues };
}

async function runLiveEval() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("\n--live requires GROQ_API_KEY to be set. Skipping live tier.");
    return 0;
  }

  console.log(`\n=== Live eval: ${FIXTURES.length} fixtures x ${REPRESENTATIVE_AGENTS.length} agents = ${FIXTURES.length * REPRESENTATIVE_AGENTS.length} calls ===`);
  console.log("This will take a while and consumes real Groq rate limit.\n");

  const outDir = path.join(__dirname, "eval-output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
  const lines = [];
  let totalIssues = 0;
  let byAgentOutput = {};

  for (const fixture of FIXTURES) {
    byAgentOutput[fixture.input] = {};
    for (const agent of REPRESENTATIVE_AGENTS) {
      const settings = {
        provider: "groq",
        tier: "fast",
        apiKey,
        targetAgent: agent.targetAgent,
        targetModelName: agent.targetModelName,
        taskType: "auto",
      };
      let compiled = "";
      let issues = [];
      try {
        const raw = await compilePrompt(fixture.input, settings, "");
        // compilePrompt already sanitizes; re-run checkFixture's own
        // sanitize call is a no-op pass-through, kept for symmetry
        // with the structural expectations above.
        ({ compiled, issues } = checkFixture(fixture, agent.label, raw));
      } catch (err) {
        issues = [`request failed: ${String(err.message || err)}`];
      }
      byAgentOutput[fixture.input][agent.label] = compiled;
      totalIssues += issues.length;

      lines.push(`--- [${fixture.taskType}] "${fixture.input}" x ${agent.label} ---`);
      lines.push(compiled || "(empty)");
      if (issues.length) lines.push(`ISSUES: ${issues.join(" | ")}`);
      lines.push("");

      if (issues.length) {
        console.error(`FAIL [${fixture.taskType}/${agent.label}] "${fixture.input}": ${issues.join(" | ")}`);
      }
    }

    // The core assertion, run per-fixture: same input, different
    // agents, must not all collapse to the same output.
    const outputs = Object.values(byAgentOutput[fixture.input]);
    const distinct = new Set(outputs.map((o) => o.trim()));
    if (distinct.size === 1 && outputs.length > 1) {
      console.error(`FAIL [${fixture.taskType}] "${fixture.input}": ALL agents produced identical output — tuning had no effect`);
      totalIssues++;
    }
  }

  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`\nFull output written to ${outPath}`);
  console.log(`Live eval: ${totalIssues === 0 ? "ALL PASSED" : `${totalIssues} issue(s) found`}`);
  return totalIssues;
}

// --- --compare tier (VERIFY step for model-knowledge.json) --------

// Free-tier providers only, hardcoded — never "whichever key exists"
// (see model-knowledge.json's own cost-constraint note). Groq is
// always available since Nyra Cloud already depends on it; Gemini
// only if its own free-tier key is explicitly set for this purpose.
const FREE_TIER_PROVIDERS = ["groq"];

function scoreOutputs(compiledList, fixtures) {
  let totalIssues = 0;
  let totalWords = 0;
  for (let i = 0; i < compiledList.length; i++) {
    const { issues } = checkFixture(fixtures[i], "compare", compiledList[i]);
    totalIssues += issues.length;
    totalWords += (compiledList[i] || "").split(/\s+/).length;
  }
  return { totalIssues, avgWords: Math.round(totalWords / compiledList.length) };
}

async function runCompare(modelId) {
  const modelKnowledgePath = path.join(__dirname, "..", "model-knowledge.json");
  const knowledge = JSON.parse(fs.readFileSync(modelKnowledgePath, "utf8"));
  const entry = knowledge.models.find((m) => m.id === modelId);
  if (!entry) {
    console.error(`No entry with id "${modelId}" in model-knowledge.json.`);
    return 1;
  }
  if (!entry.researched) {
    console.error(`Entry "${modelId}" is not marked researched — nothing to verify yet (it's still a family-inherited seed).`);
    return 1;
  }

  const targetModel = entry.displayName;
  console.log(`=== Comparing "${modelId}" (${targetModel}) against its family fallback ===\n`);

  // "Proposed" = the model's own render (already active in
  // model-knowledge.json, since prompt-kit.js resolves exact-id
  // matches first). "Baseline" = what the SAME target string would
  // have produced without this entry existing at all — the family
  // profile alone, exactly what getAgentProfile() (not
  // getEffectiveModelProfile()) returns.
  const proposedPrompt = buildSystemPrompt(targetModel);
  const baselineProfile = getAgentProfile(targetModel);
  const baselinePrompt = `${proposedPrompt.split("Rendering style:")[0]}Rendering style: ${baselineProfile.render}${
    baselineProfile.example
      ? `\n\nExample, ${baselineProfile.label} style — input "${baselineProfile.example.input}" produces:\n${baselineProfile.example.output}`
      : ""
  }`;

  // --- Structural tier: always runs, zero cost -----------------
  const structuralIssues = [];
  if (proposedPrompt === baselinePrompt) {
    structuralIssues.push("proposed render is IDENTICAL to the family fallback — research did not actually change anything");
  }
  if (!proposedPrompt.includes("===NYRA_OUTPUT_START===")) {
    structuralIssues.push("proposed prompt is missing the output delimiter instruction");
  }
  console.log(`Structural: ${structuralIssues.length === 0 ? "PASSED" : structuralIssues.join("; ")}`);

  // --- Live tier: free-tier providers only ----------------------
  const apiKey = process.env.GROQ_API_KEY;
  let liveResult = null;
  if (!apiKey) {
    console.log("\nGROQ_API_KEY not set — skipping live comparison. Structural-only verification.");
  } else {
    console.log(`\nRunning ${FIXTURES.length} fixtures through Groq (free tier) for both variants...`);

    // Proposed: goes through compilePrompt/buildSystemPrompt exactly
    // as a real compile would — targetModel resolves to this entry's
    // own render via prompt-kit's exact-id match.
    const proposedOutputs = [];
    for (const fixture of FIXTURES) {
      const settings = { provider: "groq", tier: "fast", apiKey, targetAgent: "Other", targetModelName: targetModel, taskType: "auto" };
      try {
        proposedOutputs.push(await compilePrompt(fixture.input, settings, ""));
      } catch {
        proposedOutputs.push("");
      }
    }

    // Baseline: the exact same Groq call, but with the family-only
    // system prompt built above (baselinePrompt) — compilePrompt has
    // no way to take an override system prompt, so this one raw call
    // is unavoidable to test "what if this entry didn't exist at all."
    const baselineOutputs = [];
    for (const fixture of FIXTURES) {
      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "openai/gpt-oss-20b",
            temperature: 0.2,
            max_tokens: 1500,
            messages: [
              { role: "system", content: baselinePrompt },
              { role: "user", content: `===NYRA_INPUT_START===\n${fixture.input}\n===NYRA_INPUT_END===` },
            ],
          }),
        });
        const data = await res.json();
        baselineOutputs.push(sanitizeCompiledText(data?.choices?.[0]?.message?.content || ""));
      } catch {
        baselineOutputs.push("");
      }
    }

    const proposedScore = scoreOutputs(proposedOutputs.map(sanitizeCompiledText), FIXTURES);
    const baselineScore = scoreOutputs(baselineOutputs, FIXTURES);
    console.log(`  Proposed (model-specific): ${proposedScore.totalIssues} issues across ${FIXTURES.length} fixtures, avg ${proposedScore.avgWords} words/output`);
    console.log(`  Baseline (family fallback): ${baselineScore.totalIssues} issues across ${FIXTURES.length} fixtures, avg ${baselineScore.avgWords} words/output`);

    const verdict = proposedScore.totalIssues < baselineScore.totalIssues
      ? "improved"
      : proposedScore.totalIssues > baselineScore.totalIssues
      ? "regressed"
      : "no clear difference on these fixtures";
    console.log(`  Verdict: ${verdict}`);

    liveResult = {
      provider: "groq",
      date: new Date().toISOString(),
      method: "structural + free-tier live compare",
      result: `${verdict} (proposed: ${proposedScore.totalIssues} issues/${proposedScore.avgWords}w avg, baseline: ${baselineScore.totalIssues} issues/${baselineScore.avgWords}w avg)`,
    };
  }

  if (structuralIssues.length > 0) {
    console.log("\nNOT updating verified — structural check failed.");
    return 1;
  }

  if (liveResult) {
    entry.verified = liveResult;
    delete entry.verifyNote;
    fs.writeFileSync(modelKnowledgePath, JSON.stringify(knowledge, null, 2) + "\n");
    console.log(`\nUpdated model-knowledge.json: "${modelId}".verified set.`);
  } else {
    console.log("\nStructural checks passed but no live comparison ran (no GROQ_API_KEY) — verified left as-is.");
  }

  return 0;
}

(async () => {
  if (COMPARE_MODEL_ID) {
    process.exit(await runCompare(COMPARE_MODEL_ID));
    return;
  }

  const structuralFailures = runStructuralChecks();
  const liveFailures = LIVE ? await runLiveEval() : 0;
  if (!LIVE) {
    console.log("\n(Run with GROQ_API_KEY=... node tools/eval-prompts.js --live for real model output comparison.)");
  }
  process.exit(structuralFailures + liveFailures > 0 ? 1 : 0);
})();
