# Nyra — Complete Build Guide (Desktop App)

This is the full path from "unzip the scaffold" to "a real installer other people can run" — for the current desktop-app architecture. Follow it in order.

---

## Stage 0 — What you need before starting

- Windows or Mac (both are supported by the same codebase).
- [Node.js](https://nodejs.org) installed (LTS version).
- A free Groq API key (console.groq.com, no card needed) — this is the current default provider, see Stage 1.
- A code editor (VS Code is fine) for the rare case you need to tweak a file.
- [Ollama](https://ollama.com) is **not required right now** — it's planned for later (see Stage 6) once the app itself is confirmed working end-to-end.

---

## Stage 1 — Get a free Groq key (current default provider)

**Status: this is what we're actually using right now.** Ollama + local models (Llama, Qwen) are a planned future addition, not the current path — using Groq first removes local setup as a variable while getting the app itself working.

1. Go to console.groq.com, sign up (no card required).
2. Left sidebar → **API Keys** → **Create API Key**. Copy it now — Groq only shows it once.
3. Keep it somewhere safe; you'll paste it into Nyra's Settings window in Stage 2.

Current models used for Groq in this app: `openai/gpt-oss-20b` (fast tier) and `qwen/qwen3.6-27b` (quality tier) — already set correctly in `compiler.js` and `settings/settings.js`. (Earlier versions of this guide referenced `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` — Groq deprecated both in June 2026, so if you ever see those names anywhere, they need updating.)

---

## Stage 2 — Run the desktop app in development mode

1. Unzip `promptos-desktop.zip`.
2. Open a terminal in that folder:
   ```
   cd path\to\promptos-desktop
   npm install
   ```
3. **Watch this step closely.** It installs Electron and `@nut-tree-fork/nut-js` (the keyboard-simulation library that makes Alt+P fully automatic). This is the step most likely to show an error, since it has a native component. If it fails, copy the exact error text — it usually points at a missing build tool, and there's a known fix for that.
4. Once it finishes cleanly, start the app:
   ```
   npm start
   ```
5. A Settings window should open automatically the first time. Set:
   - **Provider**: Groq
   - **Tier**: Fast & cheap
   - **API key**: paste the Groq key from Stage 1
   - Click **Save**, then close the window.
6. Nyra is now running in your system tray (Windows) — look for its icon near the clock.

---

## Stage 3 — Your first real test

1. Open **Notepad** (simplest possible test — no website quirks to worry about).
2. Type a rough prompt: `write email about delayed package`
3. Press **Alt+P**.
4. Within a second or two, the text in Notepad should be replaced automatically with the structured Role/Context/Task/Constraints/Output Format version, and you'll see a small system notification confirming it compiled.
5. **If that works**, repeat the same test inside a ChatGPT tab in your browser, then in VS Code's chat panel if you use one — same hotkey, same behavior, no extra setup, because none of this depends on which app you're in.
6. **If nothing happens or you get an error notification**, tell me the exact wording and which step it happened at.

---

## Stage 4 — Use it for real for a few days

Before changing anything else, actually use Alt+P as your daily driver for a few days. Note:
- Any app where it doesn't behave as expected (some apps handle Ctrl+A differently than a normal text box — e.g. a full document with existing content could get more selected than intended; always click into the specific box you mean to compile).
- Whether the compiled prompt structure (Role/Context/Task/Constraints/Output Format) is actually the most useful shape for the kinds of prompts you write, or needs adjusting in `compiler.js`'s `SYSTEM_PROMPT`.
- Whether you find yourself wanting the free/unlimited Local tier enough to justify setting up Ollama, or whether Groq's rate limit never actually becomes a problem for how often you use this.

---

## Stage 5 — Add the free/unlimited Local tier (when you're ready)

Groq is free but rate-limited (~30 req/min, ~1,000/day). Local Ollama removes that limit entirely, at the cost of setup and your machine's RAM.

1. Install [Ollama](https://ollama.com), then `ollama pull llama3.1:8b` (~6-8GB RAM while running), or `ollama pull qwen2.5:1.5b` for a much lighter option (~1.5-2.5GB RAM) if your machine is lower-spec.
2. Run `ollama serve` (or confirm it's already running via `curl.exe http://localhost:11434/api/tags`).
3. In Settings, switch **Provider** to Local, leave the URL as `http://localhost:11434`, Save.
4. Try Alt+P again, compare speed/quality against Groq.
5. If you have an OpenAI/Anthropic/Gemini key, try **Tier: High quality** on any provider to see the frontier-model difference.

---

## Stage 6 — Build Phase 2: project-file context

This is the feature that actually differentiates Nyra from every other "rewrite my prompt" tool.

1. Decide the smallest useful scope first — a single folder of text/markdown files is enough to prove the idea.
2. Add a "Connect project folder" option in the Settings window (Electron's `dialog.showOpenDialog` with `properties: ['openDirectory']` is the right API for this).
3. Before the compile call in `main.js`, read and lightly index that folder's files, then fold the most relevant snippets into the Context field passed to `compilePrompt`.
4. Test the same way as Stage 3: does the compiled prompt reflect real details from your connected project, not just generic phrasing?

---

## Stage 7 — Package it as a real installer

Once Stage 3–6 feel solid:
```
npm run build:win     # run this ON Windows, produces a .exe installer
npm run build:mac     # run this ON a Mac, produces a .dmg
```
- No app-store fee or review needed for sharing the installer directly (e.g. from your own website or a Google Drive link).
- Before this step, replace the placeholder tray icon (`settings/tray-icon.png`) with a real design — it matters for first impressions once anyone besides you is installing this.
- Windows may show a SmartScreen warning for an unsigned installer the first time someone runs it; this is normal for a new app without a paid code-signing certificate, and doesn't block installation, it just requires clicking "More info → Run anyway."

---

## Stage 8 — After people other than you are using it

- Keep an eye on Ollama/Groq/OpenAI/Anthropic/Gemini model name changes — `MODEL_MAP` in `compiler.js` (and mirrored in `settings/settings.js`) is the one place to update when a provider renames or retires a model.
- Decide the default-provider question from the spec once you see how many people have Ollama installed already vs. how many want zero-setup (Groq).
- Only revisit a hosted backend (Stage "later" in the spec) if you want to stop requiring your own API key from every user, or want usage analytics.

---

## Quick reference: where everything lives

| What | File |
|---|---|
| Tray icon, hotkey, select/copy/compile/paste loop | `main.js` |
| The actual LLM call (all providers, local + hosted) | `compiler.js` |
| The prompt-compiling instructions the model follows | `SYSTEM_PROMPT` inside `compiler.js` |
| Fast vs. quality model names per provider | `MODEL_MAP` (top of `compiler.js`, mirrored in `settings/settings.js`) |
| Settings window UI | `settings/settings.html`, `settings.js` |
| Packaging config (installer output) | `build` section of `package.json` |

## If you ever want the browser-extension version instead
It still exists and still works as a standalone alternative (`promptos/extension/` from the earlier scaffold) — useful if you specifically want in-page injection inside a browser tab rather than a system-wide hotkey. Not the primary path, but not gone.
