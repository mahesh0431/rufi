// The chat on the real core: the bar, the panel and the page of the
// person's one chat; streaming, Stop, waiting messages, Steer, the model and
// drafts; older pages, day lines and where the AI started afresh; and what
// the AI's Markdown may and may not do. Each test checks that the strict CSP
// refused nothing the screens need.
import { AxeBuilder } from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
/** The closed bar: a pill that opens the chat panel. */
const opener = (scope: Locator) =>
  scope.getByRole("button", { name: "Open the chat" });
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
  await expect(
    page.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();
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

/** Sends a message from the panel, opening it from the bar when it is closed. */
async function send(page: Page, text: string) {
  if (await opener(chat(page)).isVisible()) await opener(chat(page)).click();
  await box(chat(page)).fill(text);
  await box(chat(page)).press("Enter");
  await expect(box(chat(page))).toHaveValue("");
}

test("the bar, the panel and Chat with Rufi are one chat: the reply streams in, the page has its own address, and an old conversation's address opens it", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await expect(opener(chat(page))).toHaveAccessibleDescription(
    "Ask or tell Rufi about Asha Fictional…",
  );
  // The reminder is under the panel, where answers are read.
  await expect(chat(page).getByText(/AI can make mistakes/)).toHaveCount(0);
  await expect(sidebar(page).getByRole("link")).toHaveText([
    "Chat with Rufi",
    "Overview",
    "Lab results7",
    "Measurements3",
    "Medicines2",
    "Prescriptions",
    "Conditions",
    "Allergies",
    "Symptoms",
    "Care events",
    "Follow-ups",
    "Documents",
    "Help",
    "Settings",
  ]);
  await accessible(page);

  // The panel: the chat's name; before the first message, nothing more.
  await opener(chat(page)).click();
  await expect(
    chat(page).getByRole("heading", { name: "Chat with Rufi" }),
  ).toBeVisible();
  await expect(chat(page)).not.toContainText("go to OpenAI");
  await accessible(page);
  // Under the box, only the reminder: the plan is in Settings.
  await expect(chat(page).getByText(/AI can make mistakes/)).toHaveText(
    "AI can make mistakes. Check important health decisions with your doctor.",
  );

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

  // The panel's top bar: – makes it the bar again, which has none; ⤢ opens
  // the chat page.
  await chat(page).getByRole("button", { name: "Minimise" }).click();
  await expect(log(chat(page))).toHaveCount(0);
  await expect(
    chat(page).getByRole("button", { name: "Open as page" }),
  ).toHaveCount(0);
  await opener(chat(page)).click();
  await chat(page).getByRole("button", { name: "Open as page" }).click();
  await expect(page).toHaveURL(/\/people\/asha\/chat$/);

  // The bar is on the pages where you read your health, not Help or
  // Settings; Chat with Rufi opens the chat from any page, as a page of its
  // own.
  for (const name of [
    "Lab results",
    "Measurements",
    "Follow-ups",
    "Documents",
  ]) {
    await sidebar(page)
      .getByRole("link", { name: new RegExp(`^${name}`) })
      .click();
    await expect(toolbar(page)).toHaveText(name);
    await expect(opener(chat(page))).toBeVisible();
  }
  for (const name of ["Help", "Settings"]) {
    await sidebar(page).getByRole("link", { name }).click();
    await expect(toolbar(page)).toHaveText(name);
    await expect(chat(page)).toHaveCount(0);
  }
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(page).toHaveURL(/\/people\/asha\/chat$/);
  await expect(box(page)).toBeFocused();
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
  await sidebar(page).getByRole("link", { name: "Overview" }).click();
  await expect(opener(chat(page))).toBeVisible();
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

test("messages sent during a reply wait: edit, reorder, remove, and send one after a Stop", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "hang");
  // While Rufi answers, the box says so, with Stop where Send was, and
  // typing queues the next message.
  const answering = chat(page).getByText(/^Rufi is answering · \d+s$/);
  await expect(answering).toBeVisible();
  await expect(chat(page).getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(chat(page).getByRole("button", { name: "Send" })).toHaveCount(0);
  await expect(box(chat(page))).toHaveAttribute(
    "placeholder",
    "Type to queue your next message…",
  );

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
  await items.nth(0).getByRole("button", { name: "Remove" }).click();
  await expect(items).toHaveText(["Second, edited"]);

  // The bar says so too, with Stop. After a Stop they keep waiting, until
  // you send.
  await box(chat(page)).press("Escape");
  await expect(log(chat(page))).toHaveCount(0);
  await expect(answering).toBeVisible();
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(answering).toHaveCount(0);
  await expect(chat(page).getByRole("button", { name: "Send" })).toBeVisible();
  await opener(chat(page)).click();
  await expect(log(chat(page))).toContainText("Stopped.");
  await expect(waiting).toContainText(
    "Stopped · these go when you send a message",
  );
  await waiting.getByRole("button", { name: "Send now" }).click();
  await expect(log(chat(page)).locator(".reply").last()).toHaveText(
    "ok:Second, edited",
  );
  await expect(waiting).toHaveCount(0);
});

test("an older read of the queue never undoes a newer change", async ({
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
  await page.route("**/chat/queue", async (route) => {
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
      response.url().endsWith("/chat/queue") &&
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

test("signed out, the model's menu signs in", async ({ page, rufi }) => {
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
  await opener(chat(page)).click();
  await expect(
    chat(page).getByRole("heading", { name: "Chat with Rufi" }),
  ).toBeVisible();
  await chat(page)
    .getByRole("button", { name: /^Model and effort/ })
    .click();
  await expect(page.getByRole("menu")).not.toContainText("pnpm");
  await page.getByRole("menuitem", { name: "Sign in with ChatGPT" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(
    page.getByRole("button", { name: "Sign in with ChatGPT" }),
  ).toBeVisible();
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
  // whose top has nothing to choose. While the list of models is slow, the
  // button keeps the name's place empty: never "Model" or the model's id.
  const slow = Promise.withResolvers<undefined>();
  await page.route("**/api/models", async (route) => {
    await slow.promise;
    await route.continue();
  });
  await page.reload();
  await expect(
    chat(page).getByRole("button", { name: /^Model and effort/ }),
  ).toHaveText("High");
  slow.resolve(undefined);
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
  await opener(chat(page)).click();
  const text = "Questions for the visit on 14 Oct: is the TSH amended?";
  await expect(box(chat(page))).toBeEditable();
  const saved = kept(page, text);
  await box(chat(page)).pressSequentially(text);
  await saved;
  await expect(chat(page).getByRole("status")).toHaveCount(0);
  await page.reload();
  await opener(chat(page)).click();
  await expect(box(chat(page))).toHaveValue(text);

  const { port } = rufi.core;
  await rufi.stop();
  await rufi.start({ port });
  await page.goto(rufi.link());
  await opener(chat(page)).click();
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
  await opener(chat(page)).click();
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
  await opener(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("Start of question, and more");
});

test("a quick send whose answer was lost keeps its id through Help and reload: the AI gets it once", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await opener(chat(page)).click();
  await expect(box(chat(page))).toBeEditable();
  // Send before the 400 ms draft save, without depending on machine speed.
  const clockTime = Date.now();
  await page.clock.install({ time: clockTime });
  await page.clock.pauseAt(clockTime + 10_000);
  // The core takes the first send, but its answer never reaches the page.
  let lost = false;
  const ids: string[] = [];
  await page.route("**/messages", async (route) => {
    ids.push((route.request().postDataJSON() as { id: string }).id);
    if (lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort();
  });
  await box(chat(page)).fill("Questions for the visit");
  await box(chat(page)).press("Enter");
  await expect(chat(page).getByRole("alert")).toHaveText(
    "Rufi can't be reached.",
  );
  await expect(box(chat(page))).toHaveValue("Questions for the visit");
  await page.clock.resume();
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:Questions for the visit",
  );
  // Leaving the box must not autosave this accepted send as a fresh draft.
  await sidebar(page).getByRole("link", { name: "Help", exact: true }).click();
  await expect(toolbar(page)).toHaveText("Help");
  await page.reload();
  const draftRead = page.waitForResponse(
    (response) =>
      response.url().endsWith("/chat/draft") &&
      response.request().method() === "GET",
  );
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  expect(await (await draftRead).json()).toEqual({ text: "", refs: [] });
  await expect(box(page)).toHaveValue("Questions for the visit");
  await expect(log(page).locator(".reply")).toHaveCount(1);
  expect(ids).toHaveLength(1); // Reload never retries by itself.
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/messages") &&
      response.request().method() === "POST",
  );
  await box(page).press("Enter");
  await accepted;
  await expect(box(page)).toHaveValue("");
  expect(ids).toEqual([ids[0], ids[0]]);
  await expect(log(page).locator(".reply")).toHaveText(
    "ok:Questions for the visit",
  );
  await expect(
    log(page).getByText("Questions for the visit", { exact: true }),
  ).toHaveCount(1);
  await page.reload();
  await expect(box(page)).toHaveValue("");

  // Replacing or clearing the uncertain send makes a new draft, kept on reload.
  for (const [i, replacement] of ["", "A different question"].entries()) {
    await page.clock.pauseAt(clockTime + 20_000 * (i + 1));
    lost = false;
    await box(page).fill("Another question");
    await box(page).press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Rufi can't be reached.");
    const edited = replacement === "" ? undefined : kept(page, replacement);
    await box(page).fill(replacement);
    await page.clock.runFor(400);
    await edited;
    // The page's own timers run again after the reload.
    await page.clock.resume();
    await page.reload();
    await expect(box(page)).toHaveValue(replacement);
  }
});

test("when Rufi stops while it hands a message to the AI, the message is not sure, and is never sent again by itself", async ({
  page,
  rufi,
}) => {
  // Codex never answers the start of the reply; then Rufi stops.
  await opened(page, rufi, { scenario: { hang: ["turn/start"] } });
  await send(page, "Questions before my visit");
  const waiting = chat(page).getByRole("region", { name: "Waiting messages" });
  await expect(waiting).toContainText("Sending…");
  // Claiming a row precedes preparation: wait until Codex has the request.
  await expect
    .poll(async () => {
      const received = await readFile(
        join(rufi.home, "fake-codex.jsonl"),
        "utf8",
      ).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return "";
        throw error;
      });
      return received;
    })
    .toContain('"method":"turn/start"');
  await page.goto("about:blank");
  const { port } = rufi.core;
  await rufi.stop();
  await rufi.start({ port });
  await page.goto(rufi.link());
  await opener(chat(page)).click();
  await expect(waiting).toContainText(
    "Not sure this reached the AI. Check the chat before you send it again.",
  );
  await expect(
    waiting.getByRole("button", { name: "Send again" }),
  ).toBeVisible();
  await expect(box(chat(page))).toHaveValue("");
  await expect(log(chat(page))).toHaveCount(0);
  await accessible(page);
});

test("a Rufi event shows as Rufi's line; after a Stop its note waits and goes with your next message", async ({
  page,
  rufi,
}) => {
  await rufi.family(`
    UPDATE chats SET paused = 'stopped' WHERE id = 'c-asha';
    INSERT INTO transcript_entries (id, person_id, chat_id, seq, kind, text, details, revision, created_at, updated_at)
      VALUES ('e-1', 'asha', 'c-asha', 1, 'event', 'Lab report · 12 Aug · 42 results read · 1 to check', '{"kind":"test"}', 1, '2026-10-10T09:00:00Z', '2026-10-10T09:00:00Z');
    INSERT INTO chat_queue (id, person_id, chat_id, origin, text, event_id, position, held, created_at, updated_at)
      VALUES ('q-e1', 'asha', 'c-asha', 'rufi', 'A lab report was read; one value is unsure.', 'e-1', 1, 'paused', '2026-10-10T09:00:00Z', '2026-10-10T09:00:00Z');`);
  await rufi.start();
  await page.goto(rufi.link());
  await opener(chat(page)).click();
  await expect(log(chat(page))).toContainText(
    "RufiLab report · 12 Aug · 42 results read · 1 to check",
  );
  const waiting = chat(page).getByRole("region", { name: "Waiting messages" });
  await expect(waiting).toContainText(
    "Stopped · these go when you send a message",
  );
  await expect(waiting).toContainText(
    "Rufi's note: Lab report · 12 Aug · 42 results read · 1 to check",
  );
  await expect(waiting).toContainText("Goes to the AI with your next message.");
  await accessible(page);
  await send(page, "What's new?");
  await expect(log(chat(page)).locator(".reply").last()).toHaveText(
    "ok:What's new?",
  );
  await expect(waiting).toHaveCount(0);
});

test("a draft longer than Rufi takes says so, and isn't kept or sent", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await opener(chat(page)).click();
  await box(chat(page)).fill("x".repeat(10_001));
  await expect(chat(page).getByRole("alert")).toHaveText(
    "Too long to keep or send: at most 10,000 characters, and this is 10,001.",
  );
  await expect(chat(page).getByRole("button", { name: "Send" })).toBeDisabled();
  await page.reload();
  await opener(chat(page)).click();
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

test("two tabs: the reply streams in both; the last save wins", async ({
  context,
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "Hello");
  const other = await context.newPage();
  await other.goto((await runningLink(rufi.home)) ?? "");
  await opener(chat(other)).click();
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
  await opener(chat(page)).click();
  await expect(box(chat(page))).toHaveValue("Typed in the second tab");
  await box(chat(page)).press("Enter");
  await expect(log(chat(other)).locator(".reply").last()).toHaveText(
    "ok:Typed in the second tab",
  );
});

test("Markdown in a reply: tables and web links work; HTML, images and other links do nothing", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await opener(chat(page)).click();
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

test("⌘J opens the panel; Esc steps back and returns focus; another page closes it", async ({
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

  // Another page closes the panel: coming back shows the bar.
  await sidebar(page)
    .getByRole("link", { name: /^Lab results/ })
    .click();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(minimise).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(minimise).toHaveCount(0);
  await page.goForward();
  await expect(opener(chat(page))).toBeVisible();
  await expect(minimise).toHaveCount(0);

  // When what had the focus is gone, Esc puts it on the bar.
  await page.evaluate(() => {
    const gone = document.createElement("button");
    gone.id = "gone";
    document.body.append(gone);
    gone.focus();
  });
  await page.keyboard.press("ControlOrMeta+j");
  await expect(minimise).toBeVisible();
  await page.evaluate(() => document.getElementById("gone")?.remove());
  await page.keyboard.press("Escape");
  await expect(minimise).toHaveCount(0);
  await expect(opener(chat(page))).toBeFocused();
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
  await expect(opener(chat(page))).toHaveAccessibleDescription(
    "Half a thought",
  );
  await expect(log(chat(page))).toHaveCount(0);

  // With the menu open, one click outside closes both.
  await opener(chat(page)).click();
  await chat(page)
    .getByRole("button", { name: /^Model and effort: / })
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("main").click({ position: { x: 20, y: 20 } });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(minimise).toHaveCount(0);
});

test("a small window opens the chat as a page", async ({ page, rufi }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await opened(page, rufi);
  await opener(chat(page)).click();
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
  await opener(chat(page)).click();
  await shown(chat(page));

  // The chat's own page shows it the same way.
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(chat(page)).toHaveCount(0);
  await shown(page);
  await accessible(page);
});

test("while the AI thinks, a line shows its latest heading; after the reply it folds, and opens to the whole summary, also after a reload", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: {
      reasoning: [
        "**Reading the record**\n\nAsha asks about her results.",
        "**Comparing the reports**\n\nTwo reports, one lab.",
      ],
      reasoningMs: 1_500,
    },
  });
  await send(page, "How are my results?");
  const live = log(chat(page)).locator("p", { hasText: "Thinking…" });
  await expect(live).toHaveText("Thinking…Comparing the reports");
  await accessible(page);

  /** The folded line, closed; a click opens the summary, Markdown as shown. */
  const folded = async (scope: Page | Locator) => {
    const thought = log(scope).locator("details", { hasText: "Thought for" });
    await expect(thought.locator("summary")).toHaveText(/^Thought for \d+s$/);
    await expect(thought.locator(".thought")).toBeHidden();
    await thought.locator("summary").click();
    await expect(thought.locator(".thought strong")).toHaveText([
      "Reading the record",
      "Comparing the reports",
    ]);
    await expect(thought.locator(".thought")).toContainText(
      "Two reports, one lab.",
    );
    await expect(log(scope).getByText("Thinking…")).toHaveCount(0);
  };
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:How are my results?",
  );
  await folded(chat(page));
  await accessible(page);

  await page.reload();
  await opener(chat(page)).click();
  await folded(chat(page));
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(chat(page)).toHaveCount(0);
  await folded(page);
});

test("thinking with no summary shows while it runs, and nothing once it ends", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: { reasoning: [], reasoningMs: 1_000 },
  });
  await send(page, "Hello");
  await expect(
    log(chat(page)).locator("p", { hasText: "Thinking…" }),
  ).toHaveText("Thinking…");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");
  await expect(log(chat(page))).not.toContainText("Thinking…");
  await expect(log(chat(page))).not.toContainText("Thought");
});

test("a save made in another window while this one's connection was down shows on Overview once it connects again", async ({
  page,
  rufi,
  context,
}) => {
  // The connection can be dropped, as a sleeping Mac or a network change
  // drops it.
  await page.addInitScript(() => {
    const drops: AbortController[] = [];
    const fetched = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (!(typeof input === "string" && input.endsWith("/stream"))) {
        return fetched(input, init);
      }
      const drop = new AbortController();
      drops.push(drop);
      const signals = [drop.signal, init?.signal].filter((one) => !!one);
      return fetched(input, { ...init, signal: AbortSignal.any(signals) });
    };
    Object.assign(globalThis, {
      dropStream: () => {
        for (const drop of drops.splice(0)) drop.abort();
      },
    });
  });
  await opened(page, rufi, {
    scenario: {
      calls: [
        {
          namespace: "rufi",
          tool: "save_changes",
          arguments: {
            changes: [
              {
                kind: "result",
                action: "remove",
                id: "res-a3",
                source: "Remove the CRP result",
              },
            ],
          },
        },
      ],
    },
  });
  const results = (count: number) =>
    page
      .getByRole("main")
      .getByRole("link", { name: new RegExp(`^Lab results ${String(count)}`) });
  await expect(results(7)).toBeVisible();
  // The stream drops, and its reconnect waits until the other window saved.
  const down = Promise.withResolvers<undefined>();
  await page.route("**/chat/stream", async (route) => {
    await down.promise;
    await route.continue();
  });
  await page.evaluate(() => {
    (globalThis as unknown as { dropStream: () => void }).dropStream();
  });

  const other = await context.newPage();
  await other.goto(rufi.link());
  await opener(chat(other)).click();
  await box(chat(other)).fill("Remove the CRP result");
  await box(chat(other)).press("Enter");
  await expect(log(chat(other)).locator(".receipt")).toContainText("CRP");

  down.resolve(undefined);
  await expect(results(6)).toBeVisible();
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
    "Read your results in Aug 2026 · 6 records",
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
  await opener(chat(page)).click();
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
  const own = log(chat(page)).locator("p", {
    hasText: "Save to your health record",
  });
  await expect(own).toHaveText("done:Save to your health record");
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
