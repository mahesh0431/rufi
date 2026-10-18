// The moving dog at its own API, in Chromium: live() follows the person's
// reduced-motion setting also when it changes while the face is shown.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/** Each face's eyes as drawn now. */
const eyes = (page: Page) =>
  page
    .locator("svg")
    .evaluateAll((faces) =>
      faces.map(
        (face) => face.querySelector(".eye-shape")?.getAttribute("d") ?? "",
      ),
    );

test("live() settles when reduced motion is turned on while it runs, then moves again when it is turned off", async ({
  page,
}) => {
  const source = await readFile(new URL("rufi.js", import.meta.url), "utf8");
  await page.setContent("<!doctype html><body></body>");
  // A calm face that follows the pointer, and a reading one that moves by itself.
  await page.addScriptTag({
    type: "module",
    content: `${source}
      for (const expression of ["calm", "reading"]) {
        document.body.insertAdjacentHTML("beforeend", svg({ expression, size: 256 }));
        live(document.body.lastElementChild, { expression });
      }
      document.body.dataset.started = "";`,
  });
  await page.locator("body[data-started]").waitFor({ state: "attached" });
  const pointAt = async (x: number, y: number) => {
    await page.mouse.move(x, y);
    await page.waitForTimeout(400);
  };

  await pointAt(0, 0);
  const before = await eyes(page);
  await pointAt(600, 400);
  const moving = await eyes(page);
  expect(moving[0]).not.toBe(before[0]);
  expect(moving[1]).not.toBe(before[1]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(100);
  const settled = await eyes(page);
  await pointAt(0, 0);
  await page.waitForTimeout(1_500);
  expect(await eyes(page)).toEqual(settled);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(100);
  await pointAt(600, 400);
  const again = await eyes(page);
  expect(again[0]).not.toBe(settled[0]);
  expect(again[1]).not.toBe(settled[1]);
});
