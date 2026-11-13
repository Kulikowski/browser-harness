import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, lookAt, test } from "./fixtures.js";
import { deleteAllChats, lastReply, openSettings, say, setPageToolsOnly, startChat } from "./helpers.js";

test("Stop cancels the running turn", async ({ panel, env, site }) => {
  await lookAt(site, env.fixtureUrl("form.html"));
  await startChat(panel);
  await say(panel, "wait");
  await expect(lastReply(panel)).toContainText("Working on something long");
  await panel.getByRole("button", { name: "Stop" }).click();
  await expect(panel.locator(".turn-end").last()).toHaveText("Stopped");
  await expect(panel.getByRole("button", { name: "Send" })).toBeVisible();
});

test("a mode picked in the panel is the mode shown, and still is after a reload", async ({ panel, env, site }) => {
  await lookAt(site, env.fixtureUrl("form.html"));
  await startChat(panel);
  const mode = panel.locator(".mode-picker select");
  await expect(mode).toHaveValue("ask");
  // The scripted agent, like Claude Code's, answers the request and sends no update of its own.
  await mode.selectOption("auto");
  await expect(panel.locator(".mode-picker")).toHaveAttribute("data-unattended", "");
  await panel.reload();
  await expect(panel.locator(".mode-picker select")).toHaveValue("auto");
});

test("chats are listed, survive a panel reload, and keep their own sessions", async ({ panel, env, site }) => {
  await lookAt(site, env.fixtureUrl("form.html"));
  await startChat(panel);
  await say(panel, "first chat here");
  await expect(lastReply(panel)).toHaveText("You said: first chat here");
  await startChat(panel);
  await say(panel, "second chat here");
  await expect(lastReply(panel)).toHaveText("You said: second chat here");
  await expect(panel.locator(".msg-user .msg-text")).toHaveCount(1);

  await panel.reload();
  await expect(panel.locator(".msg-user .msg-text")).toHaveText("second chat here");
  await panel.getByRole("button", { name: /second chat here\. Show all chats/ }).click();
  const list = panel.getByRole("list", { name: "Chats" });
  await expect(list.getByRole("button", { name: /^first chat here/ })).toBeVisible();
  await list.getByRole("button", { name: /^first chat here/ }).click();
  await expect(panel.locator(".msg-user .msg-text")).toHaveText("first chat here");
  await say(panel, "still the first");
  await expect(lastReply(panel)).toHaveText("You said: still the first");
  await expect(panel.locator(".msg-user .msg-text")).toHaveText(["first chat here", "still the first"]);
});

