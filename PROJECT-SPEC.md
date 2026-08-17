# Nyra — Project Spec & Roadmap (v2: Desktop-first)

*(Working name — swap freely, see naming notes at the end)*

## One-line pitch
A small background desktop app (Windows + Mac) that turns a rough, one-line idea into a fully structured, model-ready prompt — with a single hotkey (Alt+P), working inside ChatGPT, Claude, Gemini, VS Code, Word, or anywhere else you can type, with no daily limit and a genuinely free/unlimited tier.

## How the plan changed, and why
The original plan (see "v1" history below) was a browser extension that injected a button into each AI site's chat box. That's still a valid approach, and the scaffold for it exists — but two things pushed the plan toward a desktop app instead:
1. **Publishing a Chrome extension costs a one-time $5 Chrome Web Store fee** and requires a review process. A desktop app has neither requirement.
2. **A browser extension can only ever work inside a browser tab.** It can't reach VS Code, Word, or any other native app — and every "future AI model" would need its own site-specific adapter written and maintained as that site's HTML changes.

The desktop app solves both: it operates on **whatever text field currently has focus**, using the operating system's own clipboard rather than reading any particular site's HTML. That means zero per-site code, and it works in literally anything with a text field — including apps that don't exist yet.

## What we are explicitly NOT doing
- Not training a custom model. Every free-tier or paid option researched (Groq, OpenRouter, Ollama's model library, GPT/Claude/Gemini) already covers this need without training anything.
- Not maintaining per-site DOM selectors as the primary path anymore — that fragility (sites changing their HTML) is exactly what the desktop pivot avoids.
- Not requiring a hosted backend for every provider — Local/Groq/OpenAI/Anthropic/Gemini all still call providers (or your local Ollama) directly from the desktop app. The one exception is the optional **Nyra Cloud** provider (see below), a small proxy backend that now exists specifically so a friend can use Nyra with zero API key of their own.

## Architecture (current, desktop-first)
```
User types a rough prompt in ANY app, focuses that text field
   -> Selects it and copies it themselves (Ctrl+C / Cmd on Mac)
   -> Presses Alt+P (global hotkey, OS-level, not tied to any window)
   -> Nyra reads the clipboard, saves a backup copy (recoverable from the tray menu)
   -> Sends it to the chosen provider: one LLM call, using the same
      Role / Context / Task / Constraints / Output Format structure
      from the original sample
   -> Writes the compiled result to the clipboard
   -> User pastes it back into the same field themselves (Ctrl+V / Cmd on Mac)
```
This keeps the core idea from the very first architecture discussion (one LLM call, IR-shaped output, adapter layer) — the "adapter" is no longer a per-site DOM script, it's the OS-level clipboard, which is universal by construction. (An earlier version tried to automate the copy/paste steps too via a keyboard-simulation library, but its simulated keystrokes weren't reliably reaching every app on Windows, so the current design keeps copy/paste manual and relies only on the clipboard, which has no such dependency.)

## Providers and tiers (implemented in `compiler.js` / the settings window)
"Free and unlimited" from a hosted API provider doesn't really exist — every free tier researched enforces real rate limits (Groq: ~30 req/min, ~1,000 req/day; OpenRouter free models: 20 req/min, 50–1,000/day, plus a roster that rotates month to month). The only genuinely free-and-unlimited option is **self-hosted, open-weight inference** — cost becomes your own compute, not a per-request fee, with no external party to impose a limit.

