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
  await expect(
    page.getByRole("button", { name: /^Open the chat/ }),
  ).toHaveCount(0);

  // A tap on another page tells the app, which pushes it; the page stays.
  await page
    .getByRole("main")
    .getByRole("link", { name: /Lab results/ })
    .first()
    .click();
  await expect
    .poll(told)
    .toContainEqual({ type: "go", path: "/people/asha/record/lab_result" });
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
