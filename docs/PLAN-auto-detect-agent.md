# Plan: auto-detect the target agent and model

> **Status: approved, not implemented.** Parked 2026-08-19 at the user's
> request ("we can implement it later"). Everything below was researched and
> measured against this codebase — the verification table is real findings,
> not estimates. Pick this up as-is; no re-research needed.

## Context

`targetAgent` and `targetModelName` are manual dropdowns in the Tuning tab that
a user sets once and forgets. In practice they go **stale and wrong** — someone
configures "Claude", then spends the day in Cursor, and every compile is tuned
for the wrong target. That quietly undermines the entire per-agent prompt system
rebuilt on 2026-08-19.

Nyra can just know. At hotkey press it can see which app is focused, and for
several agents it can read which model that agent is actually configured to use.

Decisions taken with the user:
- **Model falls back to per-agent memory** when it can't be detected (also fixes
  a standing annoyance — today switching agents *wipes* the model field,
  [settings.js:466-470](../settings/settings.js)).
- **On by default, never silent** — every compile names what it detected, so a
  wrong guess is visible and correctable.
- **UI scope: status bar + Tuning tab**, reusing the existing shell rather than
  adding a Home dashboard.

Two findings during planning changed the design materially, and both are worth
reading before implementing: a live "what Nyra sees now" panel is impossible
(risk 4), and macOS browser tabs are recoverable after all (risk 1).

---

## What was actually verified (measured on this machine, not assumed)

| Finding | Evidence |
|---|---|
| `getActiveWindow()` works and is **free** | Measured 5 runs: **0ms avg**. Won't undo the latency work from earlier that day. |
| Window titles carry the agent | Real titles captured: `MEMORY.md - Nyra - Visual Studio Code`, `RL Exam Preparation and 19 more pages - Personal - Microsoft Edge` |
| **`AGENT_PROFILES` regexes can NOT be reused directly** | VS Code's title says `Visual Studio Code`, which matches none of `prompt-kit.js`'s `copilot` pattern. Detection needs its **own** title→agent table. |
| Claude Code's model **is** readable | `~/.claude/settings.json` → `model: "opus"` |
| Cursor's model is **not** readable | No model-ish key anywhere in `AppData/Roaming/Cursor/User/settings.json` |
| Ollama's API is live and usable | `GET /api/ps` responded `{"models":[]}` |
| **macOS window titles cost Screen Recording** | `libnut-darwin/permissionCheck.js:77` — `screenCaptureAccess = ["getWindowTitle", "captureScreen"]`. This drives the platform split. |

---

## Architecture

**New file `detect.js`** (root level, ships with the app). Exports:

```js
detectContext(settings)   // -> { agent, model, source, confidence } | null
```

It slots in **above** the existing compile path and requires **zero changes to
`compiler.js` or `prompt-kit.js`**. `compilePrompt()` already reads
`settings.targetAgent`/`targetModelName` through `getTargetModelLabel()`
(`compiler.js:41`), so `handleHotkey()` just builds an *effective settings*
object with those two fields overridden and passes it down. The whole feature is
additive.

### Agent detection — the platform split is mandatory, not cosmetic

- **Windows**: `getActiveWindow().title` via the already-installed
  `@nut-tree-fork/nut-js`. No permission, no new dependency.
- **macOS**: **must not** use nut-js's title API — that would demand **Screen
  Recording**, far heavier than the Accessibility grant automation already needs.
  Instead shell out to `osascript`:
  ```
  tell application "System Events" to get name of first application process whose frontmost is true
  ```
  This needs only **Accessibility**, already granted for automation. It returns
  the *app name* (`Cursor`, `Code`, `Terminal`), enough for every desktop agent.
  When the frontmost app is a **scriptable browser**, a second AppleScript asks
  that browser for its active tab title (risk 1) — so `claude.ai` resolves on
  macOS too, at the cost of a one-time per-browser Automation prompt shown only
  when the user is actually in that browser. **Firefox is the one genuine gap**
  (no AppleScript tab API) and degrades to app-name only.

A dedicated `WINDOW_AGENT_RULES` array maps title/app patterns to agent names,
ordered so **`claude code` is tested before `claude`** and `cursor` before
generic editors — the same ordering hazard already documented in `prompt-kit.js`.

### Model detection — honest about where it works

Tried in order, first hit wins:

1. **Agent config probe** — `Claude Code` → `~/.claude/settings.json`'s `model`
   (verified working). `opencode` / `Aider` → their config files, written
   defensively since neither exists on this machine to verify against.
