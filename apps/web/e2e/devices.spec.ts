// Settings → Device data: what Rufi has from each device, and a shorter
// "Keep values" that deletes only once confirmed, all by keyboard.
import { expect, test } from "./rufi.ts";

const ago = (days: number) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${String(days)} days')`;

const value = (id: string, days: number) =>
  `('asha', 'apple_health', '${id}', 'src-asha', 'resting_heart_rate', 54, ${ago(days)}, ${ago(days)})`;

test("a shorter keep says what it deletes, and deletes only once confirmed", async ({ page, rufi }) => {
  await rufi.family(`
    INSERT INTO device_sources (id, person_id, system, name, created_at, last_batch_at)
      VALUES ('src-asha', 'asha', 'apple_health', 'Asha''s iPhone', ${ago(1)}, ${ago(1)});
    INSERT INTO device_values (person_id, system, external_id, source_id, type, value, start_at, end_at)
      VALUES ${value("v-old", 400)}, ${value("v-month", 40)}, ${value("v-new", 2)};
  `);
  await rufi.start();
  await page.goto(`${rufi.link()}`);
  await page.getByRole("complementary").getByRole("link", { name: "Settings" }).click();
  const section = page.getByRole("heading", { name: "Device data" }).locator("+ div");
  await expect(section).toContainText("Apple Health on Asha's iPhone · 3 values · last batch");

  const keep = section.getByRole("radiogroup", { name: "Keep values" });
  await keep.getByRole("radio", { name: "Forever" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(section).toContainText("This deletes 1 value measured before");
  await expect(keep.getByRole("radio", { name: "12 months" })).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(section.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(section.getByRole("button", { name: "Delete" })).toBeFocused();
  // Nothing has changed yet.
  await expect(section).toContainText("3 values");
  await page.keyboard.press("Enter");
  await expect(section).toContainText("Apple Health on Asha's iPhone · 2 values");
  await expect(section).not.toContainText("This deletes");
  await expect(keep.getByRole("radio", { name: "12 months" })).toBeChecked();
});
