// Phase 2: pulls relevant snippets from a user-connected folder of
// their own files, so the compiled prompt can reflect real project
// details instead of generic phrasing. Deliberately simple for v1 \u2014
// keyword overlap scoring, not embeddings \u2014 good enough to prove the
// idea works before investing in anything heavier.

const fs = require("fs");
const path = require("path");

const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".mdx"];
const MAX_FILES = 200; // safety cap so a huge folder can't hang the app
const MAX_FILE_SIZE = 200 * 1024; // skip anything unusually large (200KB)
const CHUNK_SIZE = 800; // characters per chunk
const MAX_CONTEXT_CHARS = 1200; // total budget folded into the prompt

function walkDir(dir, fileList = [], depth = 0) {
  if (depth > 6) return fileList; // avoid runaway recursion on deep trees
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return fileList; // folder unreadable/moved \u2014 just return what we have
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, fileList, depth + 1);
    } else if (TEXT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      fileList.push(fullPath);
    }
    if (fileList.length >= MAX_FILES) break;
  }
  return fileList;
}

function chunkText(text, chunkSize) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function scoreChunk(chunkLower, queryWords) {
  let score = 0;
  for (const word of queryWords) {
    if (word.length < 3) continue; // skip tiny/common words like "a", "to"
    const occurrences = chunkLower.split(word).length - 1;
    score += occurrences;
  }
  return score;
}

// Returns a string of the most relevant snippets from `folderPath` for
// `rawText`, or "" if there's no folder configured, the folder is
// empty/unreadable, or nothing in it looks relevant.
function getRelevantContext(folderPath, rawText) {
  if (!folderPath) return "";

  const files = walkDir(folderPath);
  if (files.length === 0) return "";

  const queryWords = rawText.toLowerCase().split(/\W+/).filter(Boolean);
  const scoredChunks = [];

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_SIZE) continue;

    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const chunk of chunkText(content, CHUNK_SIZE)) {
      const score = scoreChunk(chunk.toLowerCase(), queryWords);
      if (score > 0) {
        scoredChunks.push({ score, chunk, file: path.basename(file) });
      }
    }
  }

  scoredChunks.sort((a, b) => b.score - a.score);

  let context = "";
  for (const { chunk, file } of scoredChunks) {
    const addition = `[from ${file}]\n${chunk.trim()}\n\n`;
    if (context.length + addition.length > MAX_CONTEXT_CHARS) break;
    context += addition;
  }

  return context.trim();
}

module.exports = { getRelevantContext };
