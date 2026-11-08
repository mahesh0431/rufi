// The screens in Rufi's iPhone app (src/phone.ts): the app draws the
// sidebar, bars, back and the chat's box, and opens every page. Here the page is marked as the app
// marks it before it loads (<html data-place="phone">), and a stand-in for
// the app keeps what the page tells it. The app itself is tested in
// apps/ios.
import type { Page } from "@playwright/test";
import { expect, FIRST_TURN_MS, lastReply, SIGNED_OUT, test } from "./rufi.ts";

declare global {
  interface Window {
    /** What the page told the stand-in app. */
    told: unknown[];
    webkit?: {
      messageHandlers?: {
        rufi?: { postMessage: (message: unknown) => void };
      };
    };
  }
}

/**
 * The page as the app marks it before it loads, with a stand-in for the app
 * that keeps what the page tells it (`window.told`).
 */
async function asPhone(page: Page) {
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const answer = await route.fetch();
      const html = (await answer.text()).replace(
        "<html ",
        '<html data-place="phone" ',
      );
      await route.fulfill({ response: answer, body: html });
    },
  );
  await page.addInitScript(() => {
    window.told = [];
    window.webkit = {
      messageHandlers: {
        rufi: { postMessage: (message) => window.told.push(message) },
      },
    };
  });
}

/** The stand-in app: what the page told it, and what it asks of the page. */
function app(page: Page) {
  const told = () => page.evaluate(() => window.told);
  type Rufi = {
    open: (path: string, chat?: boolean) => void;
    box: (command: unknown) => void;
    added: (answer: unknown) => void;
    reconnect: () => void;
  };
  return {
    told,
    /** The box as the page last told it. */
    box: async () =>
      (await told())
        .filter(
          (m): m is { type: "box" } & Record<string, unknown> =>
            (m as { type?: string }).type === "box",
        )
        .at(-1),
    /** Every box message the page told. */
    boxes: async () =>
      (await told()).filter(
        (m) => (m as { type?: string }).type === "box",
      ) as Record<string, unknown>[],
    open: (path: string, chat = false) =>
      page.evaluate(
        ([path, chat]) => {
          (window as unknown as { rufi: Rufi }).rufi.open(path, chat);
        },
        [path, chat] as const,
      ),
    ask: (command: Record<string, unknown>) =>
      page.evaluate((command) => {
        (window as unknown as { rufi: Rufi }).rufi.box(command);
      }, command),
    added: (answer: unknown) =>
      page.evaluate((answer) => {
        (window as unknown as { rufi: Rufi }).rufi.added(answer);
      }, answer),
    reconnect: () =>
      page.evaluate(() => {
        (window as unknown as { rufi: Rufi }).rufi.reconnect();
      }),
  };
}

test("in the iPhone app, a page shows alone, a link goes to the app, and the app opens it", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  const phone = app(page);

  await page.goto(rufi.link());
  await expect
    .poll(phone.told)
    .toContainEqual({ type: "page", path: "/", title: "Overview", box: "bar" });
  // The app's chrome, not the Mac's.
  await expect(page.getByRole("complementary")).toHaveCount(0);

  // A tap on another page tells the app, which pushes it; the page stays.
  await page
    .getByRole("main")
    .getByRole("link", { name: /Lab results/ })
    .first()
    .click();
  await expect.poll(phone.told).toContainEqual({
    type: "go",
    path: "/people/asha/record/lab_result",
    chat: false,
  });
  await expect(page.getByRole("heading", { name: "Lab results" })).toHaveCount(
    0,
  );

  // The app opens it.
  await phone.open("/people/asha/record/lab_result");
  await expect.poll(phone.told).toContainEqual({
    type: "page",
    path: "/people/asha/record/lab_result",
    title: "Lab results",
    box: "bar",
  });
  await expect(page.getByRole("main")).toContainText("HbA1c");
});

