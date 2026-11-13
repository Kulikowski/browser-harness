import { expect, lookAt, test } from "./fixtures.js";
import { lastReply, say, setPageToolsOnly, slip, startChat } from "./helpers.js";

test.describe("WebMCP pages", () => {
  test("the panel counts the tab's WebMCP tools from Chrome's document.modelContext", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("webmcp.html"));
    await startChat(panel);
    await expect(panel.locator(".context")).toContainText("3 WebMCP tools");
    await expect(panel.locator(".context")).toContainText("Todo board (WebMCP)");
  });

  test("the harness lists the page's WebMCP tools through the browser MCP server", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("webmcp.html"));
    await startChat(panel);
    await say(panel, "list tools");
    await expect(lastReply(panel)).toHaveText("This tab offers 3 WebMCP tools: add_todo, clear_board, list_todos.");
    const step = panel.locator(".step").filter({ hasText: "List the page's WebMCP tools" });
    await expect(step.locator(".state")).toHaveText(/^Done/);
    await step.locator("summary").click();
    await expect(step.locator("pre").last()).toContainText('<page-content origin="http://127.0.0.1');
    await expect(step.locator("pre").last()).toContainText("clear_board (consequential)");
  });

  test("a harness permission request becomes a decision slip; allowing runs the tool in the page", async ({
    panel,
    env,
    site
  }) => {
    await lookAt(site, env.fixtureUrl("webmcp.html"));
    await startChat(panel);
    await say(panel, 'call add_todo {"text":"Soundcheck at 6"}');
    await expect(slip(panel)).toContainText("Scripted test agent asks before it runs this.");
    await expect(slip(panel).getByRole("heading")).toHaveText("Run browser tool add_todo");
    await expect(slip(panel)).toContainText('"text": "Soundcheck at 6"');
    await slip(panel).getByRole("button", { name: "Allow once" }).click();
    // The page did not say whether add_todo changes anything, so the browser asks the first time.
    await expect(slip(panel)).toContainText("Browser check");
    await expect(slip(panel)).toContainText(
      'The page does not say whether "add_todo" changes anything, so its first use asks.'
    );
    await slip(panel).getByRole("button", { name: "Allow for now" }).click();
    await expect(lastReply(panel)).toContainText('Done. add_todo returned <page-content origin="http://127.0.0.1');
    await expect(lastReply(panel)).toContainText('"count":3');
    await expect(site.locator("#todos li")).toHaveText(["Buy strings", "Book the van", "Soundcheck at 6"]);
    await expect(panel.locator(".decided").first()).toContainText("You chose: Allow once");
    await expect(panel.locator(".decided").last()).toContainText("You allowed it once");
    // One step for the call: the permission and the run share the harness's toolCallId.
    await expect(panel.locator(".step").filter({ hasText: "Run browser tool add_todo" })).toHaveCount(1);
    await expect(panel.locator(".step").filter({ hasText: "Run browser tool add_todo" }).locator(".state")).toHaveText(
      /^Done, \d/
    );
    await expect(slip(panel)).toHaveCount(0);
  });

  test("a consequential WebMCP tool also needs the extension's own yes; declining leaves the page alone", async ({
    panel,
    env,
    site
  }) => {
    await lookAt(site, env.fixtureUrl("webmcp.html"));
    await startChat(panel);
    await say(panel, "call clear_board {}");
    await slip(panel).getByRole("button", { name: "Allow once" }).click();
    await expect(slip(panel)).toContainText("Browser check");
    await expect(slip(panel)).toContainText('The page marks "clear_board" as consequential.');
    await expect(slip(panel).getByRole("heading")).toHaveText(
      /^Scripted test agent wants to run clear_board on 127\.0\.0\.1:\d+$/
    );
    await slip(panel).getByRole("button", { name: "Decline" }).click();
    await expect(lastReply(panel)).toContainText("clear_board failed: The user declined this action.");
    await expect(site.locator("#todos li")).toHaveCount(2);
    await expect(panel.locator(".decided").last()).toContainText("You declined");
  });

  test("Always on this site remembers the yes for that tool on that origin", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("webmcp.html"));
    await startChat(panel);
    await say(panel, "call clear_board {}");
    await slip(panel).getByRole("button", { name: "Always allow clear_board" }).click();
    await slip(panel).getByRole("button", { name: "Always on this site" }).click();
    await expect(lastReply(panel)).toContainText("Done. clear_board returned");
    await expect(site.locator("#todos li")).toHaveCount(0);
    await site.reload();
    await say(panel, "call clear_board {}");
    // The harness remembered its own "always"; the extension remembered the site.
    await expect(lastReply(panel)).toContainText("Done. clear_board returned");
    await expect(slip(panel)).toHaveCount(0);
  });
});

