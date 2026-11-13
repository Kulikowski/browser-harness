/**
 * Playwright fixtures: a real Chrome (the box's Chrome 156, WebMCP flags on) with the unpacked
 * extension loaded, the real bridge registered as its native messaging host (inside a throwaway
 * profile), and the fake agent as the only harness.
 *
 * Branded Chrome ignores --load-extension since 137, so we load the extension over CDP with
 * Extensions.loadUnpacked (needs --enable-unsafe-extension-debugging).
 */
import { test as base, chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostManifest, wrapperScript } from "../../src/bridge/install.js";
import { extensionIdFromKey } from "../../src/shared/extensionId.js";
import { NATIVE_HOST_NAME } from "../../src/shared/protocol.js";

const ROOT = join(import.meta.dirname, "..", "..");
const DEFAULT_CHROME =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome";
const CHROME = process.env.CHROME_PATH ?? DEFAULT_CHROME;
/** A folder of real harness CLIs to put on the bridge's PATH, for test/e2e/real.spec.ts. */
export const REAL_HARNESS_PATH = process.env.REAL_HARNESS_PATH ?? "";
const REAL_HARNESS_HOME = process.env.REAL_HARNESS_HOME;

interface Env {
  browser: Browser;
  context: BrowserContext;
  extensionId: string;
  fixtureUrl: (name: string) => string;
  /** Where the scripted agent keeps its sessions, as a real harness keeps them in its home folder. */
  stateDir: string;
  /** The folder new chats run in. */
  workspace: string;
  panel: Page;
}

export const test = base.extend<{ panel: Page; site: Page }, { env: Omit<Env, "panel"> }>({
  env: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const userDataDir = mkdtempSync(join(tmpdir(), "harness-e2e-profile-"));
      const stateDir = mkdtempSync(join(tmpdir(), "harness-e2e-fake-"));
      const workspace = mkdtempSync(join(tmpdir(), "harness-e2e-ws-"));
      const manifest = JSON.parse(readFileSync(join(ROOT, "dist/extension/manifest.json"), "utf8")) as { key: string };
      const extensionId = await extensionIdFromKey(manifest.key);
      const wrapper = join(userDataDir, "browser-harness-host");
      writeFileSync(
        wrapper,
        wrapperScript(
          process.execPath,
          join(ROOT, "dist/bridge/host.js"),
          [REAL_HARNESS_PATH, "/usr/bin:/bin"].filter(Boolean).join(":"),
          {
            BROWSER_HARNESS_FAKE_AGENT: join(ROOT, "dist/bridge/fakeAgent.js"),
            BROWSER_HARNESS_FAKE_STATE_DIR: stateDir,
            BROWSER_HARNESS_WORKSPACE: workspace,
            // Only the folder the test names is searched; the machine's own harnesses stay out of it.
            BROWSER_HARNESS_SEARCH_PATH: REAL_HARNESS_PATH,
            // Real harnesses read their sign-in from HOME; point them at a scratch one so a test never
            // touches (or uses) the developer's own login unless REAL_HARNESS_HOME says so.
            ...(REAL_HARNESS_PATH
              ? { HOME: REAL_HARNESS_HOME ?? mkdtempSync(join(tmpdir(), "harness-e2e-home-")) }
              : {})
          }
        )
      );
      chmodSync(wrapper, 0o755);
      mkdirSync(join(userDataDir, "NativeMessagingHosts"), { recursive: true });
      writeFileSync(
        join(userDataDir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
        JSON.stringify(hostManifest(wrapper, extensionId))
      );

      const server: Server = createServer((request, response) => {
        const name = (request.url ?? "/").replace(/^\//, "").split("?")[0] || "form.html";
        try {
          const body = readFileSync(join(ROOT, "test/e2e/fixtures", name.replace(/[^\w.-]/g, "")));
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
        } catch {
          response.writeHead(404).end("not found");
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;

      const chrome: ChildProcess = spawn(
        CHROME,
        [
          "--headless=new",
          `--user-data-dir=${userDataDir}`,
          "--remote-debugging-port=0",
          "--enable-unsafe-extension-debugging",
          "--enable-features=WebMCP,WebMCPSupport,WebMCPTesting",
          "--no-first-run",
          "--no-default-browser-check",
          "--window-size=1280,900",
          "about:blank"
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      const wsUrl = await new Promise<string>((resolve, reject) => {
        let err = "";
        const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${err.slice(-500)}`)), 20_000);
        chrome.stderr!.on("data", (chunk: Buffer) => {
          err += chunk.toString();
          const match = err.match(/DevTools listening on (ws:\S+)/);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]!);
          }
        });
      });
      const browser = await chromium.connectOverCDP(wsUrl);
      const cdp = await browser.newBrowserCDPSession();
      const loaded = (await cdp.send(
        "Extensions.loadUnpacked" as never,
        { path: join(ROOT, "dist/extension") } as never
      )) as { id: string };
      if (loaded.id !== extensionId)
        throw new Error(`Extension loaded as ${loaded.id}, expected ${extensionId} from the manifest key`);
      const context = browser.contexts()[0]!;
      await use({
        browser,
        context,
        extensionId,
        fixtureUrl: (name) => `http://127.0.0.1:${port}/${name}`,
        stateDir,
        workspace
      });
      await browser.close().catch(() => undefined);
      chrome.kill("SIGKILL");
      server.close();
      for (const dir of [userDataDir, stateDir, workspace])
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    { scope: "worker" }
  ],
  /** A web page, opened first so it is the tab the agent works on. */
  site: async ({ env }, use) => {
    const page = await env.context.newPage();
    await use(page);
    await page.close().catch(() => undefined);
  },
  /** The side panel's page, opened as a tab (headless Chrome has no side panel UI to click). */
  panel: async ({ env, site }, use) => {
    void site;
    const page = await env.context.newPage();
    await page.setViewportSize({ width: 420, height: 860 });
    await page.goto(`chrome-extension://${env.extensionId}/sidepanel.html`);
    await use(page);
    await page.close().catch(() => undefined);
  }
});

export const expect = test.expect;

/** Make `site` the tab the extension treats as "the page the user is looking at". */
export async function lookAt(site: Page, url: string): Promise<void> {
  await site.goto(url);
  await site.bringToFront();
}
