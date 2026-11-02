// The screens in Rufi's iPhone app (src/phone.ts): the app draws the tabs,
// bars and back, and opens every page. Here the page is marked as the app
// marks it before it loads (<html data-place="phone">), and a stand-in for
// the app keeps what the page tells it. The app itself is tested in
// apps/ios.
import { expect, test } from "./rufi.ts";

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

test("in the iPhone app, a page shows alone, a link goes to the app, and the app opens it", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
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
