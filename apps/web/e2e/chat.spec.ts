// The chat on the real core: the bar, the panel and the page of the
// person's one chat; streaming, Stop, waiting messages, a send into the running reply, the model and
// drafts; older pages, day lines and the AI's memory (its lines, the
// meter, a thread that doesn't open); and what
// the AI's Markdown may and may not do. Each test checks that the strict CSP
// refused nothing the screens need.
import { AxeBuilder } from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { Page as ChatPage } from "@rufi/contracts";
import { Schema } from "effect";
import { transcripts } from "../../server/src/core/chat/transcript.ts";
import {
  databasePath,
  openWritable,
} from "../../server/src/core/store/database.ts";
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
/** The line that folds or opens a reply's Activity (the last one). */
const activity = (scope: Page | Locator) =>
  log(scope)
    .getByRole("button", { name: /^(Activity|Working) · / })
    .last();
/** The rows of the open Activity (the last one). */
const steps = (scope: Page | Locator) =>
  log(scope)
    .getByRole("list", { name: "Activity" })
    .last()
    .locator(":scope > li");
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

/**
 * Opens the panel from the bar when it is closed. It waits for the bar or the
 * box first: right after a load, neither has drawn yet.
 */
async function openChat(page: Page) {
  await expect(
    opener(chat(page))
      .or(box(chat(page)))
      .first(),
  ).toBeVisible();
  if (await opener(chat(page)).isVisible()) await opener(chat(page)).click();
}

/** Sends a message from the panel, opening it from the bar when it is closed. */
async function send(page: Page, text: string) {
  await openChat(page);
  await box(chat(page)).fill(text);
  await box(chat(page)).press("Enter");
  await expect(box(chat(page))).toHaveValue("");
}

