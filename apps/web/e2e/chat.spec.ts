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

test("using the bar starts a conversation at once; the reply streams in and its title shows everywhere", async ({
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

  // No conversation until you use the box; then it is there, unnamed, and
  // the chat says what goes to OpenAI.
  await expect(sidebar(page).getByRole("link")).toHaveText([
    "Overview",
    "Help",
    "Settings",
  ]);
  await box(chat(page)).click();
  await expect(sidebar(page).getByRole("listitem")).toHaveText([
    "New conversation",
  ]);
  await expect(chat(page).getByText("AI can be wrong")).toBeVisible();
  await expect(chat(page)).toContainText(
    "What you send, and the parts of your record the AI reads to answer, go to OpenAI",
  );
  const usage = chat(page).getByRole("link", { name: "Manage usage" });
  await expect(usage).toHaveAttribute("target", "_blank");
  await expect(chat(page)).toContainText("Using ChatGPT plan");
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
  // The reply writes a part, then runs until it is stopped.
  await send(page, "partial");
  const reply = log(chat(page)).locator(".reply");
  await expect(reply).toHaveText("ok:part");
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(chat(page))).toContainText("Stopped.");
  await expect(reply).toHaveText("ok:part");
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
  await model("GPT-6-Astra").click();
  await page.getByRole("menuitemradio", { name: "GPT-6.1-Sol" }).click();
  await send(page, "Hello");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");
  await expect(model("GPT-6.1-Sol")).toBeVisible();

  await send(page, "hang");
  await model("GPT-6.1-Sol").click();
  await page.getByRole("menuitemradio", { name: "GPT-6-Astra" }).click();
  await expect(chat(page).getByRole("alert")).toHaveText(
    "Stop the reply before changing the model.",
  );
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(chat(page))).toContainText("Stopped.");
  await model("GPT-6.1-Sol").click();
  await page.getByRole("menuitemradio", { name: "GPT-6-Astra" }).click();
  await expect(model("GPT-6-Astra")).toBeVisible();
  await page.reload();
  await box(chat(page)).click();
  await expect(model("GPT-6-Astra")).toBeVisible();
});

test("a saved draft survives a reload and a restart, and is never sent by itself", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).click();
  const text = "Questions for the visit on 14 Oct: is the TSH amended?";
  // The conversation is made as the box is used; its own box then opens.
  await expect(box(chat(page))).toBeEditable();
  await box(chat(page)).pressSequentially(text);
  await expect(chat(page).getByRole("status")).toHaveText("Saved");
  await page.reload();
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue(text);

  const { port } = rufi.core;
  await rufi.stop();
  await rufi.start({ port });
  await page.goto(rufi.link());
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue(text);
  await expect(chat(page).getByRole("status")).toHaveText("Saved");
  await expect(log(chat(page))).toHaveCount(0);
});

test("a save that fails says so and keeps the text in the tab, also when you went to another conversation; Retry saves it", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "First conversation");
  // The core refuses every save for now, as when it can't keep anything.
  await page.route("**/drafts/*", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "Rufi couldn't save." } })
      : route.continue(),
  );
  await box(chat(page)).fill("Half a question");
  await expect(chat(page).getByRole("status")).toHaveText(
    /^Not saved\s*Retry$/,
  );
  await expect(chat(page).getByRole("alert")).toHaveText("Rufi couldn't save.");

  // Typed, then off to a new conversation at once: its save fails too.
  await box(chat(page)).fill("Half a question, and more");
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await expect(
    chat(page).getByRole("button", { name: "New conversation" }),
  ).toBeVisible();
  await chat(page).getByRole("button", { name: "New conversation" }).click();
  await page
    .getByRole("menuitemradio", { name: "First conversation", exact: true })
    .click();
  await expect(box(chat(page))).toHaveValue("Half a question, and more");
  await expect(chat(page).getByRole("status")).toHaveText(
    /^Not saved\s*Retry$/,
  );

  await page.unroute("**/drafts/*");
  await chat(page).getByRole("button", { name: "Retry" }).click();
  await expect(chat(page).getByRole("status")).toHaveText("Saved");
  await page.reload();
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("Half a question, and more");
});

