// Deleting a document on the real core, with the fictional family: a
// document with saved results is blocked, its preview lists them and Ask
// Rufi puts it in the chat; one whose results were removed goes, and an
// old message's chip of it says it was deleted. The strict CSP refuses
// nothing.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./rufi.ts";

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

// The CSP's refusals, collected in the page.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    const refused: string[] = [];
    Object.assign(globalThis, { refused });
    (globalThis as unknown as EventTarget).addEventListener(
      "securitypolicyviolation",
      (event) => {
        const { violatedDirective, blockedURI } = event as Event & {
          violatedDirective: string;
          blockedURI: string;
        };
        refused.push(`${violatedDirective} ${blockedURI}`);
      },
    );
  });
});
test.afterEach(async ({ page }) => {
  expect(
    await page.evaluate(
      () => (globalThis as unknown as { refused: string[] }).refused,
    ),
  ).toEqual([]);
});

/** Opens a document's page from the Documents page. */
async function openDocument(page: Page, name: string) {
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByRole("link", { name, exact: true }).click();
}

test("a document with saved results is blocked with Ask Rufi; one without goes, its old chip says deleted, and its open tab says so", async ({
  page,
  rufi,
  context,
}) => {
  const chip = JSON.stringify([
    {
      ref: { type: "document", id: "doc-asha-aug", version: 0 },
      label: "Sunrise Labs August.pdf",
      detail: "Lab report",
    },
  ]);
  await rufi.family(
    // The August report's results were removed in the chat before.
    "UPDATE results SET removed = 1 WHERE report_id = 'rep-asha-aug';",
    `INSERT INTO transcript_entries (id, person_id, chat_id, seq, kind, text, refs, revision, created_at, updated_at)
       VALUES ('m-1', 'asha', 'c-asha', 1, 'message', 'What does this report say?', '${chip}', 1, '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z');
     UPDATE chats SET revision = 1 WHERE id = 'c-asha';`,
  );
  await rufi.start();
  await page.goto(rufi.link());

  // Blocked: the September photo's results are in the record.
  await openDocument(page, "thyroid recheck.jpg");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", {
      name: "thyroid recheck.jpg can't be deleted yet",
    }),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("list", { name: "Saved results from this document" })
      .getByRole("listitem"),
  ).toHaveText(["TSH 4.6 mIU/L12 Aug 2026", "Free T4 1.1 ng/dL1 Sep 2026"]);
  await accessible(page);
  await dialog.getByRole("button", { name: "Ask Rufi" }).click();
  await expect(dialog).toHaveCount(0);
  // The closed chat bar says what is added.
  const opener = page.getByRole("button", { name: "Open the chat" });
  await expect(opener).toHaveAccessibleDescription(/^thyroid recheck\.jpg /);

  // Deletable: what goes, what stays, and what Rufi can't reach.
  await openDocument(page, "Sunrise Labs August.pdf");
  // Another tab has it open.
  const other = await context.newPage();
  await other.goto(rufi.link());
  await other.goto(page.url());
  await expect(
    other.getByRole("button", { name: "Delete", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Delete Sunrise Labs August.pdf?" }),
  ).toBeVisible();
  await expect(dialog).toContainText("The file: 1 PDF, 2 pages");
  await expect(dialog).toContainText(
    "Its backups keep this document until they age out",
  );
  await accessible(page);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(page).toHaveURL(/\/documents$/);
  await expect(
    page.getByRole("link", { name: "Sunrise Labs August.pdf", exact: true }),
  ).toHaveCount(0);
  await opener.click();
  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages).toContainText("Deleted Sunrise Labs August.pdf");
  await expect(
    messages
      .getByRole("listitem")
      .filter({ hasText: "Sunrise Labs August.pdf" }),
  ).toContainText("document deleted");
  // The AI hears of it with the next message, and no reply starts now.
  const waiting = page.getByRole("region", { name: "Waiting messages" });
  await expect(waiting).toContainText(
    "Rufi's note: Deleted Sunrise Labs August.pdf",
  );
  await expect(waiting).toContainText("Goes to the AI with your next message.");
  await expect(waiting).not.toContainText("Not sent");
  // The other tab, and the address opened again, say it was deleted.
  const gone = "This document was deleted.";
  await expect(other.getByText(gone)).toBeVisible();
  await other.reload();
  await expect(other.getByText(gone)).toBeVisible();
  await expect(other.getByRole("button", { name: "Retry" })).toHaveCount(0);
  // An address of no document at all doesn't say it was deleted.
  await other.goto(other.url().replace("doc-asha-aug", "doc-nobody"));
  await expect(
    other.getByText("There is no such document. It may have been deleted."),
  ).toBeVisible();
  await other.close();
});

test("a report with many saved results keeps the dialog's buttons in view, its list scrolling", async ({
  page,
  rufi,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const many = Array.from({ length: 40 }, (_, i) => `res-m${String(i)}`);
  await rufi.family(
    `INSERT INTO results (id, person_id, report_id, category, test_name, value_text, value_number, unit, measured_at, entered_at) VALUES ${many
      .map(
        (id, i) =>
          `('${id}', 'asha', 'rep-asha-sep', 'lab', 'Test ${String(i + 1)}', '${String(i + 1)}', ${String(i + 1)}, 'U/L', '2026-09-01', '2026-09-02T18:31:00Z')`,
      )
      .join(", ")};
     INSERT INTO record_sources (person_id, kind, record_id, type, document_id, page) VALUES ${many
       .map(
         (id) =>
           `('asha', 'result', '${id}', 'document_page', 'doc-asha-sep', 1)`,
       )
       .join(", ")};`,
  );
  await rufi.start();
  await page.goto(rufi.link());
  await openDocument(page, "thyroid recheck.jpg");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const results = dialog
    .getByRole("list", { name: "Saved results from this document" })
    .getByRole("listitem");
  await expect(results).toHaveCount(42);

  await expect(dialog.getByRole("heading")).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Ask Rufi" }),
  ).toBeInViewport();
  await results.last().scrollIntoViewIfNeeded();
  await expect(results.last()).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Ask Rufi" }),
  ).toBeInViewport();
  await accessible(page);
  await dialog.getByRole("button", { name: "Ask Rufi" }).click();
  await expect(dialog).toHaveCount(0);
});
