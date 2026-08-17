# Nyra — Working Memory

Read this before starting new work on this project; update it after every meaningful change instead of re-deriving history from git log / re-reading the whole tree each session.

## What this is
Electron tray/menu-bar app ("Nyra", package name `nyra-desktop`). User copies text anywhere, presses a global hotkey (Alt+P), Nyra reads the clipboard, sends it to an LLM provider (Groq/OpenAI/Anthropic/Gemini/local Ollama, see `compiler.js`) to "compile" it into a structured Role/Context/Task/Constraints/Output-Format prompt, writes the result back to the clipboard for the user to paste. Targets both Windows and Mac from one codebase (`electron-builder`, `npm run build:win` / `build:mac`).

## Current status
Windows build confirmed working (`npm run build:win` succeeds, produces `dist/win-unpacked/Nyra.exe` + NSIS installer). Mac build was previously fully unsigned and hard-blocked by Gatekeeper on Apple Silicon ("The application 'Nyra' can't be opened", no override) — fixed this session via an `afterSign` ad-hoc-signing hook wired into `package.json`, so every Mac build path (local `npm run build:mac`, `build-mac.yml`, `release.yml`) signs automatically now. Not yet verified on an actual Mac (no macOS machine available in this session) — next real Mac build (manual `build-mac.yml` run or a new `v*` tag push) should be checked for: (1) app opens without the hard Gatekeeper block — the milder "unidentified developer, right-click → Open" prompt is expected and fine, (2) tray icon renders correctly (monochrome, adapts to light/dark menu bar) instead of the old oversized/wrong-colored icon.

## Changelog (most recent first)
- 2026-08-17: Diagnosed and fixed the Mac "can't be opened" launch failure.
  - **Root cause**: `package.json` `build.mac.sign: null` skips electron-builder's own signing, and the tag-triggered `release.yml` pipeline (the actual release path) never signed the app at all — unlike the separate manual `build-mac.yml` workflow, which already ad-hoc signed inline. Fully unsigned apps are hard-blocked on Apple Silicon with no user override.
  - **Fix**: added `build/afterSignHook.js` (electron-builder `afterSign` hook, ad-hoc `codesign --sign - --force --deep`, darwin-only) + `"afterSign": "build/afterSignHook.js"` in `package.json`'s `build` block. This covers all three Mac build paths from one place. Simplified `build-mac.yml` to drop its now-redundant manual codesign step (kept a verify step).
  - Also fixed: Mac menu-bar tray icon wasn't a template image (`main.js` — `createTray()` now uses `nativeImage` + `setTemplateImage(true)` on darwin only).
  - Also fixed: `BUILD-GUIDE.md` and `PROJECT-SPEC.md` both described automatic nut-js-based keystroke automation that was removed from the code long ago (`main.js:99-104` has the removal rationale) — corrected both docs to describe the real manual-copy → hotkey → manual-paste flow, matching `main.js` and `README.md`.
  - Verified `npm run build:win` still succeeds after the `package.json` `build` block edit.
  - Excluded the new `MEMORY.md` from the packaged app (`build.files` in `package.json`), matching the existing pattern for `README.md`/`BUILD-GUIDE.md`/`PROJECT-SPEC.md`.
  - Windows-side code/config untouched throughout — no changes needed there.

## Planned / open
- Generate a real `build/icon.icns` from proper source artwork (needs a ~1024x1024 source image, not currently available — app ships with Electron's default icon on Mac until then). Skipped deliberately this round per user.
- No current plan to reintroduce automatic keystroke simulation (nut-js or otherwise) — current clipboard-only design was a deliberate reliability fix, not an oversight. Revisit only if manual copy/paste proves to be a real usability problem in practice.
- **Still needs verification**: fix is committed and pushed (`27aeb53` on `main`, 2026-08-17) but not yet confirmed on real macOS. No `gh` CLI or GitHub token available in this dev environment, so the user needs to manually run `build-mac.yml` via the Actions tab (or push a `v*` tag for `release.yml`) and check the "Verify ad-hoc signature" step passes, then test the downloaded app actually opens on their Mac without the Gatekeeper hard-block.

## Open questions for the user
- None outstanding right now.