test("a save whose answer is lost keeps what you typed after it", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).click();
  await expect(box(chat(page))).toBeEditable();
  // The core keeps the first save, but its answer never reaches the page.
  const stored = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let first = true;
  await page.route("**/drafts/*", async (route) => {
    if (route.request().method() !== "PUT" || !first) return route.continue();
    first = false;
    await route.fetch();
    stored.resolve(undefined);
    await release.promise;
    await route.abort("failed");
  });
  await box(chat(page)).fill("Start of question");
  await stored.promise;
  await box(chat(page)).fill("Start of question, and more");
  release.resolve(undefined);
  await expect(chat(page).getByRole("status")).toHaveText("Saved");
  await expect(box(chat(page))).toHaveValue("Start of question, and more");
  await expect(chat(page).getByRole("alert")).toHaveCount(0);
  await page.reload();
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("Start of question, and more");
});

test("Send's own save says Saving…, not Sending…; a reload then loses only that unsaved text", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).click();
  await expect(box(chat(page))).toBeEditable();
  const saving = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  await page.route("**/drafts/*", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    saving.resolve(undefined);
    await release.promise;
    await route.continue().catch(() => undefined);
  });
  await box(chat(page)).fill("Message clicked Send");
  await box(chat(page)).press("Enter");
  await saving.promise;
  await expect(chat(page).getByRole("status")).toHaveText("Saving…");
  await expect(box(chat(page))).toHaveAttribute("readonly", "");
  await page.reload();
  release.resolve(undefined);
  await page.unroute("**/drafts/*");
  await box(chat(page)).click();
  await expect(box(chat(page))).toBeEditable();
  await expect(box(chat(page))).toHaveValue("");
  await expect(log(chat(page))).toHaveCount(0);
});

test("a reload while a message is on its way never puts it back in the box", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: { slow: ["thread/queue/add"], slowMs: 2_000 },
  });
  await send(page, "Hello");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");

  // Reloaded before the AI took it: the box shows it held, then empty.
  const posted = page.waitForRequest((request) =>
    request.url().endsWith("/messages"),
  );
  await box(chat(page)).fill("Questions for the visit");
  await box(chat(page)).press("Enter");
  await posted;
  await page.reload();
  await box(chat(page)).click();
  await expect(chat(page).getByRole("status")).toHaveText("Sending…");
  await expect(box(chat(page))).toHaveAttribute("readonly", "");
  await expect(log(chat(page)).locator(".reply").last()).toHaveText(
    "ok:Questions for the visit",
  );
  await expect(box(chat(page))).toHaveValue("");
});

test("when Rufi stops during a send, the text stays and the box says to check the conversation", async ({
  page,
  rufi,
}) => {
  // Codex never starts the conversation's thread; then Rufi stops.
  await opened(page, rufi, { scenario: { hang: ["thread/start"] } });
  await box(chat(page)).click();
  const posted = page.waitForRequest((request) =>
    request.url().endsWith("/messages"),
  );
  await box(chat(page)).fill("Questions before my visit");
  await box(chat(page)).press("Enter");
  await posted;
  await expect(chat(page).getByRole("status")).toHaveText("Sending…");
  await page.goto("about:blank");
  const { port } = rufi.core;
  await rufi.stop();
  await rufi.start({ port });
  await page.goto(rufi.link());
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("Questions before my visit");
  await expect(chat(page).getByRole("alert")).toHaveText(
    "Rufi doesn't know whether the AI got this message. Check the conversation before you send it again.",
  );
  // Never sent again by itself; the person can edit it or send it.
  await expect(box(chat(page))).not.toHaveAttribute("readonly");
  await expect(log(chat(page))).toHaveCount(0);
});

test("a draft longer than Rufi takes says so, and isn't kept or sent", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).click();
  await box(chat(page)).fill("x".repeat(10_001));
  await expect(chat(page).getByRole("alert")).toHaveText(
    "Too long to keep or send: at most 10,000 characters, and this is 10,001.",
  );
  await expect(chat(page).getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(chat(page).getByRole("status")).toHaveText("Saving…");
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

  await expect(box(chat(page))).not.toHaveAttribute("readonly");
  await page.unroute("**/messages");
  await box(chat(page)).press("Enter");
  await expect(box(chat(page))).toHaveValue("");
  await expect(log(chat(page)).locator(".reply").last()).toHaveText(
    "ok:Keep this",
  );
});