2. **Ollama** — when the provider is `local`, `GET {ollamaUrl}/api/ps` gives the
   *currently loaded* model.
3. **Per-agent memory** — a new `modelByAgent` map in `electron-store`.
4. **Manual `targetModelName`** — today's behavior, as the final fallback.

`source` and `confidence` come back with the result purely so the UI can be
honest about *why* it thinks what it thinks.

---

## Phases

### Phase 1 — `detect.js` + wiring (no UI yet)
Build `detect.js` with the platform split, `WINDOW_AGENT_RULES`, and the model
strategy chain. Wire into `handleHotkey()` in `main.js`: detect → build effective
settings → compile. Add `modelByAgent` to the store, written after every
successful compile so memory builds up from real use.

**Non-negotiable**: detection is wrapped so it can never break compiling. Any
throw, timeout, or missing permission returns `null` and Nyra silently uses
today's manual settings. A failed detection must degrade to current behavior,
never to an error.

### Phase 2 — Make it visible
- **Notification**: `"Compiled for Cursor · Sonnet 5"` instead of `"Compiled."`
- **Status bar**: the existing bar (`settings.html:390-393`) shows the **last**
  detection, refreshed by `refreshStatusLine()`.
- **Tuning tab**: a "Last compile" row showing agent · model · source with a
  **[Wrong? Fix]** control. The existing agent/model selects stay, relabelled as
  the fallback for when detection can't tell.
- **General tab**: an "Auto-detect target agent" toggle (default **on**) whose
  sub-label states plainly that it reads the focused window title on this device
  only, never stores or transmits it.

Persist the last detection in the store (`lastDetection`) rather than adding a
live-read IPC — per risk 4, a live read is meaningless while Settings has focus,
and this needs no polling.

### Phase 3 — Per-agent model memory + correction learning
Replace the wipe-on-agent-change in `settings.js:466` with a lookup into
`modelByAgent`. Migration needs no versioning: on first run, seed
`modelByAgent[currentAgent] = targetModelName` from the existing single field, so
nobody loses their setting.

Wire **[Wrong? Fix]** to write both maps — `modelByAgent[agent] = model` and,
when the last detection came from an unrecognized window,
`agentByApp[pattern] = agent` (risk 2). This is what makes the long tail of
terminals and custom setups a one-time correction instead of a permanent miss.

---

## Design

### The core design problem

Every row in Nyra currently looks **identical in weight**: label left, control
right, 13px title, 11px sub. Correct for a settings list, but it means there is
no visual hierarchy anywhere in the app.

Detection isn't a setting — it's **state**. Rendering it as one more `.row` would
bury the most important new information in the app. The main design change is
introducing a second visual language for *state* alongside the existing one for
*config*.

### 1. A detection readout, not another row

```
┌─────────────────────────────────────────────────┐
│  LAST COMPILE                                   │  ← uppercase 10px, --text-muted
│                                                 │
│   ┌──┐                                          │
│   │Cu│  Cursor  ·  Sonnet 5                     │  ← 15px, --text
│   └──┘  from window title · remembered model    │  ← 11px, --text-muted
│                                    Wrong? Fix   │  ← quiet text button
└─────────────────────────────────────────────────┘
   ↑ --bg-raised, not --bg-surface
```

Three deliberate departures from the current rows:

- **`--bg-raised` (`#1b1830`) instead of `--bg-surface`** — an existing token
  that's barely used. Lifts the card off the page without inventing new color.
- **15px agent name** — the app currently tops out at 13px. One step up
  establishes "this is the headline of this tab."
- **The `from window title · remembered model` line does real work.** It's the
  difference between a feature that feels trustworthy and one that feels like
  magic guessing at you.

### 2. Reuse the badge that already exists

Provider tiles already use `.tile-mark` (`settings.css:373`) — 28px rounded
square, bold white monogram, per-provider color. Reuse that exact component for
agents rather than inventing anything: `Cu` Cursor, `CC` Claude Code, `oc`
opencode, `Cl` Claude. No new assets, no icon set to source, and it visually ties
the Tuning tab to the Provider tab.

### 3. Tuning tab gets a real hierarchy

Today it's a flat list of cards. Detection forces a split the tab honestly needed
anyway:

```
Tuning
  ┌─ LAST COMPILE ─────────────────┐   ← state: what happened
  │  Cursor · Sonnet 5             │
  └────────────────────────────────┘

  ┌─ WHEN NYRA CAN'T TELL ─────────┐   ← config: your fallback
  │  Agent   [ Claude        v ]   │
  │  Model   [ Opus 5          ]   │
  │  Task    [ Auto          v ]   │
  └────────────────────────────────┘

  ┌─ TRY IT ───────────────────────┐
  └────────────────────────────────┘
```

