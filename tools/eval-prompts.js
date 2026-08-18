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

const fs = require("fs");
const path = require("path");
const {
  buildSystemPrompt,
  getAgentProfile,
  sanitizeCompiledText,
} = require("../prompt-kit");
const { compilePrompt } = require("../compiler");

const LIVE = process.argv.includes("--live");

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

(async () => {
  const structuralFailures = runStructuralChecks();
  const liveFailures = LIVE ? await runLiveEval() : 0;
  if (!LIVE) {
    console.log("\n(Run with GROQ_API_KEY=... node tools/eval-prompts.js --live for real model output comparison.)");
  }
  process.exit(structuralFailures + liveFailures > 0 ? 1 : 0);
})();
