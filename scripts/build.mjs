// Builds the unpacked extension into dist/extension and the bridge into dist/bridge.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { iconPng } from "./icons.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
const ext = join(out, "extension");
mkdirSync(join(ext, "icons"), { recursive: true });

await build({
  entryPoints: { background: "src/extension/background/main.ts", sidepanel: "src/extension/sidepanel/main.tsx" },
  outdir: ext,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome140",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: "linked",
  logLevel: "warning",
  absWorkingDir: root
});

await build({
  entryPoints: {
    host: "src/bridge/host.ts",
    mcpShim: "src/bridge/mcpShim.ts",
    fakeAgent: "src/bridge/fakeAgent.ts",
    install: "src/bridge/install.ts"
  },
  outdir: join(out, "bridge"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: "linked",
  logLevel: "warning",
  absWorkingDir: root,
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
  }
});

copyFileSync(join(root, "src/extension/manifest.json"), join(ext, "manifest.json"));
copyFileSync(join(root, "src/extension/sidepanel/sidepanel.html"), join(ext, "sidepanel.html"));
copyFileSync(join(root, "src/extension/sidepanel/sidepanel.css"), join(ext, "sidepanel.css"));
for (const size of [16, 32, 48, 128]) writeFileSync(join(ext, "icons", `icon-${size}.png`), iconPng(size));
console.log("Built dist/extension and dist/bridge");
