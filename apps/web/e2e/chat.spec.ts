// The chat on the real core: the bar, the panel and the page of the
// person's one chat; streaming, Stop, waiting messages, Steer, the model and
// drafts; older pages, day lines and where the AI started afresh; and what
// the AI's Markdown may and may not do. Each test checks that the strict CSP
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
  scope.getByRole("log", { name: "Messages" });
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

/** The core's answer to a save of the draft that holds `text`. */
const kept = (page: Page, text: string) =>
  page.waitForResponse(
    (response) =>
      response.url().endsWith("/chat/draft") &&
      response.request().method() === "PUT" &&
      response.ok() &&
      (response.request().postData() ?? "").includes(text),
  );

/** Opens the panel from the bar and sends a message from it. */
async function send(page: Page, text: string) {
  await box(chat(page)).click();
  await box(chat(page)).fill(text);
  await box(chat(page)).press("Enter");
  await expect(box(chat(page))).toHaveValue("");
}

test("the bar, the panel and Chat with Rufi are one chat: the reply streams in, the page has its own address, and an old conversation's address opens it", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await expect(box(chat(page))).toHaveAttribute(
    "placeholder",
    "Ask or tell Rufi about Asha Fictional…",
  );
  await expect(
    chat(page).getByText("AI can make mistakes. Check important info."),
  ).toBeVisible();
  await expect(sidebar(page).getByRole("link")).toHaveText([
    "Chat with Rufi",
    "Overview",
    "Documents",
    "Help",
    "Settings",
  ]);
  await accessible(page);

  // The panel: the chat's name, and what goes to OpenAI before the first message.
  await box(chat(page)).click();
  await expect(
    chat(page).getByRole("heading", { name: "Chat with Rufi" }),
  ).toBeVisible();
  await expect(chat(page)).toContainText(
    "What you send, and the parts of your record the AI reads to answer, go to OpenAI",
  );
  await accessible(page);
  // The plan it uses, quietly under the box, never only in a menu.
  await expect(chat(page)).toContainText(
    "Using ChatGPT plan · Manage usage · AI can make mistakes. Check important info.",
  );
  await expect(
    chat(page).getByRole("link", { name: "Manage usage" }),
  ).toHaveAttribute("target", "_blank");
  await chat(page)
    .getByRole("button", { name: "Model and effort: GPT-6-Astra, Medium" })
    .click();
  await expect(page.getByRole("menu")).not.toContainText("Using ChatGPT plan");
  await page.keyboard.press("Escape");

  await box(chat(page)).fill("drip: my thyroid results");
  await box(chat(page)).press("Enter");
  const reply = log(chat(page)).locator(".reply");
  await expect(reply).toContainText("ok:");
  // It streams: the first part shows before the rest has come.
  expect(await reply.textContent()).not.toBe("ok:drip");
  await expect(reply).toHaveText("ok:drip");
  await expect(log(chat(page))).toContainText("drip: my thyroid results");
  await expect(log(chat(page))).toContainText("Ran a commandls");
  await expect(log(chat(page))).toContainText("Today");

  // The same chat as its page.
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(page).toHaveURL(/\/people\/asha\/chat$/);
  await expect(toolbar(page)).toHaveText("Chat with Rufi");
  await expect(log(page).locator(".reply")).toHaveText("ok:drip");
  await expect(chat(page)).toHaveCount(0);
  await accessible(page);
  await page.reload();
  await expect(log(page).locator(".reply")).toHaveText("ok:drip");

  // An address of a conversation from before leads to the chat.
  await page.goto(
    new URL(
      "/people/asha/conversations/0199b1a0-0000-7000-8000-000000000000",
      page.url(),
    ).href,
  );
  await expect(page).toHaveURL(/\/people\/asha\/chat$/);
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

test("signed out, the chat doesn't say it uses the ChatGPT plan", async ({
  page,
  rufi,
}) => {
  rufi.account = { account: "signed_out", email: null };
  await opened(page, rufi);
  // The bar, then the panel.
  await expect(chat(page)).toContainText(
    "AI can make mistakes. Check important info.",
  );
  await expect(chat(page)).not.toContainText("Using ChatGPT plan");
  await box(chat(page)).click();
  await expect(chat(page)).toContainText("What you send");
  await expect(chat(page)).not.toContainText("Using ChatGPT plan");
  await expect(
    chat(page).getByRole("link", { name: "Manage usage" }),
  ).toHaveCount(0);
});

test("signed out, the model's button has no empty place for a name, and its menu signs in", async ({
  page,
  rufi,
}) => {
  rufi.account = { account: "signed_out", email: null };
  // The core can't list the models without the sign-in.
  await page.route("**/api/models", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error:
          "Not signed in. Sign in with ChatGPT: in Rufi, or with pnpm rufi signin.",
      },
    }),
  );
  await opened(page, rufi);
  const choice = chat(page).getByRole("button", { name: /^Model and effort/ });
  await expect(choice).toHaveText("Medium");
  expect((await choice.boundingBox())?.width ?? 0).toBeLessThan(110);
  await box(chat(page)).click();
  await choice.click();
  await expect(page.getByRole("menu")).not.toContainText("pnpm");
  await page.getByRole("menuitem", { name: "Sign in with ChatGPT" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(
    page.getByRole("button", { name: "Sign in with ChatGPT" }),
  ).toBeVisible();
});

