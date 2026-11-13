#!/usr/bin/env node
/**
 * Native messaging host entry point. Chrome starts it (through the wrapper the installer writes)
 * when the extension calls chrome.runtime.connectNative, and stops it when the port closes.
 * stdout carries only native-messaging frames; logs go to stderr, which Chrome passes through.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { messageOf } from "../shared/errors.js";
import type { ToBridge } from "../shared/protocol.js";
import { Bridge } from "./bridge.js";
import { nativeChannel } from "./nativeMessaging.js";

const here = dirname(fileURLToPath(import.meta.url));
const channel = nativeChannel(process.stdin, process.stdout);

const bridge = new Bridge({
  send: (message) => channel.send(message),
  shimPath: join(here, "mcpShim.js"),
  detect: { fakeAgent: process.env.BROWSER_HARNESS_FAKE_AGENT || null },
  workspace: process.env.BROWSER_HARNESS_WORKSPACE || undefined
});

let queue: Promise<void> = bridge.start();

channel.onMessage((message) => {
  // Handle in arrival order, but never let one long turn block the next message.
  queue = queue.then(() => {
    void bridge.handle(message as ToBridge).catch((error: unknown) => {
      process.stderr.write(`[bridge] ${messageOf(error)}\n`);
    });
  });
});

const shutdown = () => {
  void bridge.stop().finally(() => process.exit(0));
};
channel.onClose(shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
