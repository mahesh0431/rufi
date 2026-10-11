// One pattern for every button: on each main screen, every button the page
// shows has a name and is at least 32 px each way. Choices (pressed
// toggles, radios) and rows that open (disclosures) are not commands, so
// they keep their own size.
import type { Page } from "@playwright/test";
import { expect, test } from "./rufi.ts";

const sidebar = (page: Page) => page.getByRole("complementary");
const chat = (page: Page) => page.getByRole("region", { name: "Chat" });

/** No command button the page shows now is nameless or under 32 px. */
async function wellMade(page: Page, screen: string) {
  const wrong: string[] = [];
  let seen = 0;
  for (const button of await page.getByRole("button").all()) {
    if (!(await button.isVisible())) continue;
    const choice = await button.evaluate(
      (element) =>
        element.hasAttribute("aria-pressed") ||
        element.hasAttribute("aria-expanded"),
    );
    if (choice) continue;
    seen += 1;
    const name =
      (await button.getAttribute("aria-label")) ??
      (await button.innerText()).trim();
    const box = await button.boundingBox();
    if (name === "") wrong.push("a button with no name");
    if (box === null || box.width < 32 || box.height < 32) {
      wrong.push(`${name}: ${String(box?.width)} × ${String(box?.height)}`);
    }
  }
  expect(seen, screen).toBeGreaterThan(0);
  expect(wrong, screen).toEqual([]);
}

test("every button on the main screens has a name and is at least 32 px", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    "INSERT INTO follow_ups (id, person_id, title, due) VALUES ('f-lipids', 'asha', 'Fasting lipid panel', '2099-12-03');",
  );
  await rufi.start();
  await page.goto(rufi.link());
  await expect(
    page.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();
  await wellMade(page, "Overview");

  await sidebar(page)
    .getByRole("link", { name: /^Lab results/ })
    .click();
  await expect(
    page.getByRole("button", { name: "CRP", exact: true }),
  ).toBeVisible();
  await wellMade(page, "Lab results");

  await sidebar(page)
    .getByRole("link", { name: /^Follow-ups/ })
    .click();
  await expect(
    page.getByRole("main").getByRole("button", { name: "Ask Rufi" }).first(),
  ).toBeVisible();
  await wellMade(page, "Follow-ups");

  await sidebar(page).getByRole("link", { name: "Documents" }).click();
  const first = page.getByRole("main").getByRole("table").getByRole("link");
  await expect(first.first()).toBeVisible();
  await wellMade(page, "Documents");

  await first.first().click();
  await expect(
    page.getByRole("button", { name: "View original" }),
  ).toBeVisible();
  await wellMade(page, "a document's page");

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // Cancel, or Close when saved results block the delete.
  const cancel = dialog.getByRole("button", { name: /^(Cancel|Close)$/ });
  await expect(cancel).toBeVisible();
  await wellMade(page, "the delete dialog");
  await cancel.click();

  await chat(page).getByRole("button", { name: "Open the chat" }).click();
  await expect(
    chat(page).getByRole("button", { name: "Minimise" }),
  ).toBeVisible();
  await wellMade(page, "the chat panel");
  await page.keyboard.press("Escape");

  await sidebar(page).getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: "Back up" })).toBeVisible();
  await wellMade(page, "Settings");

  await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message to Rufi" }),
  ).toBeVisible();
  await wellMade(page, "the chat page");
});
