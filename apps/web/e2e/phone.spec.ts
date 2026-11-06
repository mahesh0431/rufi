// The screens in Rufi's iPhone app (src/phone.ts): the app draws the tabs,
// bars and back, and opens every page. Here the page is marked as the app
// marks it before it loads (<html data-place="phone">), and a stand-in for
// the app keeps what the page tells it. The app itself is tested in
// apps/ios.
import type { Page } from "@playwright/test";
import { expect, SIGNED_OUT, test } from "./rufi.ts";

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

test("in the iPhone app, a page shows alone, a link goes to the app, and the app opens it", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  const told = () => page.evaluate(() => window.told);

  await page.goto(rufi.link());
  await expect
    .poll(told)
    .toContainEqual({ type: "page", path: "/", title: "Overview" });
  // The app's chrome, not the Mac's.
  await expect(page.getByRole("complementary")).toHaveCount(0);

  // A tap on another page tells the app, which pushes it; the page stays.
  await page
    .getByRole("main")
    .getByRole("link", { name: /Lab results/ })
    .first()
    .click();
  await expect.poll(told).toContainEqual({
    type: "go",
    path: "/people/asha/record/lab_result",
    chat: false,
  });
  await expect(page.getByRole("heading", { name: "Lab results" })).toHaveCount(
    0,
  );

  // The app opens it.
  await page.evaluate(() => {
    const app = window as unknown as { rufi: { open: (path: string) => void } };
    app.rufi.open("/people/asha/record/lab_result");
  });
  await expect.poll(told).toContainEqual({
    type: "page",
    path: "/people/asha/record/lab_result",
    title: "Lab results",
  });
  await expect(page.getByRole("main")).toContainText("HbA1c");
});

test("in the iPhone app, a reading page has the chat bar: a tap opens the chat over the page, and Open as page asks the app for the chat", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  const told = () => page.evaluate(() => window.told);
  await page.goto(rufi.link());
  // The app's own parts take the page's theme.
  await expect
    .poll(told)
    .toContainEqual(expect.objectContaining({ type: "theme" }));

  // A page opened on top says its own name.
  await page.evaluate(() => {
    const app = window as unknown as { rufi: { open: (path: string) => void } };
    app.rufi.open("/people/asha/tests/tst-hba1c");
  });
  await expect.poll(told).toContainEqual({
    type: "page",
    path: "/people/asha/tests/tst-hba1c",
    title: "HbA1c",
  });

  // The bar keeps its width for the words; the full box has the model.
  const model = page.getByRole("button", { name: /^Model and effort/ });
  await expect(
    page.getByRole("button", { name: /^Open the chat/ }),
  ).toBeVisible();
  await expect(model).toHaveCount(0);
  await page.getByRole("button", { name: /^Open the chat/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Message to Rufi" }),
  ).toBeVisible();
  await expect(model).toBeVisible();
  await expect(page.getByRole("heading", { name: "HbA1c" })).toBeVisible();
  await page.getByRole("button", { name: "Open as page" }).click();
  await expect
    .poll(told)
    .toContainEqual({ type: "go", path: "/people/asha/chat", chat: false });
});

test("in the iPhone app, a link in the chat over a page opens on top, and Back opens the chat again", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  const told = () => page.evaluate(() => window.told);
  const open = (path: string, chat = false) =>
    page.evaluate(
      ([path, chat]) => {
        const app = window as unknown as {
          rufi: { open: (path: string, chat: boolean) => void };
        };
        app.rufi.open(path, chat);
      },
      [path, chat] as const,
    );
  await page.goto(rufi.link());
  await open("/people/asha/record/medicine_use");
  await page.getByRole("button", { name: /^Open the chat/ }).click();
  const box = page.getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("See [your Metformin](rufi:/record/medicine_use?open=med-1)");
  await page.getByRole("button", { name: "Send" }).click();

  // A row of the page under the chat: the app opens it on top.
  await page.getByRole("link", { name: "your Metformin" }).click();
  await expect.poll(told).toContainEqual({
    type: "go",
    path: "/people/asha/record/medicine_use?open=med-1",
    chat: true,
  });
  await open("/people/asha/record/medicine_use?open=med-1");
  await expect(box).toBeHidden();

  // Back: the page under it, with its chat open again.
  await open("/people/asha/record/medicine_use", true);
  await expect(box).toBeVisible();
  await expect(
    page.getByRole("link", { name: "your Metformin" }),
  ).toBeVisible();
});

test("in the iPhone app, signed out on the Mac, the chat says to sign in there and keeps the words", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  rufi.codex = SIGNED_OUT;
  await rufi.start();
  await asPhone(page);
  await page.goto(rufi.link());
  await page.evaluate(() => {
    const app = window as unknown as { rufi: { open: (path: string) => void } };
    app.rufi.open("/people/asha/chat");
  });
  const box = page.getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("How is my HbA1c?");
  await box.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "You're signed out. Sign in with ChatGPT to chat.Sign in on your Mac.",
  );
  await expect(box).toHaveValue("How is my HbA1c?");
  // No way into the Mac's sign-in, which a phone can't open.
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
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

test("in the iPhone app, Scan asks the app for its camera, and the pages it adds come back as a chip, even after another tab", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await asPhone(page);
  await page.goto(rufi.link());
  const open = (path: string) =>
    page.evaluate((path) => {
      const app = window as unknown as {
        rufi: { open: (path: string) => void };
      };
      app.rufi.open(path);
    }, path);
  await open("/people/asha/chat");
  const box = page.getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("What does this report say?");
  await page.getByRole("button", { name: "Scan a document" }).click();
  await expect
    .poll(() => page.evaluate(() => window.told))
    .toContainEqual({ type: "scan" });

  // While the app uploads the pages, the person goes to Medicines; then
  // the door's answer comes back.
  await open("/people/asha/record/medicine_use");
  await expect(box).toHaveCount(0);
  await page.evaluate(() => {
    const app = window as unknown as {
      rufi: { added: (answer: unknown) => void };
    };
    app.rufi.added({ added: ["doc-asha-aug"], already: [] });
  });

  await open("/people/asha/chat");
  await expect(
    page
      .getByRole("list", { name: "Added to this message" })
      .getByRole("listitem"),
  ).toHaveText(["Sunrise Labs August.pdf"]);
  await expect(box).toHaveValue("What does this report say?");
});

test.describe("on a phone's screen, with touch", () => {
  test.use({ viewport: { width: 402, height: 874 }, hasTouch: true });

  test("in the iPhone app, at a large Text Size, Send stays in reach after a reply shows how much context it used", async ({
    page,
    rufi,
  }) => {
    await rufi.family();
    await rufi.start({
      scenario: { usage: { tokens: 38_000, window: 100_000 } },
    });
    await asPhone(page);
    await page.goto(rufi.link());
    await page.evaluate(() => {
      const app = window as unknown as {
        rufi: { open: (path: string) => void };
      };
      app.rufi.open("/people/asha/chat");
    });
    const box = page.getByRole("textbox", { name: "Message to Rufi" });
    const send = page.getByRole("button", { name: "Send" });
    await box.fill("How is my HbA1c?");
    await send.click();
    await expect(page.getByText("ok:How is my HbA1c?")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Context used: 38%" }),
    ).toBeVisible();

    // The iPhone's Text Size at Accessibility Large, as the app sends it.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--ios-body", "33px");
    });
    await box.fill("And my CRP?");
    await expect(send).toBeInViewport();
    await send.click();
    await expect(page.getByText("ok:And my CRP?")).toBeVisible();
  });
});
