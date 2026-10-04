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

/** Lets the page show what it just heard: two frames. */
const painted = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const { requestAnimationFrame: frame } = globalThis as unknown as {
          requestAnimationFrame: (next: () => void) => void;
        };
        frame(() => {
          frame(resolve);
        });
      }),
  );

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
  await expect(chat(page).getByText("AI can be wrong")).toBeVisible();
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

test("an older read of the waiting messages never undoes a newer change", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "hang");
  await send(page, "Second");
  const waiting = chat(page).getByRole("region", { name: "Waiting messages" });
  const items = waiting.getByRole("listitem");
  await expect(items).toHaveText(["Second"]);

  // A read that still sees "Second" as it was is held back.
  const read = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let held = false;
  await page.route("**/waiting", async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    const response = await route.fetch();
    read.resolve(undefined);
    await release.promise;
    await route.fulfill({ response });
  });
  await send(page, "Third");
  await read.promise;
  await items.first().getByRole("button", { name: "Edit" }).click();
  await waiting
    .getByRole("textbox", { name: "Waiting message" })
    .fill("Second, edited");
  await waiting.getByRole("button", { name: "Save" }).click();
  await expect(items).toHaveText(["Second, edited", "Third"]);

  const late = page.waitForResponse(
    (response) =>
      response.url().endsWith("/waiting") &&
      response.request().method() === "GET",
  );
  release.resolve(undefined);
  await (await late).finished();
  await expect(items).toHaveText(["Second, edited", "Third"]);
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

test("a reload keeps what you typed while an earlier save is still on its way", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).click();
  // The core keeps the first save; its answer is held back.
  const kept = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let held = false;
  await page.route("**/drafts/*", async (route) => {
    if (route.request().method() !== "PUT" || held) return route.continue();
    held = true;
    const response = await route.fetch();
    kept.resolve(undefined);
    await release.promise;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await box(chat(page)).fill("Questions");
  await kept.promise;
  await box(chat(page)).fill("Questions for my next visit");
  await page.reload();
  release.resolve(undefined);
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("Questions for my next visit");
});

test("a reload while a message is on its way never puts it back in the box", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: { slow: ["thread/queue/add"], slowMs: 1_000 },
  });
  await send(page, "Hello");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");

  // Reloaded before the AI took it.
  const posted = page.waitForRequest((request) =>
    request.url().endsWith("/messages"),
  );
  await box(chat(page)).fill("Questions for the visit");
  await box(chat(page)).press("Enter");
  await posted;
  await page.reload();
  await box(chat(page)).click();
  await expect(log(chat(page)).locator(".reply").last()).toHaveText(
    "ok:Questions for the visit",
  );
  await expect(box(chat(page))).toHaveValue("");
});

test("a first message sent before its draft was saved stays in the box when Rufi stops before the AI took it", async ({
  page,
  rufi,
}) => {
  // Rufi waits on the AI for the list of models, then stops.
  await opened(page, rufi, { scenario: { hang: ["model/list"] } });
  await box(chat(page)).click();
  const posted = page.waitForRequest((request) =>
    request.url().endsWith("/conversations/new/messages"),
  );
  // Sent at once, before the box saved anything by itself; then the tab goes.
  await box(chat(page)).fill("Questions before my visit");
  await box(chat(page)).press("Enter");
  await posted;
  await page.goto("about:blank");
  const { port } = rufi.core;
  await rufi.stop();
  await rufi.start({ port });
  await page.goto(rufi.link());
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("Questions before my visit");
  await expect(sidebar(page).getByRole("listitem")).toHaveCount(0);
});

test("drafts as long as Rufi takes survive an immediate reload, in two conversations at once; a longer one says so", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "First conversation");
  await box(chat(page)).fill("x".repeat(10_001));
  await expect(chat(page).getByRole("alert")).toHaveText(
    "Too long to keep or send: at most 10,000 characters, and this is 10,001.",
  );
  await expect(chat(page).getByRole("button", { name: "Send" })).toBeDisabled();

  // The heaviest draft as it is saved: every character escaped, 6 bytes.
  const text = "\u0001".repeat(10_000);
  await box(chat(page)).fill(text);
  await expect(chat(page).getByRole("alert")).toHaveCount(0);
  // Its save is held back as the chat goes to another conversation: that
  // box can be typed in only when this one's text is kept.
  const held = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  await page.route("**/drafts/*", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    held.resolve(undefined);
    await release.promise;
    await route.continue();
  });
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await held.promise;
  await expect(box(chat(page))).toHaveAttribute("readonly", "");
  release.resolve(undefined);
  await expect(box(chat(page))).not.toHaveAttribute("readonly");
  await page.unroute("**/drafts/*");
  await box(chat(page)).fill(text);
  await page.reload();
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue(text);
  await chat(page).getByRole("button", { name: "New conversation" }).click();
  await page
    .getByRole("menuitemradio", { name: "First conversation", exact: true })
    .click();
  await expect(box(chat(page))).toHaveValue(text);
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

