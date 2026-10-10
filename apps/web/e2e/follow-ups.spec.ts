// Follow-ups on the real core: an idle page reads again by itself each
// minute and when its window comes back to the front, so it crosses
// midnight; a row shows the record it is about, which opens on its kind's
// page; Needs you opens a follow-up in place. The core's clock is set.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "./rufi.ts";

test("an idle Follow-ups page shows the new day within a minute", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    "INSERT INTO follow_ups (id, person_id, title, due) VALUES ('f-lipids', 'asha', 'Fasting lipid panel', '2026-12-03');",
  );
  let now = new Date(2026, 11, 2, 23, 59);
  await rufi.start({ now: () => now.toISOString() });
  await page.clock.install({ time: now });
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: /^Follow-ups/ })
    .click();
  const comingUp = page.getByRole("region", { name: /^Coming up/ });
  await expect(comingUp).toContainText("Fasting lipid panel");
  await expect(comingUp).toContainText("Due tomorrow");
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);

  // A minute on the page's clock, with the core's past midnight before it
  // ends. The stream pings every 15 s of real time and counts as stopped
  // after 45 s of silence on the page's clock: a real ping comes in the
  // middle, so the page reads again by its own timer, not by a reconnect.
  // fastForward fires each due timer once; runFor would play every chain
  // of timers (read deadlines, retries) faster than the core can answer.
  await page.clock.fastForward(25_000);
  await page.waitForTimeout(16_000);
  now = new Date(2026, 11, 3, 0, 1);
  await page.clock.fastForward(20_000);

  const dueNow = page.getByRole("region", { name: /^Due now/ });
  await expect(dueNow).toContainText("Fasting lipid panel");
  await expect(dueNow).toContainText("Due today");
  await expect(comingUp).toHaveCount(0);
});

test("a window coming back to the front reads Follow-ups again, with the page visible all along", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    "INSERT INTO follow_ups (id, person_id, title, due) VALUES ('f-lipids', 'asha', 'Fasting lipid panel', '2026-12-03');",
  );
  let now = new Date(2026, 11, 2, 23, 59);
  await rufi.start({ now: () => now.toISOString() });
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: /^Follow-ups/ })
    .click();
  await expect(page.getByRole("region", { name: /^Coming up/ })).toContainText(
    "Fasting lipid panel",
  );

  now = new Date(2026, 11, 3, 0, 1);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.getByRole("region", { name: /^Due now/ })).toContainText(
    "Fasting lipid panel",
  );
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
});

test("a done follow-up shows the result it is about, which opens on Results", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    "INSERT INTO follow_ups (id, person_id, title, due, status, outcome, linked_kind, linked_id) VALUES ('f-hba1c', 'asha', 'Recheck HbA1c', '2026-08', 'done', 'Still high', 'result', 'res-a1');",
  );
  await rufi.start({ now: () => new Date(2026, 9, 11, 9).toISOString() });
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: /^Follow-ups/ })
    .click();
  const done = page.getByRole("region", { name: /^Done/ });
  await expect(done).toContainText("Outcome: Still high");
  await done.getByRole("button", { name: "Recheck HbA1c" }).click();
  // Also in the open row, with its own sources and history.
  await expect(done.getByText("History")).toBeVisible();

  await done.getByRole("link", { name: "HbA1c 6.8 % · 12 Aug 2026" }).click();

  await expect(page).toHaveURL(/\/people\/asha\/record\/result\?open=res-a1$/);
  const row = page.getByRole("button", { name: "HbA1c", exact: true });
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(row).toBeInViewport();
});

test("a follow-up about a result amended since says so, and opens the current one", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    "INSERT INTO follow_ups (id, person_id, title, due, linked_kind, linked_id) VALUES ('f-tsh', 'asha', 'Recheck TSH', '2026-12', 'result', 'res-a4');",
  );
  await rufi.start({ now: () => new Date(2026, 9, 11, 9).toISOString() });
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: /^Follow-ups/ })
    .click();

  await page
    .getByRole("link", {
      name: "TSH 2.1 mIU/L · 12 Aug 2026 · amended to 4.6 mIU/L",
    })
    .click();

  await expect(page).toHaveURL(/\/record\/result\?open=res-a5$/);
  const row = page.getByRole("button", { name: "TSH amended" });
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(row).toBeInViewport();
});

test("Needs you's Open opens that follow-up on Follow-ups, in view", async ({
  page,
  rufi,
}) => {
  const overdue = Array.from(
    { length: 15 },
    (_, n) =>
      `('f-${String(n)}', 'asha', 'Overdue thing ${String(n)}', '2026-0${String(1 + (n % 9))}')`,
  );
  await rufi.family(
    `INSERT INTO follow_ups (id, person_id, title, due) VALUES ${overdue.join(", ")}, ('f-scan', 'asha', 'Call the clinic about the scan', '2026-10-11T16:00');`,
  );
  await rufi.start({ now: () => new Date(2026, 9, 11, 14, 20).toISOString() });
  await page.clock.install({ time: new Date(2026, 9, 11, 14, 20) });
  await page.goto(rufi.link());
  const needsYou = page.getByRole("region", { name: "Needs you" });
  await expect(needsYou).toContainText(
    "Call the clinic about the scan · coming up, due today at 16:00",
  );

  await needsYou
    .getByRole("link", { name: "Open Call the clinic about the scan" })
    .click();

  const row = page.getByRole("button", {
    name: "Call the clinic about the scan",
  });
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(row).toBeInViewport();
});