test("the bar, the panel and Chat with Rufi are one chat: the reply streams in, the page has its own address, and an old conversation's address opens it", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await expect(opener(chat(page))).toHaveAccessibleName(
    "Open the chat: Ask or tell Rufi about Asha Fictional…",
  );
  // The reminder is under the panel, where answers are read.
  await expect(chat(page).getByText(/AI can make mistakes/)).toHaveCount(0);
  await expect(sidebar(page).getByRole("link")).toHaveText([
    "Chat with Rufi",
    "Overview",
    "Lab results7",
    "Measurements3",
    "Medicines2",
    "Visits",
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

  // Every text the reply shows, as it shows it: a read after "ok:" shows can
  // come after the last part on a busy machine.
  await page.evaluate(() => {
    const shown: string[] = [];
    Object.assign(globalThis, { shown });
    new MutationObserver(() => {
      const text =
        document.querySelector('[aria-label="Messages"] .reply')?.textContent ??
        "";
      if (text !== "" && shown.at(-1) !== text) shown.push(text);
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await box(chat(page)).fill("drip: my thyroid results");
  await box(chat(page)).press("Enter");
  const reply = log(chat(page)).locator(".reply");
  await expect(reply).toHaveText("ok:drip");
  // It streams: the first part showed before the rest had come.
  const shown = await page.evaluate(
    () => (globalThis as unknown as { shown: string[] }).shown,
  );
  expect(shown[0]).not.toBe("ok:drip");
  expect(shown.at(-1)).toBe("ok:drip");
  await expect(log(chat(page))).toContainText("drip: my thyroid results");
  // What the AI did is folded under the answer.
  await expect(activity(chat(page))).toHaveText(/^Activity · 2 steps · /);
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

/** Two of the person's messages wait, after a Stop. */
const WAITING = `
  UPDATE chats SET paused = 'stopped' WHERE id = 'c-asha';
  INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position, created_at, updated_at) VALUES
    ('q-2', 'asha', 'c-asha', 'person', 'Second', 1, '2026-10-10T09:00:00Z', '2026-10-10T09:00:00Z'),
    ('q-3', 'asha', 'c-asha', 'person', 'Third', 2, '2026-10-10T09:00:00Z', '2026-10-10T09:00:00Z');`;

test("waiting messages: edit, reorder, remove, and send one now", async ({
  page,
  rufi,
}) => {
  await rufi.family(WAITING);
  await rufi.start();
  await page.goto(rufi.link());
  await opener(chat(page)).click();
  const waiting = chat(page).getByRole("region", { name: "Waiting messages" });
  const items = waiting.getByRole("listitem");
  await expect(items).toHaveText(["Second", "Third"]);
  await accessible(page);

  // Each moves by its handle: dragged, or by keyboard (Space, the arrows,
  // Space; Escape puts it back and leaves the chat open). A dropped order
  // shows at once; the next move waits for its save, as a person's would.
  const handle = (n: number) =>
    items.nth(n).getByRole("button", { name: "Move", exact: true });
  const from = await handle(1).boundingBox();
  const above = await items.nth(0).boundingBox();
  if (from === null || above === null) throw new Error("not shown");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/queue"),
  );
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, above.y + above.height / 10, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(items).toHaveText(["Third", "Second"]);
  expect((await saved).ok()).toBe(true);

  /** How far a row is moved down to make room, in rows. */
  const shifted = (n: number) =>
    items
      .nth(n)
      .evaluate(
        (row) =>
          new DOMMatrix(getComputedStyle(row).transform).m42 /
          row.getBoundingClientRect().height,
      );
  const liftUp = async (n: number) => {
    await handle(n).focus();
    await page.keyboard.press("Space");
    await expect(handle(n)).toHaveAttribute("aria-pressed", "true");
    // The handle hears the arrows from just after it is picked up: until the
    // row above makes room, press again, as a person would. At the top, a
    // press does nothing. Room is the row's own shift, not its place: the
    // last drop still settling moves it down too.
    await expect(async () => {
      await page.keyboard.press("ArrowUp");
      await expect
        .poll(() => shifted(n - 1), { timeout: 1_000 })
        .toBeGreaterThan(0.5);
    }).toPass();
  };
  await liftUp(1);
  await page.keyboard.press("Space");
  await expect(items).toHaveText(["Second", "Third"]);
  await liftUp(1);
  await page.keyboard.press("Escape");
  await expect(handle(1)).not.toHaveAttribute("aria-pressed");
  await expect(items).toHaveText(["Second", "Third"]);
  await expect(
    chat(page).getByRole("button", { name: "Minimise" }),
  ).toBeVisible();

  await items.nth(0).getByRole("button", { name: "Edit" }).click();
  await waiting
    .getByRole("textbox", { name: "Waiting message" })
    .fill("Second, edited");
  await waiting.getByRole("button", { name: "Save" }).click();
  await expect(items).toHaveText(["Second, edited", "Third"]);
  await items.nth(1).getByRole("button", { name: "Remove" }).click();
  await expect(items).toHaveText(["Second, edited"]);

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
  await rufi.family(WAITING);
  await rufi.start();
  await page.goto(rufi.link());
  await opener(chat(page)).click();
  const waiting = chat(page).getByRole("region", { name: "Waiting messages" });
  const items = waiting.getByRole("listitem");
  await expect(items).toHaveText(["Second", "Third"]);

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
  await items.nth(1).getByRole("button", { name: "Remove" }).click();
  await read.promise;
  await items.first().getByRole("button", { name: "Edit" }).click();
  await waiting
    .getByRole("textbox", { name: "Waiting message" })
    .fill("Second, edited");
  await waiting.getByRole("button", { name: "Save" }).click();
  await expect(items).toHaveText(["Second, edited"]);

  const late = page.waitForResponse(
    (response) =>
      response.url().endsWith("/chat/queue") &&
      response.request().method() === "GET",
  );
  release.resolve(undefined);
  await (await late).finished();
  await expect(items).toHaveText(["Second, edited"]);
});

test("a message sent while a reply runs goes into that reply, as your message; Stop is beside Send", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "hang");
  await box(chat(page)).fill("Only the latest results, please");
  await expect(chat(page).getByRole("button", { name: "Stop" })).toBeVisible();
  await box(chat(page)).press("Enter");
  await expect(box(chat(page))).toHaveValue("");
  await expect(log(chat(page))).toContainText(
    "hangOnly the latest results, please",
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

test("the model and effort are chosen in the box, also in the bar, and kept for the chat; a new effort doesn't start a new thread; neither changes while a reply runs", async ({
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
  await expect(log(chat(page))).not.toContainText("New thread started");

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

test("the AI's memory: a compaction shows while it runs, then as done; the meter shows after a reply and after a reload; a thread that doesn't open holds the message with Try again and New thread", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: {
      compaction: true,
      compactionMs: 1_500,
      usage: { tokens: 38_000, window: 100_000 },
    },
  });
  const meter = chat(page).getByRole("button", { name: /^Context used/ });
  await openChat(page);
  // No meter before the AI reported anything.
  await expect(meter).toHaveCount(0);
  await send(page, "Hello");
  const quiet = (text: string) =>
    log(chat(page)).getByText(text, { exact: true });
  await expect(quiet("Compacting chat history…")).toBeVisible();
  await expect(quiet("Chat history compacted")).toBeVisible();
  await expect(quiet("Compacting chat history…")).toHaveCount(0);
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");
  await expect(log(chat(page))).not.toContainText("New thread started");

  await expect(meter).toHaveAccessibleName("Context used: 38%");
  await expect(meter).toHaveText("38%");
  await accessible(page);
  await page.reload();
  await openChat(page);
  await expect(meter).toHaveText("38%");

  // Rufi starts again, and the AI's thread doesn't open twice.
  await rufi.stop();
  await rufi.start({ scenario: { resumeFails: 2 } });
  await page.goto(rufi.link());
  await send(page, "Again");
  const waiting = chat(page).getByRole("region", { name: "Waiting messages" });
  const why =
    "Codex refused thread/resume: failed to read thread: a fictional read error";
  await expect(waiting).toContainText(why);
  await accessible(page);
  await waiting.getByRole("button", { name: "Try again" }).click();
  // Held again, with the error as it came.
  await expect(
    waiting.getByRole("button", { name: "New thread" }),
  ).toBeVisible();
  await expect(waiting).toContainText(why);
  // The thread opens for a later message: while its reply runs, New thread
  // doesn't show, so that reply keeps its thread.
  await send(page, "hang");
  const stop = chat(page).getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  await expect(
    waiting.getByRole("button", { name: "Try again" }),
  ).toBeVisible();
  await expect(waiting.getByRole("button", { name: "New thread" })).toHaveCount(
    0,
  );
  await stop.click();
  await waiting.getByRole("button", { name: "New thread" }).click();
  await expect(log(chat(page)).locator(".reply").last()).toHaveText("ok:Again");
  await expect(quiet("New thread started")).toHaveCount(1);
  await expect(
    quiet("New thread started").locator("xpath=following-sibling::*[1]"),
  ).toContainText("Again");
  await expect(waiting).toHaveCount(0);
  // The new thread hasn't said how full it is.
  await expect(meter).toHaveCount(0);
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
  await log(chat(page)).getByRole("button", { name: "Based on" }).click();
  await expect(page.getByRole("dialog", { name: "Based on" })).toContainText(
    "From your record, read now.",
  );
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
  await expect(opener(chat(page))).toHaveAccessibleName(
    "Open the chat: Half a thought",
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

test("a reply stopped by the usage limit shows the service's words alone", async ({
  page,
  rufi,
}) => {
  const resets = Math.floor(new Date(2026, 9, 5, 9, 30).getTime() / 1000);
  await opened(page, rufi, { scenario: { resetsAt: resets } });
  await send(page, "fail");
  await expect(log(chat(page))).toContainText(
    "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
  );
  // The service's words already say when: Rufi doesn't say it again.
  await expect(log(chat(page))).not.toContainText("It resets");
});

test("a reply stopped by the usage limit with no words from the service says when it resets", async ({
  page,
  rufi,
}) => {
  const resets = Math.floor(new Date(2026, 9, 5, 9, 30).getTime() / 1000);
  await opened(page, rufi, {
    scenario: { resetsAt: resets, failMessage: "" },
  });
  await send(page, "fail");
  await expect(log(chat(page))).toContainText(
    "This reply didn't finish. It resets at 09:30 on 5 Oct 2026.",
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
          tool: "save_changes",
          arguments: {
            changes: [
              {
                kind: "symptom",
                action: "add",
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

test("Activity is open and live while the AI works, its notes in full and its thinking in place; it folds when the answer comes, opens again, and a step opens to its whole output; a second tab shows the same", async ({
  page,
  rufi,
  context,
}) => {
  const output = Array.from(
    { length: 30 },
    (_, i) => `fictional line ${String(i + 1)}`,
  ).join("\n");
  const command = `/bin/zsh -lc 'cat ${"/fictional/folder".repeat(8)}/skills/analysis/SKILL.md'`;
  await opened(page, rufi, {
    scenario: {
      reasoning: [
        "**Reading the record**\n\nAsha asks about her results.",
        "**Comparing the reports**\n\nTwo reports, one lab.",
      ],
      reasoningMs: 1_500,
      ls: { command, output },
    },
  });
  await send(page, "drip commentary");
  // While it thinks: open, live, the latest heading in its place.
  await expect(activity(chat(page))).toHaveText("Activity · working · 1 step");
  await expect(activity(chat(page))).toHaveAttribute("aria-expanded", "true");
  await expect(steps(chat(page))).toHaveText([/^Comparing the reports/]);
  await accessible(page);
  // When the answer comes, it folds under it, with what took how long.
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:drip");
  await expect(activity(chat(page))).toHaveText(
    /^Activity · 4 steps · \d+(\.\d)?s$/,
  );
  await expect(activity(chat(page))).toHaveAttribute("aria-expanded", "false");
  await expect(
    log(chat(page)).getByRole("list", { name: "Activity" }),
  ).toHaveCount(0);

  /** Opens it: the rows as reported, in order, the note in full. */
  const open = async (scope: Page | Locator) => {
    await activity(scope).click();
    await expect(steps(scope)).toHaveText([
      /Comparing the reports/,
      "Checking your record first.",
      // The whole command: only the view cuts it.
      `done:${command} · exit 0`,
      /^done:teleport$/,
    ]);
  };
  await open(chat(page));
  // In the narrow panel, the long command is cut in its middle, on one
  // line: its file's name and exit code stay in view.
  const row = steps(chat(page)).nth(2).getByRole("button");
  const shown = await row.evaluate((button) => {
    const edge = button.getBoundingClientRect().right;
    const parts = [...button.querySelectorAll("span > span")].map((part) => ({
      text: part.textContent,
      whole: part.scrollWidth <= part.clientWidth,
      inside: part.getBoundingClientRect().right <= edge,
    }));
    return {
      cut: parts[0]?.whole === false,
      end: parts.slice(1),
      oneLine: button.getBoundingClientRect().height < 24,
    };
  });
  expect(shown).toEqual({
    cut: true,
    end: [
      {
        text: "older/skills/analysis/SKILL.md' · exit 0",
        whole: true,
        inside: true,
      },
    ],
    oneLine: true,
  });
  // The thinking opens to its whole summary.
  await steps(chat(page)).first().locator("summary").click();
  await expect(steps(chat(page)).first()).toContainText(
    "Two reports, one lab.",
  );
  // A step opens to everything the agent gave: 12 lines, then all of them.
  await steps(chat(page)).nth(2).getByRole("button").click();
  const opened1 = steps(chat(page)).nth(2);
  await expect(opened1.getByText(command, { exact: true })).toBeVisible();
  await expect(opened1).toContainText("Exit code: 0 · Took 0.0s");
  await expect(opened1).toContainText("fictional line 12");
  await expect(opened1).not.toContainText("fictional line 13");
  await opened1.getByRole("button", { name: "Show all 30 lines" }).click();
  await expect(opened1).toContainText("fictional line 30");
  await accessible(page);

  // Another tab, and a reload: the same rows, folded again.
  const other = await context.newPage();
  await other.goto(rufi.link());
  await opener(chat(other)).click();
  await expect(activity(chat(other))).toHaveText(/^Activity · 4 steps · /);
  await open(chat(other));
  await page.reload();
  await opener(chat(page)).click();
  await expect(activity(chat(page))).toHaveAttribute("aria-expanded", "false");
  await open(chat(page));
});

test("folded by hand while the AI works, Activity stays folded and shows the newest step; a reload shows the same live rows; Stop ends it stopped, with its time, also after a reload", async ({
  page,
  rufi,
}) => {
  let now = "2026-10-11T09:00:00.000Z";
  const summary = "**Checking the record**\n\nThe summary so far.";
  await opened(page, rufi, {
    now: () => now,
    scenario: { reasoning: [summary], reasoningMs: 30_000 },
  });
  await send(page, "Check my results");
  await expect(steps(chat(page))).toHaveText([/^Checking the record/]);
  await activity(chat(page)).click();
  await expect(activity(chat(page))).toHaveText(
    "Working · 1 stepChecking the record",
  );
  await expect(activity(chat(page))).toHaveAttribute("aria-expanded", "false");
  // A reload rebuilds it from what was stored: the same live row, open
  // again as the setting says.
  await page.reload();
  await opener(chat(page)).click();
  await expect(activity(chat(page))).toHaveText("Activity · working · 1 step");
  await expect(steps(chat(page))).toHaveText([/^Checking the record/]);
  now = "2026-10-11T09:00:08.000Z";
  await chat(page).getByRole("button", { name: "Stop", exact: true }).click();
  await expect
    .poll(async () =>
      (await chatPage(page)).entries
        .filter((entry) => entry.kind === "reasoning")
        .map((entry) => [entry.status, entry.text]),
    )
    .toEqual([["stopped", summary]]);
  await expect(activity(chat(page))).toHaveText(
    "Activity · 1 step · 1 stopped · 8.0s",
  );
  await page.reload();
  await opener(chat(page)).click();
  await expect(activity(chat(page))).toHaveText(
    "Activity · 1 step · 1 stopped · 8.0s",
  );
  await activity(chat(page)).click();
  await steps(chat(page)).first().locator("summary").click();
  await expect(steps(chat(page)).first()).toContainText("The summary so far.");
});

/** The real API, with this fictional tab's session proof. */
async function chatPage(page: Page) {
  const body = await page.evaluate(async () => {
    const response = await fetch("/api/people/asha/chat", {
      headers: { "x-rufi-proof": sessionStorage.getItem("rufi.proof") ?? "" },
    });
    if (!response.ok)
      throw new Error(`Chat read failed: ${String(response.status)}`);
    const body: unknown = await response.json();
    return body;
  });
  return Schema.decodeUnknownSync(ChatPage)(body);
}

test("thinking with no summary shows no line, while it runs or after", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: { reasoning: [], reasoningMs: 1_000, bare: true },
  });
  await send(page, "Hello");
  await expect(
    chat(page).getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");
  await expect(activity(chat(page))).toHaveCount(0);
});

test("after a restart, a reply a crash cut off shows its Activity folded, stopped, with no time it can't know", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  // What a crash left: a saved start and summary, with no end notification.
  const store = openWritable(databasePath(rufi.home));
  const saved = transcripts(store, () => "2026-10-11T09:00:00.000Z");
  const found = await saved.chat("asha");
  if (!found) throw new Error("The fictional chat is missing.");
  const summary = "**Checking the record**\n\nThe summary before the crash.";
  try {
    await saved.startTurn(found, "cut-turn", {
      id: "cut-thread",
      model: "gpt-6-astra",
    });
    await saved.appendReasoning(found, "cut-turn", "cut-thinking", "");
    await saved.appendReasoning(found, "cut-turn", "cut-thinking", summary);
  } finally {
    store.close();
  }
  await rufi.start({ now: () => "2026-10-11T10:00:00.000Z" });
  await page.goto(rufi.link());
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(activity(page)).toHaveText("Activity · 1 step · 1 stopped");
  await activity(page).click();
  await steps(page).first().locator("summary").click();
  await expect(steps(page).first()).toContainText(
    "The summary before the crash.",
  );
  await expect(log(page)).toContainText(
    "Rufi closed before the reply finished.",
  );
});

test("the Activity setting: show while working folds at the end; always show stays open; always hide shows one working line, with its spaces, then folds, and still opens by hand; it is kept after a restart", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    // Its last 40 characters, which always show, start just after a space.
    scenario: {
      reasoning: [
        "**Reading the saved result and the fictional lab report page**",
      ],
      reasoningMs: 1_500,
    },
  });
  const choose = async (name: string) => {
    await page.goto(`${new URL(page.url()).origin}/settings`);
    const group = page.getByRole("radiogroup", { name: "Activity" });
    await group.getByRole("radio", { name }).check();
    await expect(group.getByRole("radio", { name })).toBeChecked();
    await page.goto(`${new URL(page.url()).origin}/`);
  };
  // Show while working, the default: open, then folded.
  await send(page, "Hello");
  await expect(activity(chat(page))).toHaveAttribute("aria-expanded", "true");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:Hello");
  await expect(activity(chat(page))).toHaveAttribute("aria-expanded", "false");

  await choose("Always show");
  await send(page, "Again");
  await expect(log(chat(page)).locator(".reply").last()).toHaveText("ok:Again");
  await expect(activity(chat(page))).toHaveAttribute("aria-expanded", "true");
  await expect(steps(chat(page))).toHaveCount(3);

  await choose("Always hide");
  await send(page, "Once more");
  await expect(activity(chat(page))).toHaveText(
    "Working · 1 stepReading the saved result and the fictional lab report page",
  );
  // As drawn: the line is cut just after a space, which stays.
  await expect(activity(chat(page))).toHaveText(/the saved \s*result and/, {
    useInnerText: true,
  });
  await expect(log(chat(page)).locator(".reply").last()).toHaveText(
    "ok:Once more",
  );
  await expect(activity(chat(page))).toHaveText(/^Activity · 3 steps · /);
  await expect(activity(chat(page))).toHaveAttribute("aria-expanded", "false");
  await activity(chat(page)).click();
  await expect(steps(chat(page))).toHaveCount(3);
  await accessible(page);

  await rufi.stop();
  await rufi.start({
    scenario: { reasoning: ["**Reading the record**"], reasoningMs: 1_500 },
  });
  await page.goto(rufi.link());
  await page.goto(`${new URL(page.url()).origin}/settings`);
  await expect(
    page
      .getByRole("radiogroup", { name: "Activity" })
      .getByRole("radio", { name: "Always hide" }),
  ).toBeChecked();
});

test("an old chat shows as it was stored: its replies in order, and its steps folded under the last, with their stored words and no details", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  const store = openWritable(databasePath(rufi.home));
  const saved = transcripts(store, () => "2026-10-11T09:00:00.000Z");
  const found = await saved.chat("asha");
  if (!found) throw new Error("The fictional chat is missing.");
  try {
    // As Rufi stored a reply before notes were steps.
    await saved.startTurn(found, "old-turn", {
      id: "old-thread",
      model: "gpt-6-astra",
    });
    await saved.appendReply(
      found,
      "old-turn",
      "old-1",
      "I'll check first.",
      true,
    );
    await saved.setActivity(found, "old-turn", "old-2", {
      activity: "command",
      title: "Ran a command",
      detail: "ls",
      status: "done",
    });
    await saved.appendReply(
      found,
      "old-turn",
      "old-3",
      "Here is the answer.",
      true,
    );
    await saved.endTurn(found, "old-turn", { status: "completed" });
  } finally {
    store.close();
  }
  await rufi.start();
  await page.goto(rufi.link());
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(log(page).locator(".reply")).toHaveText([
    "I'll check first.",
    "Here is the answer.",
  ]);
  await activity(page).click();
  await expect(steps(page)).toHaveText(["done:Ran a command · ls"]);
  await steps(page).first().getByRole("button").click();
  await expect(steps(page).first()).toContainText(
    "Rufi kept no details for this step.",
  );
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
          tool: "save_changes",
          arguments: {
            changes: [
              {
                kind: "result",
                action: "remove",
                id: "res-a3",
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

test("Based on, beside Activity once a reply ended, opens the AI's own words and Esc closes it; small talk and a stopped reply have none", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: {
      calls: [
        {
          tool: "get_records",
          arguments: { kind: "result", from: "2026-08", to: "2026-08" },
        },
      ],
    },
  });
  const basedOn = log(chat(page)).getByRole("button", { name: "Based on" });
  // The fake answers with the message's own words: here, a rufi-basis block.
  await send(
    page,
    "Your last HbA1c\n\n```rufi-basis\nFrom your record, read now.\n```",
  );
  await expect(log(chat(page)).locator(".reply")).toHaveText(
    "ok:Your last HbA1c",
  );
  // On Activity's line.
  await expect(
    log(chat(page))
      .locator("[data-activity]")
      .getByRole("button", { name: "Based on" }),
  ).toHaveCount(1);
  await basedOn.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByRole("dialog", { name: "Based on" });
  await expect(
    popover.getByText("From your record, read now.", { exact: true }),
  ).toBeVisible();
  await accessible(page);
  // Esc closes the popover only, and the focus goes back to Based on.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(basedOn).toBeFocused();
  await expect(
    chat(page).getByRole("button", { name: "Minimise" }),
  ).toBeVisible();
  // Also from Close, reached with Tab.
  await page.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(popover.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(basedOn).toBeFocused();

  await send(page, "quiet thanks");
  await expect(log(chat(page)).locator(".reply").nth(1)).toHaveText(
    "ok:quiet thanks",
  );
  await expect(basedOn).toHaveCount(1);
  await send(page, "partial");
  await expect(log(chat(page)).locator(".reply").nth(2)).toHaveText("ok:part");
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(chat(page)).getByText("Stopped.")).toBeVisible();
  await expect(basedOn).toHaveCount(1);
});

test("a tool step shows the tool and its arguments as reported, and opens to its result", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: {
      calls: [
        {
          tool: "get_records",
          arguments: { kind: "result", from: "2026-08", to: "2026-08" },
        },
        {
          server: "elsewhere",
          tool: "lookup",
          arguments: { query: "headache ".repeat(40) },
        },
      ],
    },
  });
  await send(page, "My results");
  await expect(log(chat(page)).locator(".reply")).toHaveText("ok:My results");
  await activity(chat(page)).click();
  const own = steps(chat(page)).first();
  await expect(own).toHaveText(
    'done:rufi.get_records · {"kind":"result","from":"2026-08","to":"2026-08"}',
  );
  const other = steps(chat(page)).nth(1);
  await expect(other).toContainText('elsewhere.lookup · {"query":"headache');
  await own.getByRole("button").click();
  await expect(own.getByText("Arguments", { exact: true })).toBeVisible();
  await expect(own.getByText("Result", { exact: true })).toBeVisible();
  await expect(own).toContainText('"kind": "result"');
});

/**
 * Its bottom is at or above the top of the box beside it; with
 * toBeInViewport, the row is in view in the transcript, not under the box.
 */
async function aboveTheBox(row: Locator, scope: Page | Locator) {
  const [bottom, top] = await Promise.all([
    row.evaluate((element) => element.getBoundingClientRect().bottom),
    box(scope).evaluate(
      (field) => field.closest("form")?.getBoundingClientRect().top ?? 0,
    ),
  ]);
  return bottom <= top + 1;
}

test("the transcript follows a growing Activity to its newest row, above the box, on the chat's page in a tall window and in the panel; a scroll up stops it until the next reply; a scroll down past the end moves nothing else", async ({
  page,
  rufi,
}) => {
  const calls = (count: number) =>
    Array.from({ length: count }, () => ({
      tool: "get_records",
      arguments: { kind: "result" },
    }));
  // Each reply: its steps, then thinking for 2 s, then a note's first word,
  // and it works on until it is stopped.
  const message = "Check my results, think, cut commentary";
  await page.setViewportSize({ width: 1280, height: 1400 });
  await opened(page, rufi, {
    scenario: {
      callsByTurn: [calls(80), calls(80), calls(40)],
      reasoningMs: 2_000,
    },
  });
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  // Each step is a call to the core; with the whole suite running, a reply's
  // steps can take longer than the usual wait to all come in.
  const allIn = { timeout: 15_000 };
  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await box(page).fill(message);
  await box(page).press("Enter");
  await expect(steps(page)).toHaveCount(81, allIn);
  await expect(steps(page).last()).toBeInViewport();
  await expect.poll(() => aboveTheBox(steps(page).last(), page)).toBe(true);
  await expect(steps(page)).toHaveCount(82);
  await expect(steps(page).last()).toHaveText("Checking");
  await expect(steps(page).last()).toBeInViewport();
  await expect.poll(() => aboveTheBox(steps(page).last(), page)).toBe(true);
  await stop.click();

  // Its Activity opened again and read from further up, the next reply is
  // followed all the same.
  await activity(page).click();
  await log(page).hover();
  await page.mouse.wheel(0, -1_000);
  await expect(log(page).getByText(message).first()).toBeInViewport();
  await box(page).fill(message);
  await box(page).press("Enter");
  await expect(steps(page)).toHaveCount(81, allIn);
  await expect(steps(page).last()).toBeInViewport();
  await expect.poll(() => aboveTheBox(steps(page).last(), page)).toBe(true);
  // A scroll down past the transcript's end, as a trackpad does, moves
  // nothing else on the page: the box stays at the window's bottom.
  await log(page).hover();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 1_000);
  await expect
    .poll(() =>
      box(page).evaluate(
        (field) =>
          1400 - (field.closest("form")?.getBoundingClientRect().bottom ?? 0),
      ),
    )
    .toBeLessThan(80);
  await expect(steps(page).last()).toBeInViewport();
  // A scroll up while it works keeps what you read where it is.
  await page.mouse.wheel(0, -600);
  await expect(steps(page)).toHaveCount(82);
  await expect(steps(page).last()).not.toBeInViewport();
  await stop.click();

  // The panel follows the same way.
  await sidebar(page).getByRole("link", { name: "Overview" }).click();
  await send(page, message);
  await expect(steps(chat(page))).toHaveCount(42, allIn);
  await expect(steps(chat(page)).last()).toBeInViewport();
  await expect
    .poll(() => aboveTheBox(steps(chat(page)).last(), chat(page)))
    .toBe(true);
  await chat(page).getByRole("button", { name: "Stop", exact: true }).click();
});

test.describe("on the real Codex binary, with a local fake model", () => {
  test("a reply streams after Rufi's tool; a message sent meanwhile goes into the reply, which goes on; Stop", async ({
    page,
    rufi,
  }) => {
    await opened(page, rufi, { codex: "real" });
    // The model reads Rufi's overview first: a step says so, as reported.
    await send(page, "Read my overview");
    await expect(log(chat(page)).locator(".reply")).toHaveText(
      "ok:Read my overview",
    );
    await activity(chat(page)).click();
    await expect(
      log(chat(page)).getByRole("list", { name: "Activity" }),
    ).toContainText("rufi.get_overview");

    await send(page, "partial");
    await expect(log(chat(page))).toContainText("ok:part");
    // What the reply wrote stays, then your message, and the reply goes on
    // with it.
    await send(page, "Steered in");
    await expect(log(chat(page))).toContainText(
      "ok:partSteered inok:Steered in",
    );

    // Stop works on the reply that goes on.
    await send(page, "hang");
    await send(page, "Still hang");
    await expect(log(chat(page))).toContainText("hangStill hang");
    await chat(page).getByRole("button", { name: "Stop" }).click();
    await expect(log(chat(page))).toContainText("Stopped.");
  });
});