test("two tabs: the reply streams in both; a draft changed in one shows in the other, which can't change it while it is sent", async ({
  context,
  page,
  rufi,
}) => {
  // Codex takes a while to take each message.
  await opened(page, rufi, {
    scenario: { slow: ["thread/queue/add"], slowMs: 1_500 },
  });
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

  // While the first tab sends it, the other can't change it, and shows it
  // held until the AI took it.
  const posted = page.waitForRequest((request) =>
    request.url().endsWith("/messages"),
  );
  await box(chat(page)).press("Enter");
  await posted;
  await expect(chat(page).getByRole("status")).toHaveText("Sending…");
  await box(chat(other)).press("End");
  await box(chat(other)).pressSequentially("!");
  await expect(chat(other).getByRole("status")).toHaveText("Sending…");
  await expect(box(chat(other))).toHaveValue("Typed in the first tab");
  await expect(box(chat(other))).toHaveAttribute("readonly", "");
  await expect(log(chat(other)).locator(".reply").last()).toHaveText(
    "ok:Typed in the first tab",
  );
  await expect(box(chat(other))).toHaveValue("");
  await expect(box(chat(other))).not.toHaveAttribute("readonly");
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

test("the conversation you chose stays on screen whatever the core answers, and opens again next time", async ({
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

  // A choice that fails, answered after two later ones: the chat stays on
  // the last choice, and the core keeps it.
  const failing = Promise.withResolvers<undefined>();
  const letFailGo = Promise.withResolvers<undefined>();
  let failed = false;
  await page.route("**/chosen", async (route) => {
    if (failed) return route.continue();
    failed = true;
    failing.resolve(undefined);
    await letFailGo.promise;
    await route.fulfill({
      status: 500,
      json: { error: "Rufi had a problem." },
    });
  });
  const answers = page.waitForResponse(
    (r) => r.url().endsWith("/chosen") && r.status() === 200,
  );
  await pick("First conversation", "Second conversation");
  await failing.promise;
  await pick("Second conversation", "First conversation");
  await pick("First conversation", "Second conversation");
  letFailGo.resolve(undefined);
  await answers;
  await painted(page);
  await expect(switcher("Second conversation")).toBeVisible();
  await page.unroute("**/chosen");

  // A new conversation the core makes slowly, while you choose another one:
  // it is listed, and the chat stays where you went.
  const creating = Promise.withResolvers<undefined>();
  const letCreateGo = Promise.withResolvers<undefined>();
  await page.route("**/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creating.resolve(undefined);
    await letCreateGo.promise;
    await route.continue();
  });
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/conversations") && r.request().method() === "POST",
  );
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await creating.promise;
  await pick("Second conversation", "First conversation");
  letCreateGo.resolve(undefined);
  await created;
  await expect(sidebar(page).getByRole("listitem")).toHaveText([
    "New conversation",
    "Second conversation",
    "First conversation",
  ]);
  await painted(page);
  await expect(switcher("First conversation")).toBeVisible();
  await page.unroute("**/conversations");

  // A send doesn't wait for a choice still on its way to the core.
  const letLastGo = Promise.withResolvers<undefined>();
  await page.route("**/chosen", async (route) => {
    await letLastGo.promise;
    await route.continue();
  });
  await pick("First conversation", "Second conversation");
  await box(chat(page)).fill("Still here");
  await box(chat(page)).press("Enter");
  await expect(log(chat(page)).locator(".reply").last()).toHaveText(
    "ok:Still here",
  );
  const last = page.waitForResponse((r) => r.url().endsWith("/chosen"));
  letLastGo.resolve(undefined);
  await last;
  await page.goto((await runningLink(rufi.home)) ?? "");
  await box(chat(page)).click();
  await expect(switcher("Second conversation")).toBeVisible();
});

test("while New conversation is being made, nothing can be sent into the one before, and a later move wins over it", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "Previous context");
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:Previous context",
  );
  // A saved draft that Enter would send into the conversation before.
  await box(chat(page)).fill("Not for the old one");
  await expect(chat(page).getByRole("status")).toHaveText("Saved");
  let sends = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/messages")) sends += 1;
  });
  const creating = Promise.withResolvers<undefined>();
  let release = Promise.withResolvers<undefined>();
  await page.route("**/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creating.resolve(undefined);
    await release.promise;
    await route.continue();
  });
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await creating.promise;
  await expect(chat(page).getByRole("status")).toHaveText(
    "Starting a new conversation…",
  );
  await expect(box(chat(page))).toHaveAttribute("readonly", "");
  await box(chat(page)).press("Enter");
  release.resolve(undefined);
  await expect(
    chat(page).getByRole("button", { name: "New conversation", exact: true }),
  ).toBeVisible();
  await expect(box(chat(page))).toBeEditable();
  expect(sends).toBe(0);

  // From a conversation's page: you go to Settings before it is made.
  await sidebar(page).getByRole("link", { name: "Previous context" }).click();
  await expect(page).toHaveURL(/\/conversations\//);
  release = Promise.withResolvers<undefined>();
  const made = page.waitForResponse(
    (r) =>
      r.url().endsWith("/conversations") && r.request().method() === "POST",
  );
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await sidebar(page).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  release.resolve(undefined);
  await made;
  await painted(page);
  await expect(page).toHaveURL(/\/settings$/);

  // Back to the conversation it was started from, before it is made.
  await sidebar(page).getByRole("link", { name: "Previous context" }).click();
  const previous = page.url();
  release = Promise.withResolvers<undefined>();
  const again = page.waitForResponse(
    (r) =>
      r.url().endsWith("/conversations") && r.request().method() === "POST",
  );
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await sidebar(page).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await sidebar(page).getByRole("link", { name: "Previous context" }).click();
  await expect(page).toHaveURL(previous);
  release.resolve(undefined);
  await again;
  await painted(page);
  await expect(page).toHaveURL(previous);
});

