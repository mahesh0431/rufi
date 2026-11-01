// Your profile on the real core: your name opens it in Settings, a change
// saves only the field changed, and the history says where each change was
// made.
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
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

/** Your name in the sidebar: it opens Settings at Profile. */
async function openProfile(page: Page, name = "Asha Fictional") {
  await page.getByRole("complementary").getByRole("link", { name }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(
    settings.getByRole("tab", { name: "Profile", selected: true }),
  ).toBeVisible();
  return settings;
}

/** The profile's history, newest first. */
const historyOf = (settings: Locator) =>
  settings.getByRole("region", { name: "History" }).getByRole("listitem");

test("your name opens your profile in Settings; a change saves only that field, your name too, and the history says where each was made", async ({
  page,
  rufi,
}) => {
  await rufi.family(BLOOD_GROUP_IN_THE_CHAT);
  await rufi.start();
  await page.goto(rufi.link());
  const settings = await openProfile(page);
  await expect(settings.getByLabel("Blood group")).toHaveValue("O+");
  await expect(settings.getByLabel("Year")).toHaveValue("1990");
  const history = historyOf(settings);
  await expect(history).toHaveText([
    /Blood group Not set → O\+ · in the chat$/,
  ]);
  await accessible(page);

  // Only the blood group changes. A refused save keeps the choice and
  // Retry, also after a look at another group, and keeps Settings open at it.
  await page.route("**/api/people/asha/profile", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "Rufi couldn't save." } })
      : route.continue(),
  );
  await settings.getByLabel("Blood group").selectOption("B+");
  const retry = settings.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await settings.getByRole("tab", { name: "Appearance" }).click();
  await page.keyboard.press("Escape");
  await expect(settings.getByRole("tab", { name: "Profile" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(settings.getByLabel("Blood group")).toHaveValue("B+");
  await page.unroute("**/api/people/asha/profile");
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(settings.getByLabel("Blood group")).toHaveValue("B+");
  // A height typed and closed with Esc, still in the field, is saved.
  await settings.getByLabel("Height", { exact: true }).fill("162");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await openProfile(page);
  await expect(settings.getByLabel("Height", { exact: true })).toHaveValue(
    "162",
  );
  await expect(history).toHaveText([
    /Height Not set → 162 cm · in Settings$/,
    /Blood group O\+ → B\+ · in Settings$/,
    /Blood group Not set → O\+ · in the chat$/,
  ]);

  // The name too: never left empty, and the sidebar shows the new one.
  const name = settings.getByLabel("Name", { exact: true });
  await name.fill("");
  await name.blur();
  await expect(
    settings.getByText("Give a name: it can't be empty."),
  ).toBeVisible();
  await expect(name).toHaveValue("");
  // Put back as it was: nothing is saved.
  await name.fill("Asha Fictional");
  await name.blur();
  await expect(history).toHaveCount(3);
  await name.fill("Asha F.");
  await name.blur();
  await expect(history.first()).toHaveText(
    /Name Asha Fictional → Asha F\. · in Settings$/,
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("complementary").getByRole("link", { name: "Asha F." }),
  ).toBeVisible();
});

test("a field you only pass through takes a change made elsewhere and saves nothing over it", async ({
  page,
  context,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.goto(rufi.link());
  const settings = await openProfile(page);
  const height = settings.getByLabel("Height", { exact: true });
  await height.fill("162");
  await height.blur();

  // In another tab, Settings corrects the height and the birth date.
  const other = await context.newPage();
  await other.goto(rufi.link());
  const elsewhere = await openProfile(other);
  await elsewhere.getByLabel("Height", { exact: true }).fill("163");
  await elsewhere.getByLabel("Year").fill("1991");
  await elsewhere.getByLabel("Blood group").focus();
  await expect(historyOf(elsewhere)).toHaveCount(3);

  // This tab shows them; passing through its fields saves nothing.
  await expect(height).toHaveValue("163");
  await expect(settings.getByLabel("Year")).toHaveValue("1991");
  await height.focus();
  await settings.getByLabel("Year").focus();
  await settings.getByLabel("Blood group").focus();
  await other.reload();
  await expect(elsewhere.getByLabel("Height", { exact: true })).toHaveValue(
    "163",
  );
  await expect(elsewhere.getByLabel("Year")).toHaveValue("1991");
  await expect(historyOf(elsewhere)).toHaveCount(3);
});

test("an entry or choice that isn't saved stays, with what to do, and Settings closes once it is saved", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.goto(rufi.link());
  const settings = await openProfile(page);
  const height = settings.getByLabel("Height", { exact: true });

  // Not a number: nothing is sent, and Settings stays open with the entry.
  await height.fill("tall");
  await page.keyboard.press("Escape");
  await expect(height).toHaveValue("tall");
  await expect(
    settings.getByText("Give your height as a number."),
  ).toBeVisible();

  // The core refuses the save: the entry and the reason stay.
  await page.route("**/api/people/asha/profile", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "Rufi couldn't save." } })
      : route.continue(),
  );
  await height.fill("162");
  await page.keyboard.press("Escape");
  await expect(settings.getByRole("alert")).toBeVisible();
  await expect(height).toHaveValue("162");
  // A choice refused stays chosen too.
  await settings.getByLabel("Blood group").selectOption("B+");
  await expect(settings.getByLabel("Blood group")).toHaveValue("B+");

  // Once the core takes them, closing saves them and closes.
  await page.unroute("**/api/people/asha/profile");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await openProfile(page);
  await expect(height).toHaveValue("162");
  await expect(settings.getByLabel("Blood group")).toHaveValue("B+");
});