test("a chat is deleted on the second click, and Clear all empties the list", async ({ panel, env, site }) => {
  await lookAt(site, env.fixtureUrl("form.html"));
  await deleteAllChats(panel);
  for (const words of ["keep me", "drop me", "me too"]) {
    await startChat(panel);
    await say(panel, words);
    await expect(lastReply(panel)).toHaveText(`You said: ${words}`);
  }
  await panel.getByRole("button", { name: /Show all chats/ }).click();
  const list = panel.getByRole("list", { name: "Chats" });
  await expect(list.getByRole("listitem")).toHaveCount(3);

  // One click only asks; looking away takes the question back.
  await list.getByRole("button", { name: "Delete chat: drop me" }).click();
  const question = list.getByRole("button", { name: "Delete?" });
  await expect(question).toBeVisible();
  await question.blur();
  await expect(question).toHaveCount(0);
  await expect(list.getByRole("listitem")).toHaveCount(3);

  await list.getByRole("button", { name: "Delete chat: drop me" }).click();
  await list.getByRole("button", { name: "Delete?" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("button", { name: /^drop me/ })).toHaveCount(0);

  await panel.reload();
  await panel.getByRole("button", { name: /Show all chats/ }).click();
  await expect(panel.getByRole("list", { name: "Chats" }).getByRole("listitem")).toHaveCount(2);

  await panel.getByRole("button", { name: "Clear all chats from this panel" }).click();
  await panel.getByRole("button", { name: "Delete all 2?" }).click();
  await expect(panel.getByText("No chats yet.")).toBeVisible();
  const stored = await panel.evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
  expect(stored.filter((key) => key.startsWith("chat:"))).toEqual([]);
});

test("a session started outside the panel can be brought in with its history", async ({ panel, env, site }) => {
  // Write a session into the scripted agent's own store, as `claude` or `agy` would when used in a terminal.
  const file = join(env.stateDir, "sessions.json");
  const store = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  store["terminal-session-1"] = {
    sessionId: "terminal-session-1",
    cwd: env.workspace,
    title: "Fix the poster layout",
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    history: [
      { role: "user", text: "Fix the poster layout" },
      { role: "agent", text: "I moved the headline above the date." }
    ]
  };
  writeFileSync(file, JSON.stringify(store));

  await lookAt(site, env.fixtureUrl("form.html"));
  await startChat(panel);
  await panel.getByRole("button", { name: /Show all chats/ }).click();
  await panel.getByRole("button", { name: "Scripted test agent", exact: true }).click();
  const row = panel.getByRole("list", { name: "Sessions" }).getByRole("button", { name: /Fix the poster layout/ });
  await expect(row).toContainText("Bring in");
  await expect(row).toContainText("3 min ago");
  await row.click();
  await expect(panel.locator(".msg-user .msg-text")).toHaveText(["Fix the poster layout"]);
  await expect(panel.locator(".msg-agent")).toHaveText(["I moved the headline above the date."]);
  await say(panel, "carry on");
  await expect(lastReply(panel)).toHaveText("You said: carry on");
});

test("a harness that turns out to be signed out shows its own sign-in, never a key field", async ({
  panel,
  env,
  site
}) => {
  await lookAt(site, env.fixtureUrl("form.html"));
  await startChat(panel);
  await say(panel, "pretend signed out");
  await expect(panel.locator(".turn-end").last()).toHaveText("The turn ended with an error");
  const notice = panel.getByRole("alert").filter({ hasText: "needs you to sign in" });
  await expect(notice).toContainText("Scripted test agent needs you to sign in, with its own login.");
  await expect(notice.getByRole("button", { name: "Log in with the test agent" })).toBeVisible();
  await expect(panel.getByText(/Authentication required\. Sign in to the harness in a terminal/)).toBeVisible();
  await expect(panel.locator("input[type=password], input[name*=key i]")).toHaveCount(0);
  await notice.getByRole("button", { name: "Log in with the test agent" }).click();
  await expect(notice).toHaveCount(0);
});

test.describe("messages written while the agent works", () => {
  const box = (panel: import("@playwright/test").Page) =>
    panel.getByRole("textbox", { name: /Message Scripted test agent/ });
  const queued = (panel: import("@playwright/test").Page) => panel.locator(".composer .queued");
  const sentTexts = (panel: import("@playwright/test").Page) =>
    panel.locator(".msg-user .msg-text").evaluateAll((nodes) => nodes.map((node) => node.textContent));

  test("are queued, joined in order, and sent when the turn ends", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("form.html"));
    await startChat(panel);
    await say(panel, "wait 2500");
    await expect(lastReply(panel)).toContainText("Working for a while");
    await box(panel).fill("second");
    await expect(panel.getByRole("button", { name: "Queue" })).toBeVisible();
    await box(panel).press("Enter");
    await expect(queued(panel)).toContainText("Sends when Scripted test agent finishes this turn: second");
    await box(panel).fill("third");
    await box(panel).press("Enter");
    await expect(box(panel)).toHaveValue("");
    // One message, both paragraphs in order, sent once the turn ended.
    await expect.poll(async () => (await sentTexts(panel)).at(-1), { timeout: 10_000 }).toBe("second\n\nthird");
    await expect(queued(panel)).toHaveCount(0);
    await expect(panel.getByText(/^Finished in/)).toHaveCount(2, { timeout: 10_000 });
  });

  test("Cancel and Stop give the queued words back, in front of what is being typed", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("form.html"));
    await startChat(panel);
    await say(panel, "wait");
    await expect(lastReply(panel)).toContainText("Working on something long");
    await box(panel).fill("later");
    await box(panel).press("Enter");
    await box(panel).fill("typing");
    await queued(panel).getByRole("button", { name: "Cancel" }).click();
    await expect(box(panel)).toHaveValue("later\n\ntyping");
    await expect(queued(panel)).toHaveCount(0);

    await box(panel).fill("not now");
    await box(panel).press("Enter");
    await expect(queued(panel)).toBeVisible();
    const before = (await sentTexts(panel)).length;
    await panel.getByRole("button", { name: "Stop" }).click();
    await expect(panel.locator(".turn-end").last()).toHaveText("Stopped");
    await expect(box(panel)).toHaveValue("not now");
    await expect(queued(panel)).toHaveCount(0);
    expect((await sentTexts(panel)).length).toBe(before);
  });

  test("a queued message is still sent after a look at the chat list", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("form.html"));
    await startChat(panel);
    await say(panel, "wait 2000");
    await expect(lastReply(panel)).toContainText("Working for a while");
    await box(panel).fill("after the list");
    await box(panel).press("Enter");
    await panel.getByRole("button", { name: /Show all chats/ }).click();
    await expect(panel.getByRole("heading", { name: "Chats", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Back to chat" }).click();
    await expect(lastReply(panel)).toContainText("You said: after the list", { timeout: 10_000 });
  });
});

test("Page tools only and the folder are saved together, and survive a reload", async ({ panel, env, site }) => {
  await lookAt(site, env.fixtureUrl("form.html"));
  await startChat(panel);
  await openSettings(panel);
  const folder = panel.getByRole("textbox", { name: "Folder for new chats" });
  const original = await folder.inputValue();
  try {
    await setPageToolsOnly(panel, true);
    await folder.fill("/tmp/harness-settings-check");
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(panel.getByText("Saved. New chats use it.")).toBeVisible();
    const stored = await panel.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
    expect(stored).toEqual({ cwd: "/tmp/harness-settings-check", pageToolsOnly: true });
    await panel.reload();
    await openSettings(panel);
    await expect(panel.getByRole("checkbox", { name: /Page tools only/ })).toBeChecked();
    await expect(panel.getByRole("textbox", { name: "Folder for new chats" })).toHaveValue(
      "/tmp/harness-settings-check"
    );
  } finally {
    await setPageToolsOnly(panel, false);
    await panel.getByRole("textbox", { name: "Folder for new chats" }).fill(original);
    await panel.getByRole("button", { name: "Save" }).click();
  }
});