test("the button for the model never says Model or a model's id: before the list of models comes, it keeps the name's place empty", async ({
  page,
  rufi,
}) => {
  const held = Promise.withResolvers<undefined>();
  await page.route("**/api/models", async (route) => {
    await held.promise;
    await route.continue();
  });
  await opened(page, rufi);
  const choice = chat(page).getByRole("button", { name: /^Model and effort/ });
  // A new chat has no model of its own yet.
  await expect(choice).toHaveText("Medium");
  held.resolve(undefined);
  await expect(choice).toHaveText("GPT-6-AstraMedium");
  await choice.click();
  await page.getByRole("menuitemradio", { name: "GPT-6.1-Sol" }).click();
  await expect(choice).toHaveText("GPT-6.1-SolMedium");

  // Reloaded while the list is slow: still no name, and never the id.
  const again = Promise.withResolvers<undefined>();
  await page.unroute("**/api/models");
  await page.route("**/api/models", async (route) => {
    await again.promise;
    await route.continue();
  });
  await page.reload();
  await expect(choice).toHaveText("Medium");
  again.resolve(undefined);
  await expect(choice).toHaveText("GPT-6.1-SolMedium");
});

test("the model and effort are chosen in the box, also in the bar, and kept for the chat; a new effort doesn't start the AI afresh; neither changes while a reply runs", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  const choice = (now: string) =>
    page.getByRole("button", { name: `Model and effort: ${now}` });
  const option = (name: string) =>
    page.getByRole("menuitemradio", { name, exact: true });
  // The bar shows both before the panel opens.
  await expect(log(chat(page))).toHaveCount(0);
  await expect(choice("GPT-6-Astra, Medium")).toBeVisible();
  await choice("GPT-6-Astra, Medium").click();
  await expect(option("GPT-6-Astra")).toHaveAttribute("aria-checked", "true");
  await expect(option("Medium")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menu")).toContainText(
    "Medium: careful answers at a good speed. Low is faster; High thinks longer.",
  );
  await option("GPT-6.1-Sol").click();
  await expect(choice("GPT-6.1-Sol, Medium")).toBeVisible();
  await send(page, "Hello");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");

  // A new effort applies from the next reply, with no quiet line.
  await choice("GPT-6.1-Sol, Medium").click();
  await option("High").click();
  await expect(choice("GPT-6.1-Sol, High")).toBeVisible();
  await send(page, "Again");
  await expect(log(chat(page)).locator(".reply").last()).toHaveText("ok:Again");
  await expect(log(chat(page))).not.toContainText("started afresh");

  // Neither changes while a reply runs.
  await send(page, "hang");
  await choice("GPT-6.1-Sol, High").click();
  await option("GPT-6-Astra").click();
  await expect(chat(page).getByRole("alert")).toHaveText(
    "Stop the reply before changing the model.",
  );
  await choice("GPT-6.1-Sol, High").click();
  await option("Low").click();
  await expect(chat(page).getByRole("alert")).toHaveText(
    "Stop the reply before changing the effort.",
  );
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(chat(page))).toContainText("Stopped.");
  await choice("GPT-6.1-Sol, High").click();
  await option("GPT-6-Astra").click();
  await expect(choice("GPT-6-Astra, High")).toBeVisible();

  // Kept for the chat: in the bar after a reload, and in the chat page's box,
  // whose top has nothing to choose.
  await page.reload();
  await expect(choice("GPT-6-Astra, High")).toBeVisible();
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(toolbar(page)).toHaveText("Chat with Rufi");
  await expect(
    page.getByRole("main").getByRole("button", { name: /^Model/ }),
  ).toHaveCount(1);
  await expect(choice("GPT-6-Astra, High")).toBeVisible();
});

