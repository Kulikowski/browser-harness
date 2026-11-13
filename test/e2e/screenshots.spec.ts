/**
 * Regenerates docs/screenshots with the scripted agent: SCREENSHOTS=1 npm run test:e2e -- screenshots
 * Every picture is the real side panel page driven through the real bridge; only the agent is scripted.
 */
import { join } from "node:path";
import { expect, lookAt, test } from "./fixtures.js";
import { lastReply, say, setPageToolsOnly, slip, startChat } from "./helpers.js";

test.skip(!process.env.SCREENSHOTS, "Set SCREENSHOTS=1 to regenerate docs/screenshots");
const out = (name: string) => join(import.meta.dirname, "../../docs/screenshots", name);

test("side panel screenshots", async ({ panel, env, site }) => {
  await site.setViewportSize({ width: 900, height: 860 });
  await lookAt(site, env.fixtureUrl("webmcp.html"));
  // Still frames: no slide-in caught halfway.
  await panel.emulateMedia({ reducedMotion: "reduce" });
  await expect(panel.getByRole("list", { name: "Agents on this computer" })).toBeVisible();
  await panel.screenshot({ path: out("new-chat.png") });
  await startChat(panel);
  await panel.getByRole("button", { name: /Show all chats/ }).click();
  await expect(panel.getByRole("checkbox", { name: /Page tools only/ })).toBeVisible();
  await panel.screenshot({ path: out("settings.png") });
  try {
    await setPageToolsOnly(panel, true);
    await panel.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await panel.screenshot({ path: out("settings-on-dark.png") });
  } finally {
    await panel.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await setPageToolsOnly(panel, false);
  }
  await panel.getByRole("button", { name: "Back to chat" }).click();
  await say(panel, "Hi! What can you do on this page?");
  await expect(panel.getByText(/^Finished in/)).toBeVisible();
  await say(panel, "list tools");
  await expect(lastReply(panel)).toContainText("This tab offers 3 WebMCP tools");
  await panel.screenshot({ path: out("session.png") });

  await say(panel, 'call add_todo {"text":"Soundcheck at 6"}');
  await expect(slip(panel)).toContainText("asks before it runs this");
  await panel.screenshot({ path: out("permission-card.png") });

  await slip(panel).getByRole("button", { name: "Allow once" }).click();
  // The page did not mark add_todo read-only, so the browser asks the first time.
  await expect(slip(panel)).toContainText("Browser check");
  await panel.screenshot({ path: out("first-use.png") });
  await slip(panel).getByRole("button", { name: "Allow for now" }).click();
  await expect(lastReply(panel)).toContainText("Done. add_todo returned");
  const step = panel.locator(".step").filter({ hasText: "Run browser tool add_todo" }).last();
  await step.locator("summary").click();
  await panel.locator("main").evaluate((main) => main.scrollTo(0, main.scrollHeight));
  await panel.screenshot({ path: out("webmcp-tool-call.png") });
  await site.screenshot({ path: out("webmcp-page-after-call.png") });

  await say(panel, "call clear_board {}");
  await slip(panel).getByRole("button", { name: "Allow once" }).click();
  await expect(slip(panel)).toContainText("Browser check");
  await panel.screenshot({ path: out("extension-approval.png") });
  await panel.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await panel.screenshot({ path: out("extension-approval-dark.png") });
  await panel.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await slip(panel).getByRole("button", { name: "Decline" }).click();
  await expect(lastReply(panel)).toContainText("declined");
});