test("a send never moves the chat; back in its conversation, the box shows it held until it ends", async ({
  page,
  rufi,
}) => {
  // Codex takes a while to start each conversation's thread.
  await opened(page, rufi, {
    scenario: { slow: ["thread/start"], slowMs: 1_000 },
  });
  await send(page, "First conversation");
  const switcher = (title: string) =>
    chat(page).getByRole("button", { name: title, exact: true });
  const pick = async (from: string, to: string) => {
    await switcher(from).click();
    await page.getByRole("menuitemradio", { name: to, exact: true }).click();
  };
  await sidebar(page).getByRole("button", { name: "New conversation" }).click();
  await expect(switcher("New conversation")).toBeVisible();

  // Send while the box's save is held back; you go to another conversation
  // before it lands.
  const saving = Promise.withResolvers<undefined>();
  const letSaveGo = Promise.withResolvers<undefined>();
  await page.route("**/drafts/*", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    saving.resolve(undefined);
    await letSaveGo.promise;
    await route.continue();
  });
  await box(chat(page)).fill("Second conversation");
  const posted = page.waitForRequest((request) =>
    request.url().endsWith("/messages"),
  );
  await box(chat(page)).press("Enter");
  await saving.promise;
  await pick("New conversation", "First conversation");
  letSaveGo.resolve(undefined);
  await posted;
  await page.unroute("**/drafts/*");
  await painted(page);
  await expect(switcher("First conversation")).toBeVisible();

  // Back while the send is still on its way: held, then empty to type in.
  await pick("First conversation", "New conversation");
  await expect(box(chat(page))).toHaveValue("Second conversation");
  await expect(chat(page).getByRole("status")).toHaveText("Sending…");
  await expect(box(chat(page))).toHaveAttribute("readonly", "");
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:Second conversation",
  );
  await expect(box(chat(page))).toHaveValue("");
  await expect(box(chat(page))).not.toHaveAttribute("readonly");
  await expect(switcher("Second conversation")).toBeVisible();
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
  await chat(page).getByRole("button", { name: "Model: GPT-6-Astra" }).click();
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
  await expect(page).toHaveURL(/\/people\/asha\/conversations\/[\w-]{30,}$/);
  const at = page.url();
  await expect(toolbar(page)).toHaveText("New conversation");
  await box(page).fill("From a small window");
  await box(page).press("Enter");
  await expect(log(page).locator(".reply")).toHaveText(
    "ok:From a small window",
  );
  await expect(toolbar(page)).toHaveText("From a small window");
  expect(page.url()).toBe(at);
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

