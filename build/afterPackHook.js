const fs = require("fs");
const path = require("path");

// Electron ships ~55 Chromium locale files (39MB on Windows) so Chromium
// can localize its own built-in UI — right-click menus, error pages, form
// validation. Nyra's interface is English-only and always has been, so 54
// of those 55 are dead weight in every installer.
//
// electron-builder exposes `electronLanguages` for macOS/Linux but not for
// Windows, where the locales live as loose .pak files next to the exe —
// hence doing it here, where both platforms can be handled the same way.
//
// This does NOT shrink electron.exe / Electron Framework itself, which is
// where the real bulk is (~180MB of the ~260MB runtime). It's the largest
// removable chunk, not a fix for the overall footprint.

// Matched by exact filename, never by "everything except X" — the macOS
// Resources directory this walks also contains icudtl.dat and the .pak
// files Electron cannot start without, so a blanket delete would produce
// a build that packages fine and then fails to launch.
const KEEP = new Set(["en-US.pak", "en.lproj", "en_GB.lproj", "en-US.lproj"]);

const isLocaleFile = (name) => name.endsWith(".pak") && !name.includes("resources") && !name.includes("chrome_");
const isLocaleDir = (name) => name.endsWith(".lproj");

function stripLocales(dir, label) {
  if (!fs.existsSync(dir)) return;

  let freed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (KEEP.has(name)) continue;

    const isRemovable = entry.isDirectory() ? isLocaleDir(name) : isLocaleFile(name);
    if (!isRemovable) continue;

    const target = path.join(dir, name);
    freed += entry.isDirectory() ? dirSize(target) : fs.statSync(target).size;
    fs.rmSync(target, { recursive: true, force: true });
  }

  if (freed > 0) {
    console.log(`  [nyra] stripped ${(freed / 1024 / 1024).toFixed(1)}MB of unused locales from ${label}`);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

exports.default = async function afterPack(context) {
  const out = context.appOutDir;

  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    stripLocales(
      path.join(out, appName, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources"),
      "Electron Framework"
    );
  } else {
    stripLocales(path.join(out, "locales"), "locales/");
  }
};