test.describe("tools that arrive late, and page tools only", () => {
  test("a page that registers its tools after loading updates the panel without a reload", async ({
    panel,
    env,
    site
  }) => {
    await lookAt(site, env.fixtureUrl("late.html"));
    await startChat(panel);
    await expect(panel.locator(".context")).toContainText(
      "No WebMCP tools on Slow starter (WebMCP), none yet, so the agent reads and clicks the page"
    );
    await expect(site.locator("#status")).toHaveText("Ready", { timeout: 10_000 });
    await expect(panel.locator(".context")).toContainText("1 WebMCP tool on Slow starter", { timeout: 10_000 });
  });

  test("the page's toolchange event updates the panel at once, between the timed rechecks", async ({
    panel,
    env,
    site
  }) => {
    // 5.5 s falls between the 4 s and 10 s rechecks, so only the toolchange relay can be this quick.
    await lookAt(site, `${env.fixtureUrl("late.html")}?after=5500`);
    await startChat(panel);
    await expect(site.locator("#status")).toHaveText("Ready", { timeout: 10_000 });
    await expect(panel.locator(".context")).toContainText("1 WebMCP tool on Slow starter", { timeout: 1500 });
  });

  test("a reloaded page is watched again", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("late.html"));
    await startChat(panel);
    await expect(panel.locator(".context")).toContainText("1 WebMCP tool on Slow starter", { timeout: 10_000 });
    await site.reload();
    await expect(panel.locator(".context")).toContainText("No WebMCP tools on Slow starter");
    await expect(panel.locator(".context")).toContainText("1 WebMCP tool on Slow starter", { timeout: 10_000 });
  });

  test("a page whose WebMCP never answers does not hold up the chat", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("hang.html"));
    await startChat(panel);
    await say(panel, "first message");
    await expect(lastReply(panel)).toHaveText("You said: first message", { timeout: 10_000 });
    await say(panel, "second message");
    await expect(lastReply(panel)).toHaveText("You said: second message", { timeout: 10_000 });
    await expect(panel.locator(".context")).toContainText("No WebMCP tools on Never answers");
  });

  test("with Page tools only on, the agent cannot read or click the page", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("form.html"));
    await startChat(panel);
    await panel.getByRole("button", { name: /Show all chats/ }).click();
    try {
      await panel.getByRole("checkbox", { name: /Page tools only/ }).check();
      await panel.getByRole("button", { name: "Back to chat" }).click();
      // With WebMCP on in Chrome every page has the API, so the line says tools may still come.
      await expect(panel.locator(".context")).toContainText(
        "No WebMCP tools on Order form (no WebMCP), none yet, and Page tools only is on"
      );
      await say(panel, "snapshot");
      await expect(lastReply(panel)).toContainText("Page tools only");
      await expect(site.locator("[name=name]")).toHaveValue("");
    } finally {
      await setPageToolsOnly(panel, false);
    }
  });
});

test.describe("pages without WebMCP", () => {
  test("snapshot reads the page with refs", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("form.html"));
    await startChat(panel);
    await expect(panel.locator(".context")).toContainText("No WebMCP");
    await say(panel, "snapshot");
    await expect(lastReply(panel)).toContainText(/^# Order a gig poster$/m);
    await expect(lastReply(panel)).toContainText(/\[\d+\] textbox "Name"/);
    await expect(lastReply(panel)).toContainText(/\[\d+\] button "Submit order"/);
  });

  test("type and an ordinary click go straight through", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("form.html"));
    await startChat(panel);
    await say(panel, "type Ada Lovelace into Name");
    await expect(lastReply(panel)).toContainText(
      /It now shows:\s*<page-content origin="http:\/\/127\.0\.0\.1:\d+" trust="untrusted">\s*Ada Lovelace/
    );
    await expect(site.locator("[name=name]")).toHaveValue("Ada Lovelace");
    await say(panel, "click Save draft");
    await expect(lastReply(panel)).toContainText('Clicked "Save draft"');
    await expect(site.locator("#status")).toHaveText("Draft saved for Ada Lovelace");
  });

  test("a click that submits a form asks first", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("form.html"));
    await startChat(panel);
    await say(panel, "type Grace into Name");
    await expect(lastReply(panel)).toContainText("Grace");
    await say(panel, "click Submit order");
    await expect(slip(panel)).toContainText("Browser check");
    await expect(slip(panel).getByRole("heading")).toHaveText(/wants to click on 127\.0\.0\.1/);
    await expect(slip(panel)).toContainText('This click submits a form ("Submit order")');
    await expect(site.locator("#status")).toHaveText("Nothing yet.");
    await slip(panel).getByRole("button", { name: "Allow once" }).click();
    await expect(site.locator("#status")).toHaveText("Order submitted for Grace");
  });

  test("a link to another site asks first", async ({ panel, env, site }) => {
    await lookAt(site, env.fixtureUrl("form.html"));
    await startChat(panel);
    await say(panel, "click Visit the band's site");
    await expect(slip(panel)).toContainText("This link leaves http://127.0.0.1");
    await slip(panel).getByRole("button", { name: "Decline" }).click();
    await expect(lastReply(panel)).toContainText("The click didn't happen: The user declined");
    expect(site.url()).toContain("/form.html");
  });
});