Small uppercase section labels above card groups — a device the app doesn't
currently use at all. It also reframes the existing agent/model dropdowns
honestly: they stop being "the setting" and become "the fallback," which is what
they actually are now.

### 4. Status bar rebalance

Currently `● Ready · Nyra Cloud · Alt+D · Auto-paste on` — all *static config*
that never changes, so users stop reading it. Detection is the one genuinely live
thing in the app and should take that slot:

```
● Ready  ·  last: Cursor · Sonnet 5  ·  Alt+D
```

### 5. Keep the correction affordance quiet

**Wrong? Fix** must not be a `.btn-secondary` — it would compete with the primary
content and imply something's broken. A muted text link in `--text-dim`, going
`--accent` on hover. Always present (not hover-only, which hides it from touch
and keyboard users), just visually recessive.

### 6. Empty state

```
┌─ LAST COMPILE ──────────────────────────┐
│   Nothing compiled yet                  │
│   Press Alt+D in any app to see what    │
│   Nyra detects.                         │
└─────────────────────────────────────────┘
```

**Deliberately not doing:** no accent rail down the card, no gradient, no emoji
section markers. The existing design is restrained and coherent; the win is
adding *hierarchy*, not decoration.

---

## Worked example (what the user actually experiences)

You select `the login keeps failing after the token refresh, fix it` in Cursor
and press **Alt+D**:

```
t=0ms      Alt+D fires
           ├─ capture selection (select-all + copy)  ──┐ CONCURRENT
           └─ detect context                         ──┘

t=0ms      reads foreground title "auth.ts - myapp - Cursor"
           → agent = Cursor
           → no config probe exists for Cursor (verified)
           → modelByAgent["Cursor"] = "Sonnet 5"
           → title discarded, never stored

t=230ms    capture finishes (detection was free)
t=~1500ms  pasted.  Notification: "Compiled for Cursor · Sonnet 5"
```

Output uses the **coding-agent** shape (Markdown headers, no Role, with Verify
and Done When) rather than the `<task>` XML it would have produced if the Tuning
tab still said "Claude" from last week.

| You're in | Detected | Model from | Shape |
|---|---|---|---|
| Cursor | Cursor | remembered | `## Task` / `## Done When` |
| Terminal w/ Claude Code | Claude Code | **probed live** → `opus` | `## Task` / `## Done When` |
| claude.ai in Chrome | Claude | remembered | `<task>` / `<constraints>` |

**When it can't tell** (e.g. opencode inside WezTerm): returns `null`, uses your
configured fallback, notification says `Compiled for Claude · Opus 5 (from
settings)`. You click **[Wrong? Fix]** → picks opencode → writes
`agentByApp["WezTerm"] = "opencode"`. Next Alt+D in WezTerm detects correctly.
One correction, permanent.

---

## Files

| File | Change |
|---|---|
| `detect.js` | **New** — `detectContext()`, `WINDOW_AGENT_RULES`, `MODEL_PROBES`, platform split, `withTimeout` |
| `tools/detect.test.js` | **New**, dev-only — title→agent fixtures incl. the real captured titles; asserts no raw title escapes and unknown → `null` |
| `main.js` | `handleHotkey()` runs detection concurrently via `Promise.all`; writes `lastDetection` / `modelByAgent`; detection named in the notification |
| `settings/preload.js` | Bridge `nyra:correct-detection` (the **[Wrong? Fix]** write path) |
| `settings/settings.html` | "Last compile" row in Tuning, last-detection text in the status bar, auto-detect toggle in General |
| `settings/settings.js` | Render last detection + source line, wire **[Wrong? Fix]**, per-agent model lookup replacing the wipe at line 466 |
| `settings/settings.css` | State-vs-config visual language; reuse `.tile-mark` for agent badges; section labels |
| `compiler.js`, `prompt-kit.js` | **Untouched** — the feature slots in above them |

**New `electron-store` keys**: `autoDetect` (bool, default `true`),
`lastDetection` (`{agent, model, source}`), `modelByAgent` (`{agent: model}`),
`agentByApp` (`{pattern: agent}` — learned corrections).

---

## Risks — engineered out, not merely mitigated

### 1. macOS browser tabs — solved with per-app Automation, not accepted as a gap

Screen Recording is avoided by the `osascript` app-name route, but that alone
left "a `claude.ai` tab is only 'Chrome' on macOS" as a permanent limitation. It
doesn't have to be. **Ask the browser directly:**

