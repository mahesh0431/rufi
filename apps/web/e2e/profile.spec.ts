// Your profile on the real core: your name opens it, Settings has the same
// form, a change saves only the field changed, and the history says where
// each change was made.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./rufi.ts";

/** Asha's profile as a save in the chat left it: her blood group O+. */
const row = (blood: string | null) =>
  JSON.stringify({
    id: "asha",
    person_id: "asha",
    birth_date: "1990-03",
    birth_date_words: "March 1990",
    sex_for_ranges: "female",
    blood_group: blood,
    height: null,
    height_unit: null,
    removed: 0,
  });
const BLOOD_GROUP_IN_THE_CHAT = `
  INSERT INTO operations (id, seq, person_id, chat_id, call_id, request, created_at)
    SELECT 'op-blood', COALESCE(MAX(seq), 0) + 1, 'asha', 'c-asha', 'call-blood', '{}', '2026-10-30T10:00:00.000Z' FROM operations;
  INSERT INTO record_changes (operation_id, seq, person_id, kind, record_id, action, before, after)
    VALUES ('op-blood', 1, 'asha', 'profile', 'asha', 'change', '${row(null)}', '${row("O+")}');
  UPDATE profiles SET blood_group = 'O+' WHERE id = 'asha';`;

/** No accessibility rule broken on what the page shows now. */
async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

/** The profile's value of a field, as its page shows it. */
const value = (page: Page, name: string) =>
  page
    .getByRole("main")
    .getByRole("term")
    .filter({ hasText: new RegExp(`^${name}$`) })
    .locator("xpath=following-sibling::dd");

test("your name opens your profile; a change in Settings or on the page saves only that field, your name too, and the history says where each was made", async ({
  page,
  rufi,
}) => {
  await rufi.family(BLOOD_GROUP_IN_THE_CHAT);
  await rufi.start();
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Asha Fictional" })
    .click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(value(page, "Birth date")).toHaveText(
    /^Mar 1990 · \d+ years old today$/,
  );
  await expect(value(page, "Blood group")).toHaveText("O+");
  await expect(value(page, "Height")).toHaveText("Not set");
  const history = page.getByRole("main").getByRole("listitem");
  await expect(history).toHaveText([
    /Blood group Not set → O\+ · in the chat$/,
  ]);
  await accessible(page);

  // In Settings, only the blood group changes.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Blood group").selectOption("B+");
  await expect(page.getByLabel("Blood group")).toHaveValue("B+");
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Asha Fictional" })
    .click();
  await expect(value(page, "Blood group")).toHaveText("B+");
  await expect(history).toHaveText([
    /Blood group O\+ → B\+ · in Settings$/,
    /Blood group Not set → O\+ · in the chat$/,
  ]);

  // On the page: a height, saved when you leave it.
  await page.getByRole("button", { name: "Edit" }).click();
  await accessible(page);
  await page.getByLabel("Height", { exact: true }).fill("162");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(value(page, "Height")).toHaveText("162 cm");
  await expect(history.first()).toHaveText(
    /Height Not set → 162 cm · on this page$/,
  );
  await expect(value(page, "Birth date")).toHaveText(/^Mar 1990/);

  // The name too: never left empty, and the sidebar shows the new one.
  await page.getByRole("button", { name: "Edit" }).click();
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("");
  await name.blur();
  await expect(page.getByText("Give a name: it can't be empty.")).toBeVisible();
  await expect(name).toHaveValue("");
  // Put back as it was: Done closes, and nothing is saved.
  await name.fill("Asha Fictional");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(value(page, "Name")).toHaveText("Asha Fictional");
  await expect(history).toHaveCount(3);
  await page.getByRole("button", { name: "Edit" }).click();
  await name.fill("Asha F.");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(value(page, "Name")).toHaveText("Asha F.");
  await expect(
    page.getByRole("complementary").getByRole("link", { name: "Asha F." }),
  ).toBeVisible();
  await expect(history.first()).toHaveText(
    /Name Asha Fictional → Asha F\. · on this page$/,
  );
});

test("a field you only pass through takes a change made elsewhere and saves nothing over it", async ({
  page,
  context,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Settings" }).click();
  const settingsHeight = page.getByLabel("Height", { exact: true });
  await settingsHeight.fill("162");
  await settingsHeight.blur();

  // In another tab, the profile page corrects the height and the birth date.
  const other = await context.newPage();
  await other.goto(rufi.link());
  await other
    .getByRole("complementary")
    .getByRole("link", { name: "Asha Fictional" })
    .click();
  await other.getByRole("button", { name: "Edit" }).click();
  await other.getByLabel("Height", { exact: true }).fill("163");
  await other.getByLabel("Year").fill("1991");
  await other.getByRole("button", { name: "Done" }).click();
  await expect(value(other, "Height")).toHaveText("163 cm");

  // Settings shows them; passing through its fields saves nothing.
  await expect(settingsHeight).toHaveValue("163");
  await expect(page.getByLabel("Year")).toHaveValue("1991");
  await settingsHeight.focus();
  await page.getByLabel("Year").focus();
  await page.getByLabel("Blood group").focus();
  await other.reload();
  await expect(value(other, "Height")).toHaveText("163 cm");
  await expect(value(other, "Birth date")).toHaveText(/^Mar 1991/);
  await expect(other.getByRole("main").getByRole("listitem")).toHaveCount(3);
});

test("an entry or choice that isn't saved stays, with what to do, and Done closes once it is saved", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Asha Fictional" })
    .click();
  await page.getByRole("button", { name: "Edit" }).click();
  const height = page.getByLabel("Height", { exact: true });

  // Not a number: nothing is sent, and the page stays open with the entry.
  await height.fill("tall");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(height).toHaveValue("tall");
  await expect(page.getByText("Give your height as a number.")).toBeVisible();

  // The core refuses the save: the entry and the reason stay.
  await page.route("**/api/people/asha/profile", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "Rufi couldn't save." } })
      : route.continue(),
  );
  await height.fill("162");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(height).toHaveValue("162");
  // A choice refused stays chosen too.
  await page.getByLabel("Blood group").selectOption("B+");
  await expect(page.getByLabel("Blood group")).toHaveValue("B+");

  // Once the core takes them, Done saves them and closes.
  await page.unroute("**/api/people/asha/profile");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(value(page, "Height")).toHaveText("162 cm");
  await expect(value(page, "Blood group")).toHaveText("B+");
});
