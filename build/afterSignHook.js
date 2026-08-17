const { execFileSync } = require("child_process");
const path = require("path");

// electron-builder invokes this after packaging, before dmg/zip creation.
// package.json sets build.sign=null (skips electron-builder's own Developer-ID
// signing attempt, which would fail without a paid certificate) — this hook
// ad-hoc signs instead, which is enough to satisfy Apple Silicon's hard
// requirement that any executed binary carry at least a signature. It does
// NOT notarize the app, so first launch after download still shows the
// normal "unidentified developer, right-click → Open" Gatekeeper prompt.
exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  execFileSync("codesign", ["--sign", "-", "--force", "--deep", appPath]);
};
