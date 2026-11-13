/**
 * Real harness CLIs, signed out. Run with
 *   REAL_HARNESS_PATH=<folder holding claude, claude-agent-acp, codex, codex-acp, agy> npm run test:e2e -- real
 * HOME for the bridge is a scratch folder, so no one's login is used. Each chat must reach the real
 * CLI over ACP and end in that harness's own sign-in message. Nothing here signs in or uses a key.
 */
import { REAL_HARNESS_PATH, expect, lookAt, test } from "./fixtures.js";

test.skip(!REAL_HARNESS_PATH, "Set REAL_HARNESS_PATH to a folder of harness CLIs");
test.describe.configure({ timeout: 120_000 });

const SHOTS = process.env.REAL_HARNESS_SHOTS;

test("the picker lists every harness found, with its version", async ({ panel, env, site }) => {
  await lookAt(site, env.fixtureUrl("webmcp.html"));
  const agents = panel.getByRole("list", { name: "Agents on this computer" });
  for (const name of ["Claude Code", "Codex", "Antigravity CLI"])
    await expect(agents.getByRole("button", { name: new RegExp(`^${name} \\d`) })).toBeVisible();
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/real-harness-picker.png` });
});

test("Claude Code opens a real ACP session, then says it needs /login on the first prompt", async ({
  panel,
  env,
  site
}) => {
  await lookAt(site, env.fixtureUrl("webmcp.html"));
  const agents = panel.getByRole("list", { name: "Agents on this computer" });
  await agents.getByRole("button", { name: /^Claude Code/ }).click();
  const box = panel.getByRole("textbox", { name: "Message Claude Code" });
  await expect(box).toBeEnabled({ timeout: 60_000 });
  // The session's modes come from claude-agent-acp itself.
  await expect(panel.getByRole("combobox", { name: "Mode" }).locator("option")).toContainText(["Plan"]);
  await box.fill("list tools");
  await box.press("Enter");
  await expect(
    panel.getByText("Authentication required. Run claude in a terminal and sign in with /login, then try again.")
  ).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole("button", { name: /Show all chats/ })).toHaveAccessibleName(/^list tools\./);
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/real-claude-signed-out.png` });
});

for (const [name, hint, methods] of [
  ["Codex", "Run codex login in a terminal (ChatGPT sign-in), then try again.", []],
  [
    "Antigravity CLI",
    "Run agy in a terminal and sign in with Google (or agy acp --login), then try again.",
    ["Log in with Google", "Log in with Gemini Enterprise"]
  ]
] as const) {
  test(`${name} refuses session/new until signed in and shows only keyless sign-ins`, async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("webmcp.html"));
    const agents = panel.getByRole("list", { name: "Agents on this computer" });
    const newChat = panel.getByRole("button", { name: "New chat", exact: true });
    await expect(agents.or(newChat).first()).toBeVisible();
    if (!(await agents.isVisible())) await newChat.click();
    await agents.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    const notice = panel.getByRole("alert");
    await expect(notice).toContainText(hint, { timeout: 60_000 });
    await expect(notice.getByRole("button")).toHaveText([...methods]);
    for (const label of await notice.getByRole("button").allTextContents())
      expect(label).not.toMatch(/api key|vertex|gateway|enterprise key/i);
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/real-${name.split(" ")[0]!.toLowerCase()}-signed-out.png` });
  });
}
