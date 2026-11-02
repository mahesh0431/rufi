// The dose log on the real core: Today's Taken, Skipped and Undo, a log
// whose answer was lost sent again under the same id, another window
// showing each log at once, and a medicine's Doses as the log's rows.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./rufi.ts";

const sidebar = (page: Page) => page.getByRole("complementary");

/** Noon on 2 Nov 2026: the core's clock, and each window's. */
const NOON = new Date(2026, 10, 2, 12);

/** Opens Rufi in `page` at noon, on the Medicines page, with Today. */
async function medicines(page: Page, link: string) {
  await page.clock.setFixedTime(NOON);
  await page.goto(link);
  await sidebar(page)
    .getByRole("link", { name: /^Medicines/ })
    .click();
  const today = page.getByRole("region", { name: /^Today/ });
  await expect(today).toBeVisible();
  return {
    today,
    dose: (time: string) =>
      today.getByRole("listitem").filter({ hasText: time }),
  };
}

test("logs a dose from Today, sends it again under the same id when its answer is lost, and undoes it; another window shows each at once", async ({
  page,
  context,
  rufi,
}) => {
  await rufi.family(
    `UPDATE medicine_uses SET times = '["08:00","21:00"]', remind = 1 WHERE id = 'med-a1'`,
  );
  await rufi.start({ now: () => NOON.toISOString() });
  const here = await medicines(page, rufi.link());
  const there = await medicines(await context.newPage(), rufi.link());
  const evening = here.dose("21:00");
  await expect(evening).toContainText("Metformin 500 mg");

  // The core stores the first log, but its answer never comes.
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/doses")) {
      sent.push((request.postDataJSON() as { id: string }).id);
    }
  });
  await page.route(
    "**/api/people/asha/doses",
    async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    },
    { times: 1 },
  );
  await evening.getByRole("button", { name: "Taken" }).click();
  await expect(evening).toContainText("Not sure it was logged");
  await expect(there.dose("21:00")).toContainText("Taken 12:00 · Mac");

  await evening.getByRole("button", { name: "Try again" }).click();
  await expect(evening).toContainText("Taken 12:00 · Mac");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  const { violations } = await new AxeBuilder({ page })
    .include("section[aria-labelledby='today-heading']")
    .analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);

  await evening.getByRole("button", { name: "Undo" }).click();
  for (const shown of [evening, there.dose("21:00")]) {
    await expect(shown.getByRole("button", { name: "Taken" })).toBeVisible();
    await expect(shown).not.toContainText("Taken 12:00");
  }
  await here.dose("08:00").getByRole("button", { name: "Skipped" }).click();
  await expect(there.dose("08:00")).toContainText("Skipped · Mac");

  // Metformin's Doses: each log as it came, the undo too.
  await page.getByRole("button", { name: "Metformin 500 mg" }).click();
  const doses = page.getByRole("region", { name: /^Doses/ });
  await expect(doses).toContainText(
    "Today08:00 skipped (Mac) · 21:00 taken 12:00 (Mac) · 21:00 undone (Mac)",
  );
});