The resulting design, five providers, two tiers each where applicable:
- **Nyra Cloud** — free, shared, **no API key needed at all**. A small proxy backend (`backend/`, deployed on Render, see `backend/README.md`) holds one Groq key privately and exposes a `/compile` endpoint; the desktop app just points `backendUrl` at it (`compiler.js`'s `callNyraCloud`). This is the first/default option in Settings — the lowest-friction way for someone besides the app's owner to try Nyra with zero setup. Same free-tier rate limits as Groq apply underneath, and Render's free instance sleeps after 15 min idle (~30-50s cold-start on first compile after a gap).
- **Local (Ollama)** — free, unlimited, quality capped only by your hardware. Fast: Llama 3.1 8B (or Qwen2.5 1.5B for lower-RAM machines). Quality: Qwen3 32B (needs decent hardware). Not yet the out-of-the-box default — planned as a next addition alongside Nyra Cloud/Groq.
- **Groq** — free API key (no card), runs large models fast, but genuinely rate-limited — the original active default before Nyra Cloud existed, still fully supported for anyone who wants their own key instead of the shared backend. Uses `openai/gpt-oss-20b` (fast) and `qwen/qwen3.6-27b` (quality) — Groq deprecated its original Llama 3.1/3.3 models on June 17, 2026, so these are the current correct model names, not the ones originally planned.
- **OpenAI / Anthropic / Gemini** — paid, bring-your-own-key, frontier quality, high but real provider-side rate/spending limits.

Stated plainly: **free + unlimited + frontier-quality — pick two.** Local gets free + unlimited at good-not-frontier quality (or great quality on strong hardware). Groq gets free + better quality at a real rate limit. Paid APIs get frontier quality + high limits at real cost.

## Phases

### Phase 1 (in progress) — Desktop MVP
- Electron app, tray/menu-bar icon, global hotkey (Alt+P).
- Manual select → copy → hotkey → compile → paste loop via the OS clipboard (no keyboard-simulation library — see architecture note above).
- Settings window: provider, tier, API key, Ollama URL.
- Original prompt always recoverable (tray menu → "Restore last original prompt") even though the clipboard gets overwritten with the compiled version.
- No daily cap, no call counter, anywhere in the pipeline — by design.

**Current status:** code scaffold complete (`promptos-desktop/`), `npm install` succeeded, app confirmed running on Windows (Mac launch currently broken — see `MEMORY.md` for the active signing/Gatekeeper investigation). **Nyra Cloud is now the default provider in Settings** (zero setup, no key needed, backed by the deployed `backend/` proxy) — Groq with your own key remains fully supported as an alternative. Local (Ollama, Llama 3.1 8B / Qwen2.5 1.5B / Qwen3 32B) remains the free-and-truly-unlimited option and is planned as a next addition, not abandoned.

### Phase 2 — Context from project files
- Let users connect a folder / repo / doc set.
- Fold relevant snippets into the Context field before the single LLM call — this is the real differentiator versus every other "rewrite my prompt" tool, none of which read your actual project.

### Phase 3 (optional, later) — Browser extension as a secondary option
- The original browser-extension scaffold (`promptos/extension/`) still exists and still works as a standalone alternative for people who specifically want in-page injection inside a browser tab (e.g. a floating button rather than a hotkey). Not the primary path going forward, but not deleted — revisit only if real usage shows a need for it.

### Phase 4 — Distribution
- Package with `electron-builder`: `npm run build:win` for a Windows installer (build on Windows), `npm run build:mac` for a Mac installer (build on a Mac — cross-building reliably from one OS to the other isn't practical with Electron).
- No app-store fee or review process required for direct-download distribution (e.g. sharing the installer from your own site) — only needed if you later want it listed in the Mac App Store or similar.

## Open decisions (deliberately left open, revisit with real usage data)
- Final name (see shortlist below).
- ~~Default provider for new users~~ — resolved: Nyra Cloud (zero setup, no key) is now the out-of-the-box default, with Local/Groq/paid APIs as alternatives.
- Whether the browser-extension path (Phase 3 above) is ever worth reviving as a parallel option.
- Whether/when a custom model is ever worth training (only revisit if usage data shows off-the-shelf/local models are a real quality bottleneck — no evidence of this yet).

## Naming shortlist
- Nyra
- IntentForge
- Contexa
- Primer
- Relay / PromptRelay

---

## Appendix: v1 history (browser-extension-first plan)
The original plan targeted a Manifest V3 Chrome extension with per-site content scripts (ChatGPT, Claude, Gemini) injecting a floating compile button into each site's composer. That scaffold is complete and functional in principle (`promptos/extension/`), including the same provider/tier logic now mirrored in the desktop app. It was superseded as the *primary* path once the requirement expanded to "must also work inside VS Code" and "must avoid the Chrome Web Store fee" — both of which a desktop app satisfies directly and a browser extension structurally cannot.
