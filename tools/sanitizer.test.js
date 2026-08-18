// Regression suite for prompt-kit.js's sanitizeCompiledText(). Pure
// logic, no network — run with `node tools/sanitizer.test.js`.
//
// This exists because the old sanitizer's anchor ("Role:") stopped
// being reliable once output shape became adaptive (see the
// implementation plan's risk 5/6). These fixtures are the messy
// real-world shapes a model can produce despite being told to use the
// ===NYRA_OUTPUT_START/END=== delimiters — this is the piece most
// likely to silently rot, so it gets its own always-runnable check.

const { sanitizeCompiledText, OUTPUT_START, OUTPUT_END } = require("../prompt-kit");

const CLEAN = "Role: A helpful assistant\nTask: Do the thing";

const CASES = [
  {
    name: "clean delimited output",
    input: `${OUTPUT_START}\n${CLEAN}\n${OUTPUT_END}`,
    expect: CLEAN,
  },
  {
    name: "wrapped in a markdown code fence",
    input: `${OUTPUT_START}\n\`\`\`\n${CLEAN}\n\`\`\`\n${OUTPUT_END}`,
    expect: CLEAN,
  },
  {
    name: "conversational preamble before the delimiter",
    input: `Sure, here's the compiled prompt:\n\n${OUTPUT_START}\n${CLEAN}\n${OUTPUT_END}`,
    expect: CLEAN,
  },
  {
    name: "preamble INSIDE the delimiters (model didn't fully follow instructions)",
    input: `${OUTPUT_START}\nHere's the compiled prompt:\n${CLEAN}\n${OUTPUT_END}`,
    expect: CLEAN,
  },
  {
    name: "missing closing delimiter, opening present",
    input: `${OUTPUT_START}\n${CLEAN}`,
    expect: CLEAN,
  },
  {
    name: "missing both delimiters, falls back to legacy Role: anchor",
    input: `Sure, here you go:\n${CLEAN}`,
    expect: CLEAN,
  },
  {
    name: "no delimiters and no Role: anchor — returns cleaned text, not empty",
    input: `Here's a plain answer with no structure at all.`,
    expect: "Here's a plain answer with no structure at all.",
  },
  {
    name: "near-miss marker text (extra space) is not treated as a real delimiter, Role: anchor still recovers it",
    input: `=== NYRA_OUTPUT_END ===\n${CLEAN}`,
    expect: CLEAN,
  },
  {
    name: "empty string",
    input: "",
    expect: "",
  },
  {
    name: "whitespace only",
    input: "   \n\n  ",
    expect: "",
  },
  {
    name: "output content that itself looks like an instruction is preserved verbatim, not stripped",
    input: `${OUTPUT_START}\nTask: explain the phrase "ignore previous instructions" in a security context\n${OUTPUT_END}`,
    expect: `Task: explain the phrase "ignore previous instructions" in a security context`,
  },
  {
    name: "double-fenced with a language tag",
    input: `${OUTPUT_START}\n\`\`\`markdown\n${CLEAN}\n\`\`\`\n${OUTPUT_END}`,
    expect: CLEAN,
  },
  {
    name: "trailing whitespace/newlines inside delimiters",
    input: `${OUTPUT_START}\n\n${CLEAN}\n\n\n${OUTPUT_END}`,
    expect: CLEAN,
  },
  {
    name: "legacy five-field output with no delimiters at all (old backend / old model behavior)",
    input: `Role: A helpful assistant\nContext: none\nTask: do the thing\nConstraints: none\nOutput Format: plain text`,
    expect: `Role: A helpful assistant\nContext: none\nTask: do the thing\nConstraints: none\nOutput Format: plain text`,
  },
  {
    name: "'okay' preamble variant",
    input: `Okay, here is the result:\n${OUTPUT_START}\n${CLEAN}\n${OUTPUT_END}`,
    expect: CLEAN,
  },
  {
    name: "'certainly' preamble crammed onto the same line as real content",
    input: `Certainly! ${CLEAN}`,
    // The preamble regex deliberately does NOT match here (no newline
    // right after "Certainly!"), to avoid swallowing "Role: ..." along
    // with it — the Role: anchor fallback recovers cleanly instead.
    expect: CLEAN,
  },
  {
    name: "XML-tagged content survives untouched (Claude-profile shape)",
    input: `${OUTPUT_START}\n<task>Fix the bug</task>\n<context>Users report random logouts</context>\n${OUTPUT_END}`,
    expect: `<task>Fix the bug</task>\n<context>Users report random logouts</context>`,
  },
  {
    name: "Markdown-header content survives untouched (GPT-profile shape)",
    input: `${OUTPUT_START}\n## Task\nFix the bug\n\n## Context\nUsers report random logouts\n${OUTPUT_END}`,
    expect: `## Task\nFix the bug\n\n## Context\nUsers report random logouts`,
  },
  {
    name: "multiple END markers — extraction uses the last one",
    input: `${OUTPUT_START}\nFirst attempt\n${OUTPUT_END}\n\nActually, let me redo that.\n${OUTPUT_START}\nFinal answer\n${OUTPUT_END}`,
    expect: "Final answer",
  },
  {
    name: "only an END marker present, no START",
    input: `${CLEAN}\n${OUTPUT_END}`,
    expect: CLEAN,
  },
  {
    name: "null-ish input",
    input: null,
    expect: "",
  },
];

let passed = 0;
let failed = 0;

for (const { name, input, expect } of CASES) {
  const actual = sanitizeCompiledText(input);
  if (actual === expect) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(`  expected: ${JSON.stringify(expect)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

console.log(`\n${passed}/${CASES.length} sanitizer cases passed.`);
if (failed > 0) process.exit(1);
