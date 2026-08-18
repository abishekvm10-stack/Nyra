// Keystroke automation for Windows and macOS. On macOS, Accessibility
// permission is bound to the app's code signature — since Nyra is only
// ad-hoc signed, every rebuild/update needs the permission re-granted.
// main.js's accessibility helpers handle checking/prompting for that;
// this file assumes the permission already exists and just sends keys.
//
// This exact feature existed before and was removed: the global
// hotkey fires while the user is still physically holding a modifier
// (e.g. Alt in Alt+P), so a synthesized Ctrl+C sent immediately
// becomes Alt+Ctrl+C and silently does nothing. releaseModifiers()
// below is the actual fix.
//
// Deliberately avoids nut-js's keyboard.type() convenience method —
// known upstream bugs leave modifier keys stuck "held" after type()
// on both Windows and macOS (nut-tree/nut.js#157, #264, traced to the
// native libnut-core layer, not application code). Explicit
// pressKey/releaseKey pairs are used instead, bracketed with a
// releaseModifiers() sweep both before AND after every shortcut as
// defense in depth against that same failure class recurring here.

let keyboard, Key, providerRegistry, loadError;
try {
  ({ keyboard, Key, providerRegistry } = require("@nut-tree-fork/nut-js"));
} catch (err) {
  loadError = err;
}

const IS_MAC = process.platform === "darwin";
const PRIMARY_MODIFIER = IS_MAC ? "LeftCmd" : "LeftControl";

// nut-js's keyboard.config.autoDelayMs defaults to 300ms and is applied
// as an await'd sleep BEFORE every single pressKey/releaseKey call — not
// a rate limit, dead time. sendShortcut() below makes 6 such calls per
// shortcut (2 releaseModifiers sweeps + press/release pairs), so the
// default costs ~1.95s per shortcut, ~5.9s for a full copy+paste cycle.
// 10ms (not 0ms) keeps a safety margin for slower targets — see
// setSpeedProfile("safe") below for the deliberate fallback.
const FAST_DELAY_MS = 10;
const SAFE_DELAY_MS = 300; // nut-js's original default, used as a retry fallback

if (keyboard) {
  keyboard.config.autoDelayMs = FAST_DELAY_MS;
  // The delay is also cached natively at import time; only touching
  // keyboard.config here would leave the native side still at 300ms.
  providerRegistry.getKeyboard().setKeyboardDelay(FAST_DELAY_MS);
}

// Switches between the fast default and a slower profile for targets
// that can't keep up with 10ms key events (rare, but real — e.g. some
// remote-desktop or Java/Electron targets). main.js retries once on
// "safe" after a fast-profile capture comes back empty.
function setSpeedProfile(profile) {
  assertAvailable();
  const ms = profile === "safe" ? SAFE_DELAY_MS : FAST_DELAY_MS;
  keyboard.config.autoDelayMs = ms;
  providerRegistry.getKeyboard().setKeyboardDelay(ms);
}

function isAvailable() {
  return !loadError;
}

function unavailableReason() {
  return loadError ? String(loadError.message || loadError) : null;
}

function assertAvailable() {
  if (!isAvailable()) {
    throw new Error(`Automation engine unavailable: ${unavailableReason()}`);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Key.LeftSuper/RightSuper cover the Windows key on win32 and (per
// libnut-keyboard.class.js) map to "meta" there too, so they're safe
// cross-platform. Key.LeftCmd/RightCmd are a separate native code that
// the win32 backend rejects outright ("Invalid key code specified") —
// verified directly against the installed libnut-win32 binding, not
// assumed — so they must only be swept on macOS. Built lazily (not at
// module scope) because Key is undefined whenever the native module
// failed to load, and this file must stay requirable in that case.
function modifierKeys() {
  return [
    Key.LeftControl,
    Key.RightControl,
    Key.LeftAlt,
    Key.RightAlt,
    Key.LeftShift,
    Key.RightShift,
    Key.LeftSuper,
    Key.RightSuper,
    ...(IS_MAC ? [Key.LeftCmd, Key.RightCmd] : []),
  ];
}

async function releaseModifiers() {
  assertAvailable();
  await keyboard.releaseKey(...modifierKeys());
}

async function sendShortcut(modifierKey, key) {
  assertAvailable();
  await releaseModifiers();
  await delay(120); // let the user's own held key actually register as up
  await keyboard.pressKey(modifierKey);
  await keyboard.pressKey(key);
  await delay(30);
  await keyboard.releaseKey(key);
  await keyboard.releaseKey(modifierKey);
  await releaseModifiers();
}

async function selectAllAndCopy() {
  const mod = Key[PRIMARY_MODIFIER];
  await sendShortcut(mod, Key.A);
  await delay(50);
  await sendShortcut(mod, Key.C);
}

async function paste() {
  await sendShortcut(Key[PRIMARY_MODIFIER], Key.V);
}

module.exports = { isAvailable, unavailableReason, releaseModifiers, selectAllAndCopy, paste, setSpeedProfile };
