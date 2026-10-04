// The chat on the real core: the bar, the panel and the page; streaming,
// Stop, waiting messages, Steer, the model, drafts and titles; and what the
// AI's Markdown may and may not do. Each test checks that the strict CSP
// refused nothing the screens need.
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { runningLink } from "../../server/src/server/core.ts";
import { expect, test, type Rufi } from "./rufi.ts";

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

// The CSP's refusals, collected in the page.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    const refused: string[] = [];
    Object.assign(globalThis, { refused });
    (globalThis as unknown as EventTarget).addEventListener(
      "securitypolicyviolation",
      (event) => {
        const { violatedDirective, blockedURI } = event as Event & {
          violatedDirective: string;
          blockedURI: string;
        };
        refused.push(`${violatedDirective} ${blockedURI}`);
      },
    );
  });
});
test.afterEach(async ({ page }) => {
  for (const open of page.context().pages()) {
    expect(
      await open.evaluate(
        () => (globalThis as unknown as { refused: string[] }).refused,
      ),
    ).toEqual([]);
  }
});

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });
const box = (scope: Page | Locator) =>
  scope.getByRole("textbox", { name: "Message to Rufi" });
const log = (scope: Page | Locator) =>
  scope.getByRole("log", { name: "Conversation" });
const sidebar = (page: Page) => page.getByRole("complementary");
const toolbar = (page: Page) => page.getByRole("banner");

/** Rufi with the fictional family, opened at its Overview. */
async function opened(
  page: Page,
  rufi: Rufi,
  options?: Parameters<Rufi["start"]>[0],
) {
  await rufi.family();
  await rufi.start(options);
  await page.goto(rufi.link());
  await expect(page.getByText("Latest results")).toBeVisible();
}

/** Opens the panel from the bar and sends a message from it. */
async function send(page: Page, text: string) {
  await box(chat(page)).click();
  await box(chat(page)).fill(text);
  await box(chat(page)).press("Enter");
  await expect(box(chat(page))).toHaveValue("");
}

test("the bar starts a conversation with its first message; the reply streams in and its title shows everywhere", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await expect(box(chat(page))).toHaveAttribute(
    "placeholder",
    "Ask or tell Rufi about Asha Fictional…",
  );
  await accessible(page);

  // Opening the chat creates nothing; it says what goes to OpenAI.
  await box(chat(page)).click();
  await expect(chat(page).getByText("AI can be wrong")).toBeVisible();
  await expect(chat(page)).toContainText(
    "What you send, and the parts of your record the AI reads to answer, go to OpenAI",
  );
  const usage = chat(page).getByRole("link", { name: "Manage usage" });
  await expect(usage).toHaveAttribute("target", "_blank");
  await expect(chat(page)).toContainText("Using ChatGPT plan");
  await expect(sidebar(page).getByRole("link")).toHaveText([
    "Overview",
    "Help",
    "Settings",
  ]);
  await accessible(page);

  await box(chat(page)).fill("drip: my thyroid results");
  await box(chat(page)).press("Enter");
  const reply = log(chat(page)).locator(".reply");
  await expect(reply).toContainText("ok:");
  // It streams: the first part shows before the rest has come.
  expect(await reply.textContent()).not.toBe("ok:drip");
  await expect(reply).toHaveText("ok:drip");
  await expect(log(chat(page))).toContainText("drip: my thyroid results");
  await expect(log(chat(page))).toContainText("Ran a commandls");

  // The title: in the chat's header, the sidebar and the page.
  await expect(
    chat(page).getByRole("button", { name: "drip: my thyroid results" }),
  ).toBeVisible();
  await sidebar(page)
    .getByRole("link", { name: "drip: my thyroid results" })
    .click();
  await expect(page).toHaveURL(/\/people\/asha\/conversations\/[\w-]+$/);
  await expect(toolbar(page)).toHaveText("drip: my thyroid results");
  await expect(log(page).locator(".reply")).toHaveText("ok:drip");
  await expect(chat(page)).toHaveCount(0);
  await accessible(page);

  // The page has its own address.
  await page.reload();
  await expect(log(page).locator(".reply")).toHaveText("ok:drip");
});

