// Windows-only keystroke automation. macOS isn't wired up yet — its
// Accessibility permission is bound to the app's code signature, which
// collides with the still-unresolved Mac launch-signing bug (see
// MEMORY.md); revisit once that's closed.
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

let keyboard, Key, loadError;
try {
  ({ keyboard, Key } = require("@nut-tree-fork/nut-js"));
} catch (err) {
  loadError = err;
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

async function releaseModifiers() {
  assertAvailable();
  await keyboard.releaseKey(
    Key.LeftControl,
    Key.RightControl,
    Key.LeftAlt,
    Key.RightAlt,
    Key.LeftShift,
    Key.RightShift,
    Key.LeftSuper,
    Key.RightSuper
  );
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
  await sendShortcut(Key.LeftControl, Key.A);
  await delay(50);
  await sendShortcut(Key.LeftControl, Key.C);
}

async function paste() {
  await sendShortcut(Key.LeftControl, Key.V);
}

module.exports = { isAvailable, unavailableReason, releaseModifiers, selectAllAndCopy, paste };