test("a draft is saved as you type, silently; it survives a reload and a restart, and is never sent by itself", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).click();
  const text = "Questions for the visit on 14 Oct: is the TSH amended?";
  await expect(box(chat(page))).toBeEditable();
  const saved = kept(page, text);
  await box(chat(page)).pressSequentially(text);
  await saved;
  await expect(chat(page).getByRole("status")).toHaveCount(0);
  await page.reload();
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue(text);

  const { port } = rufi.core;
  await rufi.stop();
  await rufi.start({ port });
  await page.goto(rufi.link());
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue(text);
  await expect(log(chat(page))).toHaveCount(0);
});

test("a save that fails says so and keeps the text in the tab, also on the chat's page; Retry saves it", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "First question");
  // The core refuses every save for now, as when it can't keep anything.
  await page.route("**/chat/draft", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "Rufi couldn't save." } })
      : route.continue(),
  );
  await box(chat(page)).fill("Half a question");
  await expect(chat(page).getByRole("status")).toHaveText(
    /^Not saved\s*Retry$/,
  );
  await expect(chat(page).getByRole("alert")).toHaveText("Rufi couldn't save.");

  // Off to the chat's page: its box has the text, still not saved, and
  // what is typed there fails to save too.
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(box(page)).toHaveValue("Half a question");
  await expect(page.getByRole("status")).toHaveText(/^Not saved\s*Retry$/);
  const refused = page.waitForResponse(
    (response) =>
      response.url().endsWith("/chat/draft") &&
      response.request().method() === "PUT" &&
      (response.request().postData() ?? "").includes("and more"),
  );
  await box(page).fill("Half a question, and more");
  await refused;
  await expect(page.getByRole("status")).toHaveText(/^Not saved\s*Retry$/);

  await page.unroute("**/chat/draft");
  const saved = kept(page, "and more");
  await page.getByRole("button", { name: "Retry" }).click();
  await saved;
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.reload();
  await expect(box(page)).toHaveValue("Half a question, and more");
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
  await page.route("**/chat/draft", async (route) => {
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
  const saved = kept(page, "and more");
  release.resolve(undefined);
  await saved;
  await expect(box(chat(page))).toHaveValue("Start of question, and more");
  await expect(chat(page).getByRole("alert")).toHaveCount(0);
  await page.reload();
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("Start of question, and more");
});

test("Send's own save is quiet, and the box is read-only meanwhile; a reload then loses only that unsaved text", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).click();
  await expect(box(chat(page))).toBeEditable();
  const saving = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  await page.route("**/chat/draft", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    saving.resolve(undefined);
    await release.promise;
    await route.continue().catch(() => undefined);
  });
  await box(chat(page)).fill("Message clicked Send");
  await box(chat(page)).press("Enter");
  await saving.promise;
  await expect(box(chat(page))).toHaveAttribute("readonly", "");
  await expect(chat(page).getByRole("status")).toHaveCount(0);
  await page.reload();
  release.resolve(undefined);
  await page.unroute("**/chat/draft");
  await box(chat(page)).click();
  await expect(box(chat(page))).toBeEditable();
  await expect(box(chat(page))).toHaveValue("");
  // Nothing was sent: the chat still has no message.
  await expect(chat(page)).toContainText(
    "What you send, and the parts of your record the AI reads to answer",
  );
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