test("Stop keeps what the reply wrote so far", async ({ page, rufi }) => {
  await opened(page, rufi);
  await send(page, "drip");
  const reply = log(chat(page)).locator(".reply");
  await expect(reply).toContainText("ok:");
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(chat(page))).toContainText("Stopped.");
  const kept = await reply.textContent();
  expect(kept).toMatch(/^ok:d?r?i?$/);
  await expect(chat(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
});

test("messages sent during a reply wait: edit, reorder, delete, and run one after a Stop", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "hang");
  await expect(chat(page).getByRole("button", { name: "Stop" })).toBeVisible();

  await send(page, "Second");
  await send(page, "Third");
  const waiting = chat(page).getByRole("region", { name: "Waiting messages" });
  const items = waiting.getByRole("listitem");
  await expect(items).toHaveText(["Second", "Third"]);
  await accessible(page);

  await items.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(items).toHaveText(["Third", "Second"]);
  await items.nth(1).getByRole("button", { name: "Edit" }).click();
  await waiting
    .getByRole("textbox", { name: "Waiting message" })
    .fill("Second, edited");
  await waiting.getByRole("button", { name: "Save" }).click();
  await expect(items).toHaveText(["Third", "Second, edited"]);
  await items.nth(0).getByRole("button", { name: "Delete" }).click();
  await expect(items).toHaveText(["Second, edited"]);

  // After a Stop they keep waiting, until you run one.
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(chat(page))).toContainText("Stopped.");
  await expect(waiting).toContainText("send a message or run one to go on");
  await items.getByRole("button", { name: "Run now" }).click();
  await expect(log(chat(page)).locator(".reply").last()).toHaveText(
    "ok:Second, edited",
  );
  await expect(waiting).toHaveCount(0);
});

test("Steer passes your text into the running reply", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "hang");
  await box(chat(page)).fill("Only the latest results, please");
  await chat(page).getByRole("button", { name: "Steer" }).click();
  await expect(box(chat(page))).toHaveValue("");
  await expect(log(chat(page))).toContainText(
    "SteerOnly the latest results, please",
  );
  await expect(
    chat(page).getByRole("region", { name: "Waiting messages" }),
  ).toHaveCount(0);
});

test("the model is chosen per conversation, and not while a reply runs", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).click();
  const model = (name: string) =>
    chat(page).getByRole("button", { name: `Model: ${name}` });
  await model("GPT-6.1-Sol").click();
  await page.getByRole("menuitemradio", { name: "GPT-6-Astra" }).click();
  await send(page, "Hello");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");
  await expect(model("GPT-6-Astra")).toBeVisible();

  await send(page, "hang");
  await model("GPT-6-Astra").click();
  await page.getByRole("menuitemradio", { name: "GPT-6.1-Sol" }).click();
  await expect(chat(page).getByRole("alert")).toHaveText(
    "Stop the reply before changing the model.",
  );
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(chat(page))).toContainText("Stopped.");
  await model("GPT-6-Astra").click();
  await page.getByRole("menuitemradio", { name: "GPT-6.1-Sol" }).click();
  await expect(model("GPT-6.1-Sol")).toBeVisible();
  await page.reload();
  await box(chat(page)).click();
  await expect(model("GPT-6.1-Sol")).toBeVisible();
});

test("a draft survives fast typing, a reload and a restart, and is never sent by itself", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).click();
  const text = "Questions for the visit on 14 Oct: is the TSH amended?";
  await box(chat(page)).pressSequentially(text);
  // Leaving at once: the last save goes as the page goes.
  await page.reload();
  await expect(box(chat(page))).toHaveValue(text);

  const { port } = rufi.core;
  await rufi.stop();
  await rufi.start({ port });
  await page.goto(rufi.link());
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue(text);
  await expect(sidebar(page).getByRole("link")).toHaveText([
    "Overview",
    "Help",
    "Settings",
  ]);
});

test("a failed send keeps your text and says why; nothing is sent again by itself", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "Hello");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");

  let tries = 0;
  await page.route("**/messages", (route) => {
    tries += 1;
    return route.fulfill({
      status: 502,
      json: { error: "The AI couldn't take the message." },
    });
  });
  await box(chat(page)).fill("Keep this");
  await box(chat(page)).press("Enter");
  await expect(chat(page).getByRole("alert")).toHaveText(
    "The AI couldn't take the message.",
  );
  await expect(box(chat(page))).toHaveValue("Keep this");
  expect(tries).toBe(1);

  await page.unroute("**/messages");
  await box(chat(page)).press("Enter");
  await expect(box(chat(page))).toHaveValue("");
  await expect(log(chat(page)).locator(".reply").last()).toHaveText(
    "ok:Keep this",
  );
});

test("two tabs: the reply streams in both, and a draft changed in one shows in the other", async ({
  context,
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "Hello");
  const other = await context.newPage();
  await other.goto((await runningLink(rufi.home)) ?? "");
  await box(chat(other)).click();
  await expect(log(chat(other)).locator(".reply")).toHaveText("ok:Hello");

  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/drafts/") &&
      response.request().method() === "PUT" &&
      response.status() === 200,
  );
  await box(chat(page)).fill("Typed in the first tab");
  await saved;
  await box(chat(other)).fill("x");
  await expect(chat(other).getByRole("alert")).toHaveText(
    "Changed in another tab.",
  );
  await expect(box(chat(other))).toHaveValue("Typed in the first tab");

  await box(chat(page)).press("Enter");
  await expect(log(chat(other)).locator(".reply").last()).toHaveText(
    "ok:Typed in the first tab",
  );
});

