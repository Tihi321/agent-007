"use strict";
// electron-builder configuration (a .cjs file because the package is ESM).
// app.asar holds only the launcher: dist/src/desktop, the six small dist modules its static imports reach (they use node: builtins only,
// so no node_modules is needed in the asar), the tray icons and the setup page. The service tree the bundled node.exe runs sits
// unpacked in resources/app (extraResources): dist, prompts, config examples, production node_modules, package.json ("type":"module").
module.exports = {
  appId: "dev.selak.agent-007",
  productName: "agent-007",
  copyright: "Tihomir Selak",
  directories: { output: "release", buildResources: "build" },
  npmRebuild: false,
  asar: true,
  extraMetadata: { main: "dist/src/desktop/main.js" },
  files: [
    "package.json",
    "dist/src/desktop/**",
    "dist/ui/desktop/**",
    "dist/src/setup/personal.js",
    "dist/src/config/secrets.js",
    "dist/src/models/templates.js",
    "dist/src/settings/split.js",
    "dist/src/settings/contracts.js",
    "dist/src/jobrunner/proc.js",
    "assets/desktop/**",
    "!**/*.map",
    "!**/*.d.ts",
    "!node_modules",
    "!node_modules/**",
    // The launcher needs no npm package; keep the production dependencies out of app.asar (they ship in resources/app/node_modules).
  ],
  extraResources: [
    {
      from: "dist",
      to: "app/dist",
      filter: ["**/*", "!test/**", "!scripts/smoke/**", "!scripts/bakeoff/**", "!scripts/spike/**", "!scripts/*-eval/**", "!**/*.map", "!builder-debug.yml"],
    },
    { from: "prompts", to: "app/prompts" },
    { from: "config", to: "app/config", filter: ["*.example.json", "personas/**", "templates/**"] },
    { from: "build/stage/node_modules", to: "app/node_modules" },
    { from: "build/stage/package.json", to: "app/package.json" },
    { from: "build/node/node.exe", to: "node/node.exe" },
  ],
  win: {
    icon: "build/icon.ico",
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    artifactName: "agent-007-Setup-${version}-${arch}.${ext}",
  },
  portable: { artifactName: "agent-007-Portable-${version}-${arch}.${ext}" },
};