test("in the iPhone app, the app draws the chat's box: on a reading page, its open shows the chat over the page, and Open as page asks the app for the chat", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  const phone = app(page);
  await page.goto(rufi.link());
  // The app's own parts take the page's theme.
  await expect
    .poll(phone.told)
    .toContainEqual(expect.objectContaining({ type: "theme" }));

  // A page opened on top says its own name.
  await phone.open("/people/asha/tests/tst-hba1c");
  await expect.poll(phone.told).toContainEqual({
    type: "page",
    path: "/people/asha/tests/tst-hba1c",
    title: "HbA1c",
    box: "bar",
  });
  // The page draws no box: the app does, from what the page tells it.
  await expect.poll(phone.box).toMatchObject({
    placeholder: "Ask or tell Rufi about Asha Fictional…",
    ready: true,
    button: "send",
    canSend: false,
    model: { id: "gpt-6-astra", name: "GPT-6-Astra" },
    panel: false,
  });
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText("AI can make mistakes")).toHaveCount(0);

  await phone.ask({ type: "open" });
  await expect(
    page.getByRole("heading", { name: "Chat with Rufi" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "HbA1c" })).toBeVisible();
  await expect.poll(phone.box).toMatchObject({ panel: true });
  await page.getByRole("button", { name: "Open as page" }).click();
  await expect
    .poll(phone.told)
    .toContainEqual({ type: "go", path: "/people/asha/chat", chat: false });
});

test("in the iPhone app, the app's box keeps the draft, sends, shows the context used and changes the model", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start({
    scenario: { usage: { tokens: 38_000, window: 100_000 } },
  });
  await asPhone(page);
  const phone = app(page);
  await page.goto(rufi.link());
  await phone.open("/people/asha/chat");
  await expect
    .poll(phone.told)
    .toContainEqual(expect.objectContaining({ type: "page", box: "page" }));

  // What the app typed is the draft; the page never says it back.
  const saved = page.waitForResponse(
    (answer) =>
      answer.url().endsWith("/draft") && answer.request().method() === "PUT",
  );
  await phone.ask({ type: "text", text: "Remember my iron" });
  await saved;
  expect(
    (await phone.boxes()).some((m) => m["text"] === "Remember my iron"),
  ).toBe(false);
  await expect.poll(phone.box).toMatchObject({ canSend: true });
  // Opened again, the page gives the app the draft.
  await page.reload();
  await phone.open("/people/asha/chat");
  const said = (text: string) => async () =>
    (await phone.boxes()).some((m) => m["text"] === text);
  await expect.poll(said("Remember my iron")).toBe(true);

  await phone.ask({ type: "send" });
  await expect(page.getByText("ok:Remember my iron")).toBeVisible();
  // The send cleared it: the page says so.
  await expect.poll(said("")).toBe(true);
  await expect.poll(phone.box).toMatchObject({
    meter: { used: 38 },
  });

  await phone.ask({ type: "model", id: "claude-opus-5-5" });
  await expect.poll(phone.box).toMatchObject({
    model: { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  });
});

test("in the iPhone app, the app's box stops a reply", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  const phone = app(page);
  await page.goto(rufi.link());
  await phone.open("/people/asha/chat");
  await expect.poll(phone.box).toMatchObject({ ready: true });
  // The reply writes a part, then runs until it is stopped.
  await phone.ask({ type: "text", text: "partial" });
  await phone.ask({ type: "send" });
  await expect.poll(() => lastReply(page)).toBe("ok:part");
  await expect.poll(phone.box).toMatchObject({ button: "stop", canSend: true });
  await phone.ask({ type: "stop" });
  await expect(page.getByText("Stopped.")).toBeVisible();
  await expect.poll(phone.box).toMatchObject({ button: "send" });
});

test("in the iPhone app, Ask Rufi on a page puts its chip in the app's box, which lights", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  const phone = app(page);
  await page.goto(rufi.link());
  await phone.open("/people/asha/record/medicine_use");
  await expect.poll(phone.box).toMatchObject({ asked: 0, chips: [] });
  await page
    .getByRole("listitem")
    .filter({ hasText: "Metformin" })
    .getByRole("button", { name: "Ask Rufi about this" })
    .click();
  await expect.poll(phone.box).toMatchObject({
    asked: 1,
    chips: [
      expect.objectContaining({
        kind: "record",
        label: expect.stringContaining("Metformin"),
      }),
    ],
  });
  // The app's ✕ takes it out.
  const chips = (await phone.box())?.["chips"] as { key: string }[] | undefined;
  await phone.ask({ type: "remove", key: chips?.[0]?.key });
  await expect.poll(phone.box).toMatchObject({ chips: [] });
});

