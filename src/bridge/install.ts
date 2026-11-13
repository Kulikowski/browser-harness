#!/usr/bin/env node
/**
 * Registers the bridge as a Chrome native messaging host for this user (no sudo):
 *   node dist/bridge/install.js                 # every Chrome/Chromium channel found
 *   node dist/bridge/install.js --user-data-dir <dir>   # one profile directory (tests, custom profiles)
 *   node dist/bridge/install.js --uninstall
 * Writes a small wrapper that pins node and your login shell's PATH (Chrome starts hosts with a thin
 * PATH, so `claude`, `codex`, `agy` would otherwise not be found), and a host manifest that only
 * this extension's ID may open.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey } from "../shared/extensionId.js";
import { NATIVE_HOST_NAME } from "../shared/protocol.js";
import { messageOf } from "../shared/errors.js";

export function hostDirectories(os: NodeJS.Platform, home: string): { browser: string; dir: string; parent: string }[] {
  const entries: [string, string][] =
    os === "darwin"
      ? [
          ["Google Chrome", "Library/Application Support/Google/Chrome"],
          ["Google Chrome Beta", "Library/Application Support/Google/Chrome Beta"],
          ["Google Chrome Dev", "Library/Application Support/Google/Chrome Dev"],
          ["Google Chrome Canary", "Library/Application Support/Google/Chrome Canary"],
          ["Chromium", "Library/Application Support/Chromium"]
        ]
      : [
          ["Google Chrome", ".config/google-chrome"],
          ["Google Chrome Beta", ".config/google-chrome-beta"],
          ["Google Chrome Dev", ".config/google-chrome-unstable"],
          ["Chromium", ".config/chromium"]
        ];
  return entries.map(([browser, profile]) => ({
    browser,
    parent: join(home, profile),
    dir: join(home, profile, "NativeMessagingHosts")
  }));
}

export function hostManifest(wrapperPath: string, extensionId: string) {
  return {
    name: NATIVE_HOST_NAME,
    description: "Browser Harness bridge: connects the extension to local coding agents over ACP",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
}

export function wrapperScript(
  nodePath: string,
  hostJs: string,
  pathValue: string,
  extraEnv: Record<string, string> = {}
): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const exports = Object.entries(extraEnv)
    .map(([name, value]) => `export ${name}=${quote(value)}\n`)
    .join("");
  return `#!/bin/sh\n# Written by browser-harness's installer. Chrome runs this to start the bridge.\nexport PATH=${quote(pathValue)}\n${exports}exec ${quote(nodePath)} ${quote(hostJs)} "$@"\n`;
}

function loginShellPath(): string {
  const shell = process.env.SHELL || "/bin/sh";
  const nodeBin = dirname(process.execPath);
  const ensureNode = (p: string) => (p.split(":").includes(nodeBin) ? p : `${nodeBin}:${p}`);
  try {
    const out = execFileSync(shell, ["-ilc", 'printf "__PATH__%s__END__" "$PATH"'], {
      timeout: 8000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const match = out.match(/__PATH__(.*)__END__/s);
    if (match?.[1]) return ensureNode(match[1]);
  } catch {
    // fall through
  }
  return ensureNode(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin");
}

async function main(argv: string[]): Promise<void> {
  if (platform() !== "darwin" && platform() !== "linux") throw new Error("The installer supports macOS and Linux.");
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..", "..");
  const uninstall = argv.includes("--uninstall");
  const udIndex = argv.indexOf("--user-data-dir");
  const userDataDir = udIndex >= 0 ? argv[udIndex + 1] : undefined;
  const fakeIndex = argv.indexOf("--with-fake-agent");

  const targets = userDataDir
    ? [{ browser: `profile at ${userDataDir}`, dir: join(userDataDir, "NativeMessagingHosts"), parent: userDataDir }]
    : hostDirectories(platform(), homedir()).filter((target, index) => index === 0 || existsSync(target.parent));

  const wrapperDir = userDataDir ?? join(homedir(), ".browser-harness");
  const wrapperPath = join(wrapperDir, "browser-harness-host");
  if (uninstall) {
    for (const target of targets) rmSync(join(target.dir, `${NATIVE_HOST_NAME}.json`), { force: true });
    rmSync(wrapperPath, { force: true });
    console.log(`Removed the ${NATIVE_HOST_NAME} host from ${targets.map((t) => t.browser).join(", ")}.`);
    return;
  }

  const manifest = JSON.parse(readFileSync(join(root, "dist", "extension", "manifest.json"), "utf8")) as {
    key: string;
  };
  const extensionId = await extensionIdFromKey(manifest.key);
  const hostJs = join(here, "host.js");
  const extraEnv: Record<string, string> =
    fakeIndex >= 0 ? { BROWSER_HARNESS_FAKE_AGENT: join(here, "fakeAgent.js") } : {};
  // Outside dist/, so a rebuild (which empties dist/) does not pull the host out from under Chrome.
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(wrapperPath, wrapperScript(process.execPath, hostJs, loginShellPath(), extraEnv));
  chmodSync(wrapperPath, 0o755);

  for (const target of targets) {
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(
      join(target.dir, `${NATIVE_HOST_NAME}.json`),
      `${JSON.stringify(hostManifest(wrapperPath, extensionId), null, 2)}\n`
    );
  }
  console.log(`Installed the bridge for extension ${extensionId}`);
  for (const target of targets) console.log(`  ${target.browser}: ${join(target.dir, `${NATIVE_HOST_NAME}.json`)}`);
  console.log(`  host: ${wrapperPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(messageOf(error));
    process.exit(1);
  });
}