test("your last choice of conversation stays, whatever order the core hears of it", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "First conversation");
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await send(page, "Second conversation");
  const switcher = (title: string) =>
    chat(page).getByRole("button", { name: title, exact: true });
  const pick = async (from: string, to: string) => {
    await switcher(from).click();
    await page.getByRole("menuitemradio", { name: to, exact: true }).click();
  };

  // A list read that starts while a choice is on its way to the core comes
  // back with the core's older choice.
  const choosing = Promise.withResolvers<undefined>();
  const letChoiceGo = Promise.withResolvers<undefined>();
  await page.route("**/chosen", async (route) => {
    choosing.resolve(undefined);
    await letChoiceGo.promise;
    await route.continue();
  });
  await pick("Second conversation", "First conversation");
  await choosing.promise;
  const read = page.waitForResponse((response) =>
    response.url().endsWith("/conversations"),
  );
  // Coming back to the tab reads the list again.
  await page.evaluate(() => {
    (globalThis as unknown as EventTarget).dispatchEvent(
      new Event("visibilitychange"),
    );
  });
  await (await read).finished();
  await painted(page);
  await expect(switcher("First conversation")).toBeVisible();
  const chose = page.waitForResponse((r) => r.url().endsWith("/chosen"));
  letChoiceGo.resolve(undefined);
  await chose;
  await page.unroute("**/chosen");

  // The first of two choices reaches the core late.
  const first = Promise.withResolvers<undefined>();
  const letFirstGo = Promise.withResolvers<undefined>();
  let heldPut = false;
  await page.route("**/chosen", async (route) => {
    if (heldPut) return route.continue();
    heldPut = true;
    first.resolve(undefined);
    await letFirstGo.promise;
    await route.continue();
  });
  let answered = 0;
  page.on("response", (response) => {
    if (response.url().endsWith("/chosen")) answered += 1;
  });
  await pick("First conversation", "Second conversation");
  await first.promise;
  await pick("Second conversation", "First conversation");
  letFirstGo.resolve(undefined);
  await expect.poll(() => answered).toBe(2);
  await page.goto((await runningLink(rufi.home)) ?? "");
  await box(chat(page)).click();
  await expect(switcher("First conversation")).toBeVisible();
  await page.unroute("**/chosen");

  // Starting a new conversation while that choice is still on its way: the
  // chat continues the conversation the first message started.
  const toNew = Promise.withResolvers<undefined>();
  const letNewGo = Promise.withResolvers<undefined>();
  await page.route("**/chosen", async (route) => {
    toNew.resolve(undefined);
    await letNewGo.promise;
    await route.continue();
  });
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await toNew.promise;
  await expect(switcher("New conversation")).toBeVisible();
  await box(chat(page)).fill("Third conversation");
  const started = page.waitForResponse((response) =>
    response.url().endsWith("/conversations/new/messages"),
  );
  await box(chat(page)).press("Enter");
  // Long enough for the core to start the conversation before it hears of
  // the choice, unless the screen keeps them in order.
  await Promise.race([started, page.waitForTimeout(1_000)]);
  letNewGo.resolve(undefined);
  await started;
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:Third conversation",
  );
  await page.goto((await runningLink(rufi.home)) ?? "");
  await box(chat(page)).click();
  await expect(switcher("Third conversation")).toBeVisible();
});

test("a first message on its way never takes the chat away from where you went", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: { slow: ["thread/start"], slowMs: 1_000 },
  });
  await send(page, "First conversation");
  const switcher = (title: string) =>
    chat(page).getByRole("button", { name: title, exact: true });

  // In the panel: you choose another conversation before the answer comes.
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await expect(switcher("New conversation")).toBeVisible();
  await box(chat(page)).fill("Second conversation");
  const started = page.waitForResponse((response) =>
    response.url().endsWith("/conversations/new/messages"),
  );
  await box(chat(page)).press("Enter");
  await switcher("New conversation").click();
  await page
    .getByRole("menuitemradio", { name: "First conversation", exact: true })
    .click();
  expect((await started).status()).toBe(202);
  await painted(page);
  await expect(switcher("First conversation")).toBeVisible();
  await expect(sidebar(page).getByRole("listitem")).toHaveText([
    "Second conversation",
    "First conversation",
  ]);
  await page.goto((await runningLink(rufi.home)) ?? "");
  await box(chat(page)).click();
  await expect(switcher("First conversation")).toBeVisible();

  // On a new conversation's page: you go to the Overview meanwhile.
  await page.goto(new URL("/people/asha/conversations/new", page.url()).href);
  await box(page).fill("Third conversation");
  await box(page).press("Enter");
  await sidebar(page).getByRole("link", { name: "Overview" }).click();
  await expect(page.getByText("Latest results")).toBeVisible();
  // The answer came: the bar continues the conversation it started.
  await box(chat(page)).hover();
  await expect(switcher("Third conversation")).toBeVisible();
  await painted(page);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByText("Latest results")).toBeVisible();
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
  const minimise = chat(page).getByRole("button", { name: "Minimise" });
  await expect(minimise).toBeVisible();
  // In a menu, Esc closes the menu first.
  await chat(page).getByRole("button", { name: "Model: GPT-6.1-Sol" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(minimise).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(minimise).toHaveCount(0);
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
  test("a reply streams after Rufi's tool; Stop; a message waits; Steer", async ({
    page,
    rufi,
  }) => {
    await opened(page, rufi, { codex: "real" });
    // The model reads Rufi's overview first: one line says so, in plain words.
    await send(page, "Read my overview");
    await expect(log(chat(page)).locator(".reply")).toHaveText(
      "ok:Read my overview",
    );
    await expect(log(chat(page))).toContainText("Read your overview");

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
