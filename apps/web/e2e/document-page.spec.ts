// A document's page on the real core, after a scripted reading
// (tests/fake-reader.ts): the items beside their page, "Unsure only", a fix
// that keeps the reader's value, a fix from a second tab refused with the
// value now, and "Save these in the chat" putting the words in the box.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { readPage, scriptedReader } from "../../server/tests/fake-reader.ts";
import { expect, test } from "./rufi.ts";

const REPORT = join(
  import.meta.dirname,
  "../../server/tests/fixtures/documents/sunrise-labs-august.pdf",
);

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

const PLATELETS = {
  test_name: "Platelet count",
  value_text: "2.1",
  unit: "lakh/µL",
  reference_range: "1.5-4.1",
  unsure: "the decimal point is faint",
};

test("checks a report against its pages: unsure only, a fix, a fix from another tab, then the chat", async ({
  page,
  rufi,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const reader = scriptedReader([
    async (turn) => {
      await turn.look(1);
      const first = readPage("13.2", { rows_seen: 2 });
      await turn.save(1, { ...first, items: [...first.items, PLATELETS] });
      await turn.look(2);
      const second = readPage("13.2", { rows_seen: 3 });
      await turn.save(2, {
        ...second,
        items: [...second.items, { ...second.items[0], column: "earlier" }],
      });
      return undefined;
    },
  ]);
  await rufi.family(
    `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
     DELETE FROM document_pages; DELETE FROM documents;`,
  );
  await rufi.start({ reader: reader.run });
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByLabel("Choose documents", { exact: true }).setInputFiles({
    name: "sunrise-labs-august.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(REPORT),
  });
  await expect(
    page.getByRole("cell", { name: /To check · 3 results/ }),
  ).toBeVisible({ timeout: 10_000 });

  // Items beside the page; a row shows its page.
  await page.getByRole("button", { name: "sunrise-labs-august.pdf" }).click();
  const items = page.getByRole("region", { name: "Items" });
  const shown = page.getByRole("region", { name: "Page" });
  // An earlier column's value is a row of its own, not a result.
  await expect(items).toContainText("3 results · 1 earlier · 1 unsure");
  await expect(items).toContainText(
    "Page 2 · read · 2 items · may be incomplete: the reader counted 3 rows and read 1",
  );
  await expect(items.getByRole("row", { name: /earlier/ })).toHaveCount(1);
  await expect(shown.getByRole("img", { name: "Page 1 of 2" })).toBeVisible();
  await items.getByRole("button", { name: "Haemoglobin" }).nth(1).click();
  await expect(shown.getByRole("img", { name: "Page 2 of 2" })).toBeVisible();
  await accessible(page);

  // Unsure only.
  await items.getByLabel("Unsure only (1)").check();
  await expect(items.getByRole("button", { name: "Haemoglobin" })).toHaveCount(
    0,
  );
  await expect(items).toContainText("the decimal point is faint");

  // A fix keeps the reader's value.
  await items.getByRole("button", { name: "Platelet count" }).click();
  await items.getByRole("button", { name: "Fix" }).click();
  const form = items.getByRole("form", { name: "Fix Platelet count" });
  await form.getByLabel("Value").fill("2.7");
  await form.getByRole("button", { name: "Save fix" }).click();
  await expect(form).toHaveCount(0);
  await expect(items).toContainText("2.7 lakh/µL");
  await expect(items).toContainText("The reader read: value 2.1");
  await expect(items).toContainText("fixed by you");

  // Another tab fixes it first, including a field this person didn't edit.
  await items.getByRole("button", { name: "Fix" }).click();
  await form.getByLabel("Value").fill("2.9");
  const documentPage = page.url();
  const other = await context.newPage();
  await other.goto(rufi.link());
  await other.goto(documentPage);
  const otherItems = other.getByRole("region", { name: "Items" });
  await otherItems.getByRole("button", { name: "Platelet count" }).click();
  await otherItems.getByRole("button", { name: "Fix" }).click();
  await other.getByLabel("Value").fill("2.8");
  await other.getByLabel("Range").fill("2.0-4.0");
  await other.getByRole("button", { name: "Save fix" }).click();
  await expect(otherItems).toContainText("2.8 lakh/µL");
  await other.close();

  await form.getByRole("button", { name: "Save fix" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "This result changed in another tab. Its value is now 2.8 lakh/µL. Your fix wasn't saved. Look at the page, then save your fix again or cancel.",
  );
  await expect(form.getByLabel("Value")).toHaveValue("2.9");
  await expect(form.getByLabel("Range")).toHaveValue("2.0-4.0");
  await accessible(page);

  // A later refusal replaces the stale notice and keeps the person's text.
  await form.getByLabel("Value").fill("");
  await form.getByRole("button", { name: "Save my fix over it" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "A result needs its test name and value.",
  );
  await expect(form.getByLabel("Value")).toHaveValue("");
  await form.getByLabel("Value").fill("2.9");
  const retry = page.waitForRequest(
    (request) => request.url().endsWith("/fix") && request.method() === "POST",
  );
  await form.getByRole("button", { name: "Save fix", exact: true }).click();
  expect(((await retry).postDataJSON() as { fields: unknown }).fields).toEqual({
    value_text: "2.9",
  });
  await expect(form).toHaveCount(0);
  await expect(items).toContainText("2.9 lakh/µL");
  await expect(
    items.getByRole("cell", { name: "2.0-4.0", exact: true }),
  ).toBeVisible();

  const chat = page.getByRole("region", { name: "Chat" });
  const box = chat.getByRole("textbox", { name: "Message to Rufi" });
  const minimise = chat.getByRole("button", { name: "Minimise" });
  const save = page.getByRole("button", { name: "Save these in the chat" });

  // In a short window too, the page's footer ends above the bar.
  await page.setViewportSize({ width: 1000, height: 560 });
  await expect(save).toBeInViewport();
  const button = await save.boundingBox();
  const bar = await chat.locator("form").boundingBox();
  expect((button?.y ?? 0) + (button?.height ?? 0)).toBeLessThan(bar?.y ?? 0);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Save these in the chat: after what the box holds, and the page stays;
  // the person sends.
  await box.click();
  await box.fill("What changed since March?");
  await page.keyboard.press("Escape");
  await save.click();
  expect(page.url()).toBe(documentPage);
  await expect(minimise).toHaveCount(0);
  await expect(
    chat.getByRole("status", { name: "Added to this message" }),
  ).toHaveText("sunrise-labs-august.pdf");
  await box.click();
  await expect(box).toHaveValue(
    "What changed since March?\n\nSave these 3 results.",
  );
  await expect(
    chat
      .getByRole("list", { name: "Added to this message" })
      .getByRole("listitem"),
  ).toHaveText(["sunrise-labs-august.pdf · Read"]);
  await accessible(page);

  // A lost send's answer blocks adding, including after a reload, and the
  // bar says why.
  const submitted: { id: string; text: string }[] = [];
  await page.route("**/messages", async (route) => {
    submitted.push(
      route.request().postDataJSON() as { id: string; text: string },
    );
    if (submitted.length > 1) return route.continue();
    await route.fetch();
    await route.abort();
  });
  await box.press("Enter");
  await expect(chat.getByRole("alert")).toHaveText("Rufi can't be reached.");
  await page.keyboard.press("Escape");
  const unresolved = page.getByRole("button", {
    name: "Retry the message in the chat first",
  });
  await expect(unresolved).toBeDisabled();
  await page.reload();
  await expect(unresolved).toBeDisabled();
  await items.getByRole("row").filter({ hasText: "Platelet count" }).hover();
  await items.getByRole("button", { name: "Ask Rufi" }).first().click();
  await expect(chat.getByRole("alert")).toHaveText(
    "Your last message may not have reached Rufi: send it again or change it first.",
  );
  expect(submitted).toHaveLength(1);
  // The core took it, so its reply runs: ⌘J opens the panel.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(box).toHaveValue(submitted[0]?.text ?? "");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  expect(submitted).toEqual([submitted[0], submitted[0]]);
  expect(page.url()).toBe(documentPage);
  await expect(
    page.getByRole("button", { name: "Save these in the chat" }),
  ).toBeEnabled();
});
