import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostDirectories, hostManifest, wrapperScript } from "../../src/bridge/install.js";
import { extensionIdFromKey } from "../../src/shared/extensionId.js";
import { NATIVE_HOST_NAME } from "../../src/shared/protocol.js";

describe("native host install", () => {
  it("knows Chrome's per-user host folders on macOS and Linux", () => {
    expect(hostDirectories("darwin", "/Users/k")[0]).toEqual({
      browser: "Google Chrome",
      parent: "/Users/k/Library/Application Support/Google/Chrome",
      dir: "/Users/k/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    });
    expect(hostDirectories("linux", "/home/k").map((d) => d.dir)).toContain(
      "/home/k/.config/google-chrome/NativeMessagingHosts"
    );
    expect(hostDirectories("linux", "/home/k").map((d) => d.dir)).toContain(
      "/home/k/.config/chromium/NativeMessagingHosts"
    );
  });

  it("writes a manifest that only this extension may use", () => {
    expect(hostManifest("/w/host", "abc")).toEqual({
      name: NATIVE_HOST_NAME,
      description: expect.any(String),
      path: "/w/host",
      type: "stdio",
      allowed_origins: ["chrome-extension://abc/"]
    });
  });

  it("writes a wrapper that survives quotes and spaces and passes arguments through", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrapper-"));
    const script = join(dir, "echo.js");
    writeFileSync(
      script,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH, extra: process.env.EXTRA }));"
    );
    const wrapper = join(dir, "host");
    writeFileSync(wrapper, wrapperScript(process.execPath, script, "/odd dir/it's:/usr/bin", { EXTRA: "a 'b' c" }));
    chmodSync(wrapper, 0o755);
    const out = JSON.parse(execFileSync(wrapper, ["chrome-extension://abc/"], { encoding: "utf8" })) as {
      argv: string[];
      path: string;
      extra: string;
    };
    expect(out).toEqual({ argv: ["chrome-extension://abc/"], path: "/odd dir/it's:/usr/bin", extra: "a 'b' c" });
  });

  it("the manifest key gives the extension the ID the host manifest allows", async () => {
    const manifest = JSON.parse(readFileSync("src/extension/manifest.json", "utf8")) as { key: string };
    expect(await extensionIdFromKey(manifest.key)).toBe("jmhdjhpeojdibgbgjjekpknolaoochmo");
  });
});