```applescript
tell application "Google Chrome" to get title of active tab of front window
tell application "Safari"        to get name  of current tab of front window
```

Chromium browsers (Chrome, Edge, Brave, Arc) share the first form; Safari uses
the second. This needs **Automation** permission for that one app — a granular,
one-time "Nyra wants to control Google Chrome" prompt — dramatically lighter than
Screen Recording, and only ever requested **when the user is actually in a
browser**, not on first hotkey press.

**Honest remaining gap: Firefox exposes no AppleScript tab API.** It resolves to
app-name only and falls through to remembered/manual. Real limitation with no
workaround short of Screen Recording; state it in the UI rather than paper over it.

### 2. Wrong detection — solved by confidence gating plus learning from corrections

Displaying the guess makes it *correctable*; it doesn't make it *correct*.

- **Confidence gate**: only override the manual setting on a confident match. An
  unrecognized title yields `null`, not a guess. Silence beats a confident wrong
  answer.
- **Learn from overrides**: when the user corrects a detection, store
  `appPattern → agent` in `agentByApp`. This turns the long tail of terminals,
  IDEs, and custom setups from a permanent miss into a one-time correction — the
  same self-improving loop that makes per-agent model memory work.

### 3. Breaking or slowing the compile — solved structurally by running it concurrently

```js
const [captured, detected] = await Promise.all([
  captureSelection(),                        // ~230ms of automation
  withTimeout(detectContext(settings), 250)  // resolves null on timeout
]);
```

Automation already spends ~230ms on select-all + copy. Detection finishes inside
that window and costs **zero added latency**. `withTimeout` means even a hung
`osascript` (the one call with real spawn cost, ~50-150ms, unverifiable from
Windows) can never delay a compile — it just yields `null`.

### 4. Privacy — solved by never retaining the title, and by deleting the polling entirely

- **Map and discard.** The raw title is converted to an agent name inside
  `detect.js` and never returned, stored, or logged. Only `"Cursor"` escapes —
  never `"Bank statement 2026 - Chrome"`. Error paths must not include it either.
- **No polling at all** — which also fixes a real design flaw found while
  reviewing this: **when the Settings window is focused, the foreground window
  *is Nyra*.** Verified directly — it returns `"...- Nyra - Visual Studio Code"`.
  A live "Right now Nyra sees" panel could therefore only ever detect Nyra
  itself, making it both useless and a reason to poll. **Replaced with "Last
  compile"** — informative, needs no polling, reads the foreground window
  strictly at hotkey press. One change removed a broken feature and a privacy
  surface together.

### 5. Config-probe fragility — solved with a validated, data-driven probe table

```js
const MODEL_PROBES = [
  { agent: "Claude Code", paths: ["~/.claude/settings.json"], extract: j => j.model },
  { agent: "opencode",    paths: [...],                       extract: j => j.model },
];
```

Each probe declares multiple candidate paths, and every extracted value is
**validated as a plausible model string** (non-empty, sane length, no path
separators) before use — so a schema change yields a miss that falls through to
remembered-model, never a garbage value silently poisoning the prompt. Cached
with a short TTL so probes don't touch disk on every hotkey press.

---

## Verification

**Automated / in-sandbox:**
- `node -c` on every edited file.
- A `detect.js` unit suite (following `tools/sanitizer.test.js`'s pattern) using
  the **real captured window titles** above, asserting correct agent resolution
  and, critically, that `claude code` never resolves to the `Claude` chat profile.
- Model-probe test against the real `~/.claude/settings.json` (returns `"opus"`).
- Confirm detection latency stays ~0ms so the automation speedup isn't eroded.
- Assert the two hardenings that are easy to regress: `detectContext()` **never
  returns or logs a raw window title**, and an unrecognized title returns `null`
  rather than a low-confidence guess.

**On a real machine (the part that matters):**
1. Focus Cursor → hotkey → notification says "Compiled for Cursor".
2. Focus a `claude.ai` tab → says Claude.
3. **Time a compile with detection on vs. off** — confirm the `Promise.all`
   overlap holds and detection adds no measurable latency (the point of risk 3).
4. Correct a wrong detection via **[Wrong? Fix]**, repeat in the same app →
   confirm it now detects from the learned mapping.
5. Turn the toggle off → behavior returns exactly to today's manual settings.
6. Switch agent in Tuning, set a model, switch away and back → model remembered.
7. **macOS**: confirm **no Screen Recording prompt ever appears**; Cursor/VS
   Code/Terminal detect via `osascript`; focusing Chrome triggers a one-time
   *Automation* prompt then resolves tab titles; Firefox degrades without error.