test("when Rufi stops during a send, the text stays and the box says to check the chat", async ({
  page,
  rufi,
}) => {
  // Codex never starts the chat's thread; then Rufi stops.
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
    "Rufi doesn't know whether the AI got this message. Check the chat before you send it again.",
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
  await page.reload();
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("");
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

test("two tabs: the reply streams in both; the last save wins; while one sends, the other can't change the text", async ({
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

  // Each tab saves over the other, and says nothing.
  const first = kept(page, "Typed in the first tab");
  await box(chat(page)).fill("Typed in the first tab");
  await first;
  const second = kept(other, "Typed in the second tab");
  await box(chat(other)).fill("Typed in the second tab");
  await second;
  await expect(chat(other).getByRole("alert")).toHaveCount(0);
  await page.reload();
  await box(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("Typed in the second tab");

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
  await expect(box(chat(other))).toHaveValue("Typed in the second tab");
  await expect(box(chat(other))).toHaveAttribute("readonly", "");
  await expect(log(chat(other)).locator(".reply").last()).toHaveText(
    "ok:Typed in the second tab",
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
  await chat(page)
    .getByRole("button", { name: "Model and effort: GPT-6-Astra, Medium" })
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(minimise).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(minimise).toHaveCount(0);
  await expect(settings).toBeFocused();
});

test("a click outside the panel steps back to the bar and keeps what you typed; a click in it, its menu, Stop or Based on doesn't", async ({
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
  const minimise = chat(page).getByRole("button", { name: "Minimise" });
  await send(
    page,
    "Your last HbA1c\n\n```rufi-basis\nFrom your record, read now.\n```",
  );
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:Your last HbA1c",
  );
  await log(chat(page)).getByText("Based on", { exact: true }).click();
  await expect(log(chat(page))).toContainText("From your record, read now.");
  await expect(minimise).toBeVisible();
  // A reply that runs until it is stopped.
  await send(page, "partial");
  await expect(log(chat(page)).locator(".reply").last()).toHaveText("ok:part");
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(chat(page))).toContainText("Stopped.");
  await expect(minimise).toBeVisible();
  await chat(page)
    .getByRole("button", { name: /^Model and effort: / })
    .click();
  await page.getByRole("menuitemradio", { name: "GPT-6.1-Sol" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(minimise).toBeVisible();

  await box(chat(page)).fill("Half a thought");
  await page.getByRole("main").click({ position: { x: 20, y: 20 } });
  await expect(minimise).toHaveCount(0);
  await expect(box(chat(page))).toHaveValue("Half a thought");
  await expect(log(chat(page))).toHaveCount(0);

  // With the menu open, one click outside closes both.
  await box(chat(page)).click();
  await chat(page)
    .getByRole("button", { name: /^Model and effort: / })
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("main").click({ position: { x: 20, y: 20 } });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(minimise).toHaveCount(0);
});

test("the bar is on the Overview only; Chat with Rufi opens the chat from any page", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await expect(box(chat(page))).toBeVisible();
  for (const name of ["Help", "Settings"]) {
    await sidebar(page).getByRole("link", { name }).click();
    await expect(toolbar(page)).toHaveText(name);
    await expect(chat(page)).toHaveCount(0);
  }
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(page).toHaveURL(/\/people\/asha\/chat$/);
  await expect(box(page)).toBeFocused();
  await sidebar(page).getByRole("link", { name: "Overview" }).click();
  await expect(box(chat(page))).toBeVisible();
});

test("the panel's thin top bar: – makes it the bar again, ⤢ opens the chat page; the bar has no top bar", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await box(chat(page)).hover();
  await expect(chat(page).getByRole("heading")).toHaveCount(0);
  await expect(
    chat(page).getByRole("button", { name: "Open as page" }),
  ).toHaveCount(0);
  await box(chat(page)).click();
  const top = chat(page)
    .getByRole("heading", { name: "Chat with Rufi" })
    .locator("..");
  await expect(top.getByRole("button")).toHaveCount(2);
  await top.getByRole("button", { name: "Minimise" }).click();
  await expect(log(chat(page))).toHaveCount(0);
  await expect(box(chat(page))).toBeVisible();
  await box(chat(page)).click();
  await top.getByRole("button", { name: "Open as page" }).click();
  await expect(page).toHaveURL(/\/people\/asha\/chat$/);
});

test("while Rufi answers, the box and the bar say so, counting the seconds, with Stop where Send was; typing queues the next message", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  // The reply writes a part, then runs until it is stopped.
  await send(page, "partial");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:part");
  const answering = chat(page).getByText(/^Rufi is answering · \d+s$/);
  await expect(answering).toBeVisible();
  const seconds = async () =>
    Number(/(\d+)s$/.exec((await answering.textContent()) ?? "")?.[1]);
  const first = await seconds();
  await expect.poll(seconds, { timeout: 5_000 }).toBeGreaterThan(first);
  await expect(box(chat(page))).toHaveAttribute(
    "placeholder",
    "Type to queue your next message…",
  );
  await send(page, "Next one");
  await expect(
    chat(page)
      .getByRole("region", { name: "Waiting messages" })
      .getByRole("listitem"),
  ).toHaveText(["Next one"]);

  // The bar too, with Stop.
  await page.keyboard.press("Escape");
  await expect(log(chat(page))).toHaveCount(0);
  await expect(answering).toBeVisible();
  await expect(chat(page).getByRole("button", { name: "Send" })).toHaveCount(0);
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(answering).toHaveCount(0);
  await expect(chat(page).getByRole("button", { name: "Send" })).toBeVisible();
});

test("a small window opens the chat as a page", async ({ page, rufi }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await opened(page, rufi);
  await box(chat(page)).click();
  await expect(page).toHaveURL(/\/people\/asha\/chat$/);
  const at = page.url();
  await expect(toolbar(page)).toHaveText("Chat with Rufi");
  await box(page).fill("From a small window");
  await box(page).press("Enter");
  await expect(log(page).locator(".reply")).toHaveText(
    "ok:From a small window",
  );
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

  // The chat's own page shows it the same way.
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
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