test("in the iPhone app, a link in the chat over a page opens on top, and Back opens the chat again", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  const phone = app(page);
  await page.goto(rufi.link());
  await phone.open("/people/asha/record/medicine_use");
  await expect.poll(phone.box).toMatchObject({ ready: true });
  await phone.ask({ type: "open" });
  const panel = page.getByRole("heading", { name: "Chat with Rufi" });
  await expect(panel).toBeVisible();
  await expect.poll(phone.box).toMatchObject({ ready: true });
  await phone.ask({
    type: "text",
    text: "See [your Metformin](rufi:/record/medicine_use?open=med-1)",
  });
  await phone.ask({ type: "send" });

  // A row of the page under the chat: the app opens it on top.
  await page.getByRole("link", { name: "your Metformin" }).click();
  await expect.poll(phone.told).toContainEqual({
    type: "go",
    path: "/people/asha/record/medicine_use?open=med-1",
    chat: true,
  });
  await phone.open("/people/asha/record/medicine_use?open=med-1");
  await expect(panel).toBeHidden();

  // Back: the page under it, with its chat open again.
  await phone.open("/people/asha/record/medicine_use", true);
  await expect(panel).toBeVisible();
  await expect(
    page.getByRole("link", { name: "your Metformin" }),
  ).toBeVisible();
});

test("in the iPhone app, signed out on the Mac, the app's box says to sign in there and keeps the words", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  rufi.codex = SIGNED_OUT;
  await rufi.start();
  await asPhone(page);
  const phone = app(page);
  await page.goto(rufi.link());
  await phone.open("/people/asha/chat");
  await expect.poll(phone.box).toMatchObject({ ready: true });
  await phone.ask({ type: "text", text: "How is my HbA1c?" });
  await phone.ask({ type: "send" });
  await expect.poll(phone.box).toMatchObject({
    line: "You're signed out. Sign in with ChatGPT to chat. Sign in on your Mac.",
  });
  // The words stay: the page never cleared them.
  expect((await phone.boxes()).some((m) => m["text"] === "")).toBe(false);
});

test("in the iPhone app, a dose logged on the Mac tells the app to refresh its reminders", async ({
  page,
  context,
  rufi,
}) => {
  const noon = new Date(2026, 10, 2, 12);
  await rufi.family(
    `UPDATE medicine_uses SET times = '["08:00","21:00"]', remind = 1 WHERE id = 'med-a1'`,
  );
  await rufi.start({ now: () => noon.toISOString() });
  await asPhone(page);
  const told = () => page.evaluate(() => window.told);
  await page.goto(rufi.link());
  // Connected: whatever changed while it was away, the app refreshes.
  await expect.poll(told).toContainEqual({ type: "refresh" });
  await page.evaluate(() => {
    window.told = [];
  });

  const mac = await context.newPage();
  await mac.clock.setFixedTime(noon);
  await mac.goto(rufi.link());
  await mac
    .getByRole("complementary")
    .getByRole("link", { name: /^Medicines/ })
    .click();
  await mac
    .getByRole("region", { name: /^Today/ })
    .getByRole("listitem")
    .filter({ hasText: "21:00" })
    .getByRole("button", { name: "Taken" })
    .click();

  await expect.poll(told).toContainEqual({ type: "refresh" });
});

