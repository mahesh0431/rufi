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

test("keeps a log whose send got no answer through another page and a reload, and Try again sends it as it was made", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    `UPDATE medicine_uses SET times = '["08:00","21:00"]', remind = 1 WHERE id = 'med-a1'`,
  );
  await rufi.start({ now: () => NOON.toISOString() });
  const sent: { id: string; loggedAt: string }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/doses")) {
      sent.push(request.postDataJSON() as { id: string; loggedAt: string });
    }
  });
  // The send never reaches the core.
  await page.route(
    "**/api/people/asha/doses",
    (route) => route.abort("connectionreset"),
    { times: 1 },
  );
  const here = await medicines(page, rufi.link());
  await here.dose("21:00").getByRole("button", { name: "Taken" }).click();
  await expect(here.dose("21:00")).toContainText("Not sure it was logged");

  // A minute later, after Overview and back, then a reload.
  await page.clock.setFixedTime(new Date(NOON.getTime() + 60_000));
  await sidebar(page).getByRole("link", { name: "Overview" }).click();
  await sidebar(page)
    .getByRole("link", { name: /^Medicines/ })
    .click();
  await expect(here.dose("21:00")).toContainText("Not sure it was logged");
  await page.reload();
  await expect(here.dose("21:00")).toContainText("Not sure it was logged");

  await here.dose("21:00").getByRole("button", { name: "Try again" }).click();
  await expect(here.dose("21:00")).toContainText("Taken 12:00 · Mac");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  await page.getByRole("button", { name: "Metformin 500 mg" }).click();
  const doses = page.getByRole("region", { name: /^Doses/ });
  await expect(doses).toContainText("Today21:00 taken 12:00 (Mac)");
  await expect(doses).not.toContainText("12:01");
});

test("a dose told to Rufi AI with no time it was taken says only that it was taken", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    `UPDATE medicine_uses SET times = '["08:00","21:00"]', remind = 1 WHERE id = 'med-a1';
    INSERT INTO dose_log (id, person_id, medicine_use_id, dose_at, state, taken_at, logged_at, received_at, logged_by)
      VALUES ('agent-1/1/c-1', 'asha', 'med-a1', '2026-11-02T08:00', 'taken', NULL, '${new Date(2026, 10, 2, 10).toISOString()}', '${new Date(2026, 10, 2, 10).toISOString()}', 'rufi_ai');`,
  );
  await rufi.start({ now: () => NOON.toISOString() });
  const here = await medicines(page, rufi.link());
  await expect(here.dose("08:00")).toContainText("Taken · Rufi AI");
  await page.getByRole("button", { name: "Metformin 500 mg" }).click();
  await expect(page.getByRole("region", { name: /^Doses/ })).toContainText(
    "Today08:00 taken (told Rufi AI)",
  );
});

// On a touch screen, as on the iPhone; how it looks is in the screenshots.
test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("in a page 390 px wide, Taken on a dose is in view, a tap logs it, and the medicine's Doses show it", async ({
    page,
    rufi,
  }) => {
    await rufi.family(
      `UPDATE medicine_uses SET times = '["08:00","21:00"]', remind = 1, directions = '1-0-1 after food, with a full glass of water' WHERE id = 'med-a1'`,
    );
    await rufi.start({ now: () => NOON.toISOString() });
    // 390 px of page beside the 240 px sidebar: the phone's width.
    await page.setViewportSize({ width: 630, height: 844 });
    const here = await medicines(page, rufi.link());
    const evening = here.dose("21:00");
    const taken = evening.getByRole("button", { name: "Taken" });
    await expect(taken).toBeInViewport({ ratio: 1 });

    await taken.tap();
    await expect(evening).toContainText("Taken 12:00 · Mac");
    await page.getByRole("button", { name: "Metformin 500 mg" }).tap();
    await expect(page.getByRole("region", { name: /^Doses/ })).toContainText(
      "Today21:00 taken 12:00 (Mac)",
    );
  });
});
