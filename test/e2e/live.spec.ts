/**
 * Real, signed-in harnesses in real Chrome: the unpacked extension, the bridge as native host, and
 * the agent you are logged in to. Uses YOUR login, so it is opt-in:
 *
 *   LIVE_HARNESS=claude REAL_HARNESS_PATH="$HOME/.local/bin:$(dirname $(which node))" REAL_HARNESS_HOME="$HOME" \
 *     npx playwright test live
 *
 * LIVE_HARNESS is "claude", "codex" or "antigravity" (or a comma list). LIVE_SHOTS=<dir> saves the
 * panel, and LIVE_VERBOSE=1 prints timings and replies.
 */
import type { Page } from "@playwright/test";
import { REAL_HARNESS_PATH, expect, lookAt, test } from "./fixtures.js";

const NAMES: Record<string, string> = { claude: "Claude Code", antigravity: "Antigravity CLI", codex: "Codex" };
const harnesses = (process.env.LIVE_HARNESS ?? "").split(",").filter(Boolean);
const SHOTS = process.env.LIVE_SHOTS;

test.skip(harnesses.length === 0 || !REAL_HARNESS_PATH, "Set LIVE_HARNESS, REAL_HARNESS_PATH and REAL_HARNESS_HOME");
test.describe.configure({ timeout: 300_000 });

/** Timings and what the agent said, for whoever runs these by hand: LIVE_VERBOSE=1. */
const note = (line: string) => {
  if (process.env.LIVE_VERBOSE === "1") console.log(line);
};

const stepNames = (panel: Page) => panel.locator(".step .name").allTextContents();
/** Steps that ran something other than our browser tools as a command: the agent's own shell. */
const shellSteps = (panel: Page) => panel.locator('.step[data-kind="execute"]:not([data-browser])');

async function open(panel: Page, name: string) {
  const agents = panel.getByRole("list", { name: "Agents on this computer" });
  const newChat = panel.getByRole("button", { name: "New chat", exact: true });
  await expect(agents.or(newChat).first()).toBeVisible({ timeout: 30_000 });
  if (!(await agents.isVisible())) await newChat.click();
  await agents.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(panel.getByRole("textbox", { name: `Message ${name}` })).toBeEnabled({ timeout: 120_000 });
}

/** Sends a message and says yes to every slip until the turn ends. Returns the slips it answered. */
async function turn(panel: Page, name: string, text: string): Promise<string[]> {
  const box = panel.getByRole("textbox", { name: `Message ${name}` });
  const finishedBefore = await panel.getByText(/^Finished in/).count();
  await box.fill(text);
  await box.press("Enter");
  const answered: string[] = [];
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if ((await panel.getByText(/^Finished in/).count()) > finishedBefore) return answered;
    const slip = panel.locator(".dock .slip");
    if (await slip.isVisible().catch(() => false)) {
      answered.push((await slip.getByRole("heading").textContent()) ?? "");
      const allow = slip.getByRole("button", { name: /^(Allow once|Allow|Yes)/ }).first();
      await allow.click().catch(() => undefined);
    }
    const failed = panel.getByRole("alert");
    if (await failed.isVisible().catch(() => false))
      throw new Error(`The panel shows an error: ${await failed.textContent()}`);
    await panel.waitForTimeout(300);
  }
  throw new Error(
    `The turn did not finish in time. The panel says:\n${(await panel.locator("body").innerText()).slice(-3000)}`
  );
}

for (const id of harnesses) {
  const name = NAMES[id] ?? id;

  test(`${name}: reads and changes a page through its WebMCP tools`, async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("webmcp.html"));
    await open(panel, name);
    const started = Date.now();
    const slips = await turn(panel, name, 'What\'s on my todo board? Add "Call the venue" to it.');
    note(`${name}: WebMCP turn ${Date.now() - started} ms; slips: ${JSON.stringify(slips)}`);
    await expect(site.locator("#todos li")).toContainText(["Buy strings", "Book the van", "Call the venue"]);
    await expect(panel.locator(".msg-agent").last()).toContainText(/Buy strings|Book the van/);
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/live-${id}-webmcp.png` });
  });

  test(`${name}: a consequential page tool waits for the user, and a no sticks`, async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("webmcp.html"));
    await open(panel, name);
    const box = panel.getByRole("textbox", { name: `Message ${name}` });
    await box.fill("Clear my todo board.");
    await box.press("Enter");
    const slip = panel.locator(".dock .slip");
    // The harness may ask first (its own mode); the browser check always does for clear_board.
    const browserCheck = slip.filter({ hasText: "Browser check" });
    const deadline = Date.now() + 180_000;
    while (!(await browserCheck.isVisible().catch(() => false))) {
      if (Date.now() > deadline)
        throw new Error(
          `No browser check appeared. The panel says:\n${(await panel.locator("body").innerText()).slice(-2000)}`
        );
      if (await slip.isVisible().catch(() => false))
        await slip
          .getByRole("button", { name: /^Allow once/ })
          .first()
          .click()
          .catch(() => undefined);
      await panel.waitForTimeout(300);
    }
    await expect(browserCheck).toContainText("clear_board");
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/live-${id}-approval.png` });
    await browserCheck.getByRole("button", { name: "Decline" }).click();
    await expect(panel.getByText(/^Finished in/)).toBeVisible({ timeout: 180_000 });
    await expect(site.locator("#todos li")).toHaveCount(2);
    const reply = (await panel.locator(".msg-agent").last().textContent()) ?? "";
    note(`${name}: after Decline it said: ${reply.slice(0, 300)}`);
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/live-${id}-declined.png` });
  });

  test(`${name}: fills a plain form with no WebMCP`, async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("form.html"));
    await open(panel, name);
    const started = Date.now();
    const slips = await turn(panel, name, 'Put "Ada Lovelace" in the name field on this page. Don\'t submit anything.');
    note(`${name}: form turn ${Date.now() - started} ms; slips: ${JSON.stringify(slips)}`);
    const values = await site
      .locator("input")
      .evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value));
    expect(values).toContain("Ada Lovelace");
    if (SHOTS) await panel.screenshot({ path: `${SHOTS}/live-${id}-form.png` });
  });

  test(`${name}: waits for tools a page registers late instead of clicking`, async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("late.html"));
    await open(panel, name);
    const started = Date.now();
    // Ask straight away, while the page has WebMCP but no tools yet.
    await turn(panel, name, "Has this app finished starting? Use its own tools.");
    const steps = await stepNames(panel);
    note(`${name}: late-tools turn ${Date.now() - started} ms; steps: ${JSON.stringify(steps)}`);
    expect(steps).toContainEqual("Page tool: get_status");
    expect(steps.filter((step) => /^(Read the page|Click on the page|Type)/.test(step))).toEqual([]);
    await expect(shellSteps(panel)).toHaveCount(0);
  });
}
