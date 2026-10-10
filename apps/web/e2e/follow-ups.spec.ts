// Follow-ups on the real core: an idle page reads again by itself each
// minute, so it crosses midnight within a minute. The core's clock and the
// page's are both set; nothing else on the page changes.
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
  await expect(comingUp).toContainText("Due 3 Dec 2026");
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);

  // A minute on the page's clock, with the core's past midnight before it
  // ends. The stream pings every 15 s of real time and counts as stopped
  // after 45 s of silence on the page's clock: a real ping comes in the
  // middle, so the page reads again by its own timer, not by a reconnect.
  await page.clock.runFor(25_000);
  await page.waitForTimeout(16_000);
  now = new Date(2026, 11, 3, 0, 1);
  await page.clock.runFor(20_000);

  const dueNow = page.getByRole("region", { name: /^Due now/ });
  await expect(dueNow).toContainText("Fasting lipid panel");
  await expect(dueNow).toContainText("Due today");
  await expect(comingUp).toHaveCount(0);
});