test("a save to the record shows Rufi's receipt, also after a reload", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: {
      calls: [
        {
          namespace: "rufi",
          tool: "save_changes",
          arguments: {
            changes: [
              {
                kind: "symptom",
                action: "add",
                source: "I have a headache",
                fields: { name: "Headache" },
              },
            ],
          },
        },
      ],
    },
  });
  /** "Saved", then one line per change with the record's name in bold. */
  const shown = async (scope: Page | Locator) => {
    const receipt = log(scope).locator(".receipt");
    await expect(receipt.locator("p strong")).toHaveText("Saved");
    await expect(receipt.getByRole("listitem")).toHaveText([
      "Added symptom Headache",
    ]);
    await expect(receipt.getByRole("listitem").locator("strong")).toHaveText(
      "Headache",
    );
  };
  await send(page, "I have a headache");
  await shown(chat(page));
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:I have a headache",
  );
  await accessible(page);
  await page.reload();
  await box(chat(page)).click();
  await shown(chat(page));

  // The conversation's own page shows it the same way.
  await sidebar(page).getByRole("link", { name: "I have a headache" }).click();
  await expect(chat(page)).toHaveCount(0);
  await shown(page);
  await accessible(page);
});

test("Based on, under an answer once it ended, opens How and Used; small talk has none; a stopped reply has no How", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: {
      calls: [
        {
          namespace: "rufi",
          tool: "get_records",
          arguments: { kind: "result", from: "2026-08", to: "2026-08" },
        },
      ],
    },
  });
  const basedOn = log(chat(page)).getByText("Based on", { exact: true });
  // The fake answers with the message's own words: here, a rufi-basis block.
  await send(
    page,
    "Your last HbA1c\n\n```rufi-basis\nFrom your record, read now.\n```",
  );
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:Your last HbA1c",
  );
  // The activity line and Used name the read in the same plain words.
  await expect(log(chat(page))).toContainText("Read your results in Aug 2026");
  await expect(basedOn).toHaveCount(1);
  // A link that opens from the keyboard too.
  await basedOn.focus();
  await page.keyboard.press("Enter");
  const opened1 = log(chat(page)).locator("details[open]");
  await expect(
    opened1.getByText("From your record, read now.", { exact: true }),
  ).toBeVisible();
  await expect(opened1.getByRole("listitem")).toHaveText([
    "Read your results in Aug 2026 · 5 records",
    "Ran a commandls",
  ]);
  await accessible(page);

  await send(page, "quiet thanks");
  await expect(log(chat(page)).locator(".reply").nth(1)).toHaveText(
    "ok:quiet thanks",
  );
  await expect(basedOn).toHaveCount(1);

  // While a reply runs, it has no Based on; stopped, it shows what was read.
  await send(page, "partial");
  await expect(log(chat(page)).locator(".reply").nth(2)).toHaveText("ok:part");
  await expect(basedOn).toHaveCount(1);
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(chat(page)).getByText("Stopped.")).toBeVisible();
  await expect(basedOn).toHaveCount(2);
  await basedOn.nth(1).click();
  const stopped = log(chat(page)).locator("details").nth(1);
  await expect(stopped.getByText("How", { exact: true })).toHaveCount(0);
  await expect(stopped.getByRole("listitem")).toHaveCount(1);

  // After a reload, the same.
  await page.reload();
  await box(chat(page)).click();
  await expect(basedOn).toHaveCount(2);
  await basedOn.first().click();
  await expect(
    log(chat(page)).getByText("From your record, read now.", { exact: true }),
  ).toBeVisible();
});

test("activity lines keep their sign beside a long detail; Rufi's own tool lines say only what they did", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: {
      calls: [
        {
          namespace: "rufi",
          tool: "save_changes",
          arguments: {
            changes: [
              {
                kind: "symptom",
                action: "add",
                source: "I have a headache",
                fields: { name: "Headache" },
              },
            ],
          },
        },
        {
          namespace: "elsewhere",
          tool: "lookup",
          arguments: { query: "headache ".repeat(40) },
        },
      ],
    },
  });
  await send(page, "I have a headache");
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:I have a headache",
  );
  const own = log(chat(page)).locator("p", { hasText: "Save to your record" });
  await expect(own).toHaveText("done:Save to your record");
  const other = log(chat(page)).locator("p", { hasText: "Used a tool" });
  await expect(other).toContainText('{"query":"headache headache');
  // The sign keeps its 13 px beside a detail longer than the line.
  for (const line of [own, other]) {
    const sign = await line.locator("svg").boundingBox();
    expect(sign?.width).toBe(13);
  }
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
