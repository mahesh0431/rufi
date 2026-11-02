// Reminders on the Medicines page, on the real core: what a reminder shows
// is kept as picked; where it rings is offered once an iPhone is paired for
// the person, and kept too.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import {
  databasePath,
  openWritable,
} from "../../server/src/core/store/database.ts";
import { expect, test } from "./rufi.ts";

const medicines = async (page: Page, link: string) => {
  await page.goto(link);
  await page
    .getByRole("complementary")
    .getByRole("link", { name: /^Medicines/ })
    .click();
};
const menu = (page: Page) => page.getByRole("menu");
const choice = (page: Page, name: string) =>
  menu(page).getByRole("menuitemradio", { name: new RegExp(`^${name}`) });

test("keeps what a reminder shows as picked, and where it rings once an iPhone is paired", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await medicines(page, rufi.link());
  await page.getByRole("button", { name: "Reminders" }).click();
  await expect(choice(page, "How many")).toBeChecked();
  await expect(menu(page)).not.toContainText("Where reminders ring");
  await choice(page, "Which ones").click();
  await expect(choice(page, "Which ones")).toBeChecked();
  const { violations } = await new AxeBuilder({ page })
    .include("[role=menu]")
    .analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);

  // Asha pairs her iPhone, from Settings on the Mac; pairing sets her
  // reminders to ring on it.
  await rufi.stop();
  const store = openWritable(databasePath(rufi.home));
  try {
    store.db
      .exec(`INSERT INTO paired_apps (id, person_id, kind, name, key_sha256, paired_at)
      VALUES ('app-1', 'asha', 'iphone', 'Asha''s iPhone', 'k1', '2026-11-02T10:00:00Z');
      UPDATE reminder_settings SET ring = NULL WHERE person_id = 'asha';`);
  } finally {
    store.close();
  }
  await rufi.start();
  await medicines(page, rufi.link());
  await page.getByRole("button", { name: "Reminders" }).click();
  await expect(choice(page, "Which ones")).toBeChecked();
  await expect(choice(page, "iPhone")).toContainText("Asha's iPhone");
  await expect(choice(page, "iPhone")).toBeChecked();
  await choice(page, "Both").click();
  await page.reload();
  await page.getByRole("button", { name: "Reminders" }).click();
  await expect(choice(page, "Both")).toBeChecked();
});