test("Markdown in a reply: tables and web links work; HTML, images and other links do nothing", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await box(chat(page)).click();
  await box(chat(page)).fill(
    [
      "![pixel](http://127.0.0.1:9/pixel.png) <img src=http://127.0.0.1:9/x.png>",
      "[run](javascript:alert(1)) [inside](/settings) [web](https://example.com/page)",
      "",
      "| Test | Value |",
      "|---|---|",
      "| TSH | 4.6 mIU/L |",
    ].join("\n"),
  );
  await box(chat(page)).press("Enter");
  const reply = log(chat(page)).locator(".reply");
  await expect(reply.getByRole("cell", { name: "4.6 mIU/L" })).toBeVisible();

  await expect(reply.getByRole("link", { name: "web" })).toHaveAttribute(
    "href",
    "https://example.com/page",
  );
  // Every link goes to a web page, outside Rufi; none other is a link.
  for (const link of await reply.getByRole("link").all()) {
    await expect(link).toHaveAttribute("href", /^https?:\/\//);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  await expect(reply.locator("img")).toHaveCount(0);
  await expect(reply).toContainText("run inside web");

  const at = page.url();
  await reply.getByText("inside").click();
  await reply.getByText("run").click();
  expect(page.url()).toBe(at);
  expect(requests.filter((url) => url.includes("127.0.0.1:9"))).toEqual([]);
});

test("the chat continues the conversation you chose, after reopening Rufi", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "First conversation");
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await expect(
    chat(page).getByRole("button", { name: "New conversation" }),
  ).toBeVisible();
  await send(page, "Second conversation");
  await expect(sidebar(page).getByRole("listitem")).toHaveText([
    "Second conversation",
    "First conversation",
  ]);

  await chat(page).getByRole("button", { name: "Second conversation" }).click();
  await accessible(page);
  await page.getByRole("menuitemradio", { name: "First conversation" }).click();
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:First conversation",
  );

  await page.goto((await runningLink(rufi.home)) ?? "");
  await box(chat(page)).click();
  await expect(
    chat(page).getByRole("button", { name: "First conversation" }),
  ).toBeVisible();
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:First conversation",
  );
});

test("⌘J opens the panel; Esc steps back and returns focus", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  const settings = sidebar(page).getByRole("link", { name: "Settings" });
  await settings.focus();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(box(chat(page))).toBeFocused();
  await expect(chat(page).getByText("AI can be wrong")).toBeVisible();
  // In a menu, Esc closes the menu first.
  await chat(page).getByRole("button", { name: "Model: GPT-6.1-Sol" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(chat(page).getByText("AI can be wrong")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chat(page).getByText("AI can be wrong")).toHaveCount(0);
  await expect(settings).toBeFocused();
});

test("a small window opens the chat as a page", async ({ page, rufi }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await opened(page, rufi);
  await box(chat(page)).click();
  await expect(page).toHaveURL(/\/people\/asha\/conversations\/new$/);
  await expect(toolbar(page)).toHaveText("New conversation");
  await box(page).fill("From a small window");
  await box(page).press("Enter");
  await expect(page).toHaveURL(/\/people\/asha\/conversations\/[\w-]{30,}$/);
  await expect(log(page).locator(".reply")).toHaveText(
    "ok:From a small window",
  );
  await expect(toolbar(page)).toHaveText("From a small window");
});

test("a reply stopped by the usage limit says when it resets", async ({
  page,
  rufi,
}) => {
  const resets = new Date(2026, 9, 5, 9, 30);
  await opened(page, rufi, {
    scenario: { resetsAt: Math.floor(resets.getTime() / 1000) },
  });
  await send(page, "fail");
  await expect(log(chat(page))).toContainText(
    "Your ChatGPT plan's usage limit has been reached. It resets at 09:30 on 5 Oct 2026.",
  );
});

test.describe("on the real Codex binary, with a local fake model", () => {
  test("a reply streams; Stop; a message waits; Steer", async ({
    page,
    rufi,
  }) => {
    await opened(page, rufi, { codex: "real" });
    await send(page, "Hello");
    await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");

    await send(page, "hang");
    await expect(
      chat(page).getByRole("button", { name: "Stop" }),
    ).toBeVisible();
    await send(page, "Waits its turn");
    await expect(
      chat(page)
        .getByRole("region", { name: "Waiting messages" })
        .getByRole("listitem"),
    ).toHaveText(["Waits its turn"]);
    await box(chat(page)).fill("Steered in");
    await chat(page).getByRole("button", { name: "Steer" }).click();
    await expect(log(chat(page))).toContainText("SteerSteered in");

    await chat(page).getByRole("button", { name: "Stop" }).click();
    await expect(log(chat(page))).toContainText("Stopped.");
  });
});
