const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// electron-builder invokes this after packaging, before dmg/zip creation.
// package.json sets build.sign=null (skips electron-builder's own Developer-ID
// signing attempt, which would fail without a paid certificate) — this hook
// ad-hoc signs instead, which is enough to satisfy Apple Silicon's hard
// requirement that any executed binary carry at least a signature. It does
// NOT notarize the app, so first launch after download still shows the
// normal "unidentified developer, right-click → Open" Gatekeeper prompt.

function findNodeBinaries(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findNodeBinaries(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".node")) {
      results.push(fullPath);
    }
  }
  return results;
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // `codesign --deep` on the .app bundle does not reliably descend into
  // arbitrary subdirectories of Contents/Resources — in particular
  // app.asar.unpacked, where the native @nut-tree-fork/libnut-darwin
  // binary (libnut.node) lands. An unsigned Mach-O fails to dlopen on
  // Apple Silicon, so automation would throw at first use, or the app
  // could fail to launch entirely — the same failure class as the
  // launch-signing bug this project already spent a session chasing
  // down. Sign every native binary explicitly, inner-out, before
  // signing the bundle itself.
  const unpackedPath = path.join(appPath, "Contents", "Resources", "app.asar.unpacked");
  if (fs.existsSync(unpackedPath)) {
    for (const nodeBinary of findNodeBinaries(unpackedPath)) {
      execFileSync("codesign", ["--sign", "-", "--force", nodeBinary]);
    }
  }

  execFileSync("codesign", ["--sign", "-", "--force", "--deep", appPath]);

  // A silent signing gap must not reach a release — verify rather than
  // assume --deep actually covered everything above.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath]);
};
