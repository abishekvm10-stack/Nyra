# Nyra Desktop \u2014 works everywhere, one hotkey, fully automatic

No Chrome Web Store, no $5 fee, no per-site code to maintain. This runs
as a small background app with a tray/menu-bar icon. It works in
ChatGPT, Claude, Gemini, VS Code, Word, Notes, anywhere \u2014 because it
operates on whatever text field currently has focus, not on any
particular site's code.

## Current status (what's actually running right now)
**Provider: Nyra Cloud** is the default in Settings — free, shared, no API key needed at all. It works by pointing the app at a small proxy backend (`backend/`, deployed on Render) that holds one Groq key privately; see `backend/README.md` if you want to deploy your own instance. Since it's a free Render instance, the first compile after 15+ minutes idle takes ~30-50s to wake up, then it's fast.

**Provider: Groq** (`openai/gpt-oss-20b` fast / `qwen/qwen3.6-27b` quality) remains fully supported if you'd rather use your own key instead of the shared backend — it needs no local model, no Ollama service, nothing else running in the background, just a free API key from console.groq.com.

**Ollama (Local provider) is a planned future addition, not yet in active use.** The code path for it already exists (`compiler.js`'s `callLocal` function, and the Local option in Settings) — it's there and functional, just not the one currently configured. When you're ready to add it back in as a free/unlimited option alongside Groq, the plan is:
- `llama3.1:8b` as an ultra-lightweight local fast tier (~6-8GB RAM), or
- `qwen2.5:1.5b` as an even lighter option (~1.5-2.5GB RAM) for lower-spec machines, added as a third rung between the two.

## How it works, day to day
1. Select your rough prompt anywhere (a ChatGPT tab, VS Code's chat panel, wherever), press **Ctrl+C**.
2. Press **Alt+P**.
3. Nyra compiles it and puts the result back in your clipboard \u2014 you'll get a small notification when it's done.
4. Press **Ctrl+V** in the same spot to paste the compiled version.

**Optional: pick an AI agent (and model) in Settings** — e.g. Claude → Sonnet 5, ChatGPT → GPT-5, or "Other" and type anything not listed — and the compiled prompt's structure/phrasing gets tailored to that agent/model's conventions, not just generic Role/Context/Task/Constraints/Output Format text.

This uses only Electron's built-in clipboard API \u2014 no keyboard-simulation library, no native automation dependency, nothing that can fail silently depending on your machine's setup. An earlier version tried to automate the select/copy/paste steps too, but that required a third-party keyboard-simulation library whose simulated keystrokes didn't reliably reach Windows on every machine (no visible error, it just silently did nothing). This manual-keystroke version trades two extra keypresses for something that will actually work reliably everywhere.

## Requirements
- [Node.js](https://nodejs.org) installed (LTS version is fine).
- Ollama running locally if you want the free/unlimited Local provider
  (`ollama pull llama3.1:8b`, `ollama serve`).

## Run it (development mode, same steps on Windows and Mac)
```
cd promptos-desktop
npm install
npm start
```
The first time it runs, a Settings window opens automatically \u2014 pick
your provider (Local is free), tier, and (if not Local) paste an API
key. Save, then close the window; Nyra keeps running in the
tray (Windows) or menu bar (Mac). Right-click the tray icon any time
to reopen Settings, restore your last original prompt, or quit.

## Getting a Mac version, without owning a Mac
Electron-builder's Mac target needs actual macOS-only tools that don't
exist on Windows \u2014 `npm run build:mac` will not work if you run it
here. The real fix: GitHub Actions can build it for you on a genuine
Mac in the cloud, for free.

**One-time setup:**
1. Create a free [GitHub](https://github.com) account if you don't have one.
2. Create a new repository (can be private), and push this whole
   `promptos-desktop` folder to it. If you're not familiar with git,
   the simplest path is: install [GitHub Desktop](https://desktop.github.com),
   open it, "Add local folder" \u2192 pick this folder \u2192 "Publish repository."
3. The workflow file at `.github/workflows/build-mac.yml` is already
   included \u2014 nothing more to configure.

**Every time you want a fresh Mac build:**
1. On GitHub.com, open your repository \u2192 the **Actions** tab.
2. Click **Build Mac installer** in the left sidebar \u2192 **Run workflow** \u2192 **Run workflow** button.
3. Wait a few minutes (a real Mac in the cloud is building your app).
4. Once it finishes (green checkmark), click into that run \u2192 scroll
   down to **Artifacts** \u2192 download **Nyra-mac-installer** (a zip
   containing the `.dmg`).

**Sending it to your friend:**
1. Send them the `.dmg` file (unzip it first \u2014 GitHub wraps artifacts in an extra zip).
2. They double-click it, drag Nyra into their Applications folder.
3. **First launch will show a Gatekeeper warning** ("Nyra can't be
   opened because it's from an unidentified developer") \u2014 this is
   Mac's equivalent of Windows SmartScreen, and happens because the
   app isn't code-signed with a paid Apple Developer certificate
   ($99/year). They should **right-click the app \u2192 Open** (not
   double-click) the first time, then confirm in the dialog that
   appears \u2014 this bypasses the warning permanently for that app.
4. After that first right-click-Open, it runs completely normally.

If macOS still says **“The application Nyra can't be opened”** after extracting
the download, remove the download quarantine flag in Terminal and try again:
```
xattr -dr com.apple.quarantine /Applications/Nyra.app
open /Applications/Nyra.app
```
Replace the path if you put Nyra somewhere else. The macOS workflow builds a
universal app, so the same download works on both Intel and Apple-silicon Macs.

This whole pipeline is free and repeatable \u2014 every time you update
Nyra, push the change to GitHub and re-run the workflow for a fresh
build on both platforms.

## Packaging it as a real installable app (Windows, on your own machine)
Once it's working well in dev mode:
```
npm run build:win
```
Run this **on Windows** (not in this sandbox, not on Mac). It produces
a proper `.exe` installer in a new `dist/` folder \u2014 double-click that
to install Nyra like any normal Windows app, with a Start Menu entry
and desktop shortcut.

Once installed this way:
- Nyra launches automatically at Windows startup by default (toggle
  this off any time via the tray icon \u2192 **Launch at startup**).
- You never need to open PowerShell or run `npm start` again \u2014 it's
  a real background app now, just like Handy.
- Windows may show a **SmartScreen warning** the first time you run
  the installer, since it isn't signed with a paid code-signing
  certificate. Click **More info \u2192 Run anyway**. This is normal for
  a new, unsigned app and doesn't mean anything is wrong.

For a Mac version: `npm run build:mac`, run **on an actual Mac** \u2014
cross-building a Mac installer from Windows isn't practical with
Electron.

## Known rough edges (expected at this stage)
- **Replace the placeholder tray icon** (`settings/tray-icon.png`)
  before sharing this with anyone else \u2014 it's a generated stand-in.
- **Hotkey is configurable** (Settings → click the Hotkey field, then press a combo) — defaults to Alt+P. Needs at least one modifier (Ctrl/Alt/Shift); if a saved combo stops working (e.g. another app claims it between sessions), Nyra falls back to Alt+P automatically and tells you.
- **You select the text yourself now** (Ctrl+C before, Ctrl+V after) \u2014
  this is a deliberate simplification after the automatic version
  proved unreliable, not a regression to fix later.
- **No project-file context yet** \u2014 this only works on whatever's in
  the focused field.
- **Can't be tested inside this sandbox** \u2014 it needs a real desktop
  with a display, global hotkey support, and OS-level input
  simulation. Run it directly on your own machine.

## Where everything lives
| What | File |
|---|---|
| Tray icon, hotkey, select/copy/compile/paste loop | `main.js` |
| The actual LLM call (all providers, local + hosted) | `compiler.js` |
| Settings window UI | `settings/settings.html`, `settings.js` |
| Fast vs. quality model names per provider | `MODEL_MAP` (top of `compiler.js`, mirrored in `settings.js`) |
| Nyra Cloud's shared backend (deploy/redeploy instructions) | `backend/` (see `backend/README.md`) |
| Target-model prompt tuning (Claude/GPT/Gemini/local hints + fallback for unlisted models) | `compiler.js`'s `getTargetModelGuidance`, mirrored in `backend/server.js` |
| Packaging config (installer output, Mac ad-hoc signing hook) | `build` section of `package.json`, `build/afterSignHook.js` |
| Running log of what's changed and what's still open | `MEMORY.md` |
