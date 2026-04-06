const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Run Skia's postinstall to download prebuilt binaries
try {
  const skiaInstallScript = path.join(
    __dirname,
    "..",
    "node_modules",
    "@shopify",
    "react-native-skia",
    "scripts",
    "install-libs.js"
  );
  if (fs.existsSync(skiaInstallScript)) {
    execSync(`node "${skiaInstallScript}"`, { stdio: "inherit" });
  }
} catch (e) {
  console.warn("Skia postinstall failed:", e.message);
}

function ensureFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, contents, "utf8");
  }
}

// Node 25+ supports loading .ts with type-stripping, but it refuses to do so inside node_modules.
// Some Expo packages (notably expo-image@2.x) still point "main" to a TypeScript file, and since
// this project lists "expo-image" in app.json plugins, the Expo config plugin resolver may try to
// load it in Node at startup.
//
// We provide a tiny no-op config plugin entrypoint so Expo loads this JS file instead of the TS
// runtime module.
const expoImagePluginPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "expo-image",
  "app.plugin.js"
);

ensureFile(
  expoImagePluginPath,
  `module.exports = function withExpoImage(config) { return config; };\n`
);

// expo-sharing does not ship a config plugin, but this project lists it in app.json plugins.
// Without an `app.plugin.js`, Expo will fall back to loading the runtime module in Node, which
// imports `expo-modules-core` (TypeScript) and crashes under Node 25+.
const expoSharingPluginPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "expo-sharing",
  "app.plugin.js"
);

ensureFile(
  expoSharingPluginPath,
  `module.exports = function withExpoSharing(config) { return config; };\n`
);