test("in the iPhone app, View original asks the app to show the document's file", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  await page.goto(rufi.link());
  await page.evaluate(() => {
    const app = window as unknown as { rufi: { open: (path: string) => void } };
    app.rufi.open("/people/asha/documents/doc-asha-aug");
  });
  await page.getByRole("button", { name: "View original" }).click();
  await expect
    .poll(() => page.evaluate(() => window.told))
    .toContainEqual({
      type: "original",
      documentId: "doc-asha-aug",
      files: [{ id: expect.any(String), name: "Sunrise Labs August.pdf" }],
    });
  // The app shows it; the page opens no viewer of its own.
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("in the iPhone app, a visit brief's View PDF asks the app to show the brief's PDF", async ({
  page,
  context,
  rufi,
}) => {
  await rufi.family();
  await rufi.start({
    scenario: {
      callsByTurn: [
        [
          {
            tool: "create_brief",
            arguments: {
              markdown: "## For the visit\n\n- Metformin 500 mg, twice a day",
              record_version: 0,
              cited: [{ kind: "medicine_use", id: "med-a1" }],
            },
          },
        ],
      ],
    },
  });
  // The brief, made in the chat on the Mac.
  const mac = await context.newPage();
  await mac.goto(rufi.link());
  const chat = mac.getByRole("region", { name: "Chat" });
  await chat.getByRole("button", { name: "Open the chat" }).click();
  const box = chat.getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("Make a brief for my visit on Friday");
  await box.press("Enter");
  await chat
    .getByRole("link", { name: /^Open Visit brief/ })
    .click({ timeout: FIRST_TURN_MS });
  await expect(mac).toHaveURL(/\/people\/asha\/briefs\/[^/]+$/);
  const brief = new URL(mac.url()).pathname;

  await asPhone(page);
  const phone = app(page);
  await page.goto(rufi.link());
  await phone.open(brief);
  await page.getByRole("button", { name: "View PDF" }).click();
  await expect.poll(phone.told).toContainEqual({
    type: "brief_pdf",
    briefId: brief.split("/").at(-1),
  });
  // The app shows it; the page opens no viewer of its own.
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("in the iPhone app, what the app adds from its box comes back as a chip, even when it lands on Help", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  const phone = app(page);
  await page.goto(rufi.link());
  await phone.open("/people/asha/chat");
  await expect.poll(phone.box).toMatchObject({ ready: true, closed: null });
  await phone.ask({ type: "text", text: "What does this report say?" });

  // While the app uploads the files, the person goes to Help, which has
  // no box; then the door's answer comes back.
  await phone.open("/help");
  await expect
    .poll(phone.told)
    .toContainEqual(
      expect.objectContaining({ type: "page", path: "/help", box: null }),
    );
  await phone.added({ added: ["doc-asha-aug"], already: [] });

  await phone.open("/people/asha/chat");
  await expect.poll(phone.box).toMatchObject({
    chips: [
      expect.objectContaining({
        kind: "document",
        label: "Sunrise Labs August.pdf",
      }),
    ],
  });
  expect((await phone.boxes()).some((m) => m["text"] === "")).toBe(false);
});

test("in the iPhone app, Rufi not running behind Tailscale tells the app it can't be reached, with no line on the page and no retries of its own, and the app's reconnect reads the page again", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.clock.install();
  await asPhone(page);
  const phone = app(page);
  await page.goto(rufi.link());
  await expect
    .poll(phone.told)
    .toContainEqual({ type: "page", path: "/", title: "Overview", box: "bar" });

  // Rufi stopped on the Mac: Tailscale answers 502, without Rufi's words.
  await page.route("**/api/**", (route) => route.fulfill({ status: 502 }));
  await phone.open("/people/asha/record/lab_result");
  await expect
    .poll(phone.told)
    .toContainEqual({ type: "connection", reachable: false });
  // The page shows only the dog resting: the app's line says the rest.
  await expect(page.getByRole("img", { name: "Rufi, resting" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText("Rufi can't be reached.")).toHaveCount(0);
  // The app retries: the page doesn't ask again by itself.
  const asked = page
    .waitForRequest("**/api/status", { timeout: 1_000 })
    .catch(() => undefined);
  await page.clock.fastForward(10_000);
  expect(await asked).toBeUndefined();

  // Back: the app tells the page, which reads again.
  await page.unroute("**/api/**");
  await page.evaluate(() => {
    window.told = [];
  });
  await phone.reconnect();
  await expect
    .poll(phone.told)
    .toContainEqual({ type: "connection", reachable: true });
  await expect(page.getByRole("main")).toContainText("HbA1c");
});
