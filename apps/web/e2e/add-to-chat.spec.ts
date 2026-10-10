// Adding to the chat on the real core: results (Ask Rufi on the Results page), documents and a document's
// draft items go into the box as chips (on a row, or several at once), files added with the
// paperclip become documents with their chips, the chips survive a reload
// and go with the message to the AI, and a big save's receipt shows its
// summary with the list folded. The strict CSP refuses nothing.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test, type Rufi } from "./rufi.ts";

const FIXTURES = join(
  import.meta.dirname,
  "../../server/tests/fixtures/documents",
);

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

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });
const box = (scope: Page | Locator) =>
  scope.getByRole("textbox", { name: "Message to Rufi" });
const chips = (scope: Page | Locator) =>
  scope.getByRole("list", { name: "Added to this message" });
const log = (scope: Page | Locator) =>
  scope.getByRole("log", { name: "Messages" });
const sidebar = (page: Page) => page.getByRole("complementary");

/** Rufi with the fictional family, opened at its Overview. */
async function opened(
  page: Page,
  rufi: Rufi,
  options?: Parameters<Rufi["start"]>[0],
  ...more: string[]
) {
  await rufi.family(...more);
  await rufi.start(options);
  await page.goto(rufi.link());
  await expect(
    page.getByRole("heading", { name: "Your record" }),
  ).toBeVisible();
}

/** What the scripted AI got as each turn's input, in order. */
const inputs = async (rufi: Rufi) =>
  (await readFile(join(rufi.home, "fake-codex.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .flatMap((line) => {
      const entry = JSON.parse(line) as {
        received?: { method?: string; params?: { input?: { text: string }[] } };
      };
      return entry.received?.method === "turn/start"
        ? [(entry.received.params?.input ?? []).map((part) => part.text)]
        : [];
    });

test("results go into the chat as chips, one or several at once; they survive a reload and go with the message", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await sidebar(page)
    .getByRole("link", { name: /^Results/ })
    .click();
  const row = (name: string) =>
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name, exact: true }) });

  // One row: Ask Rufi, shown on the pointer, puts it in the chat's box.
  await row("CRP").hover();
  await row("CRP").getByRole("button", { name: "Ask Rufi" }).click();
  await expect(page).toHaveURL(/\/people\/asha\/chat$/);
  await expect(chips(page).getByRole("listitem")).toHaveText([
    "CRP <5 mg/L · 12 Aug 2026",
  ]);
  await page.goBack();

  // Several: tick them, then add them together.
  await row("Glucose").getByRole("checkbox").check();
  await row("Free T4").getByRole("checkbox").check();
  await expect(page.getByText("2 chosen")).toBeVisible();
  await accessible(page);
  // They go in as the screen shows them.
  await page.getByRole("button", { name: "Add 2 to chat" }).click();
  await expect(chips(page).getByRole("listitem")).toHaveText([
    "CRP <5 mg/L · 12 Aug 2026",
    "Free T4 1.1 ng/dL · 1 Sep 2026",
    "Glucose 118 mg/dL · 12 Aug 2026",
  ]);
  await accessible(page);

  // Taken out of the box, a chip changes nothing else; the rest are kept.
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/chat/draft") &&
      response.request().method() === "PUT" &&
      response.request().postData()?.includes("res-a2") === true &&
      response.request().postData()?.includes("res-a6") === false,
  );
  await chips(page)
    .getByRole("button", {
      name: "Take Free T4 1.1 ng/dL · 1 Sep 2026 out of the message",
    })
    .click();
  await expect(chips(page).getByRole("listitem")).toHaveCount(2);
  await saved;
  await page.reload();
  await expect(chips(page).getByRole("listitem")).toHaveText([
    "CRP <5 mg/L · 12 Aug 2026",
    "Glucose 118 mg/dL · 12 Aug 2026",
  ]);

  await box(page).fill("Are these high?");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  await expect(chips(page)).toHaveCount(1);
  const message = log(page).locator("[data-entry]").first();
  await expect(chips(message).getByRole("listitem")).toHaveText([
    "CRP <5 mg/L · 12 Aug 2026",
    "Glucose 118 mg/dL · 12 Aug 2026",
  ]);
  await expect(log(page).locator(".reply")).toHaveText(/^ok:Are these high\?/);
  expect((await inputs(rufi)).at(-1)?.at(-1)).toBe(
    "Are these high?\n\nReferences the user added to this message (Rufi's, exact: read them with your tools):\n- result res-a3 (kind result), version null: CRP <5 mg/L · 12 Aug 2026\n- result res-a2 (kind result), version null: Glucose 118 mg/dL · 12 Aug 2026",
  );
});

test("the paperclip adds a file as a document with its chip; the same file again gives the chip of the one you have; a Documents row adds its chip", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  const picker = page.getByLabel("Choose documents to add");
  await picker.setInputFiles({
    name: "Asha lipid panel.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(join(FIXTURES, "ravi-lipid-panel.pdf")),
  });
  await expect(chips(page).getByRole("listitem")).toHaveText([
    "Asha lipid panel.pdf",
  ]);
  await picker.setInputFiles({
    name: "August again.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(join(FIXTURES, "sunrise-labs-august.pdf")),
  });
  await expect(
    page.getByText(
      "August again.pdf was already added: the chip is the document you have.",
    ),
  ).toBeVisible();
  await expect(chips(page).getByRole("listitem")).toHaveText([
    "Asha lipid panel.pdf",
    "Sunrise Labs August.pdf",
  ]);
  await accessible(page);

  // The new document is on the Documents page, added from the chat.
  await page.getByRole("link", { name: "Documents" }).click();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("thyroid recheck.jpg") });
  await row.hover();
  await row.getByRole("button", { name: "+ Add to chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(chips(page).getByRole("listitem")).toHaveText([
    "Asha lipid panel.pdf",
    "Sunrise Labs August.pdf",
    "thyroid recheck.jpg",
  ]);
});

/** Seven draft items read from page 1 of Asha's August report. */
const DRAFTS = `
  INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, created_at)
    VALUES ('job-aug', 'asha', 'document_read', 'doc-asha-aug', 'done', 1, '[1,2]', '2026-10-01T09:00:00Z');
  UPDATE document_pages SET state = 'read', entry_job_id = 'job-aug',
    entry = '{"outcome":"read","facts":{"issuer":"Sunrise Labs","dates":[{"label":"Collected","date":"12 Aug 2026","iso":"2026-08-12"}]},"items":[]}'
    WHERE document_id = 'doc-asha-aug';
  UPDATE documents SET version = 1 WHERE id = 'doc-asha-aug';
  INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, fields, original, created_at)
  SELECT 'drf-' || n, 'asha', 'doc-asha-aug', 1, n, 'job-aug', 'lab_result',
    json_object('test_name', 'Test ' || n, 'value_text', '' || n),
    json_object('test_name', 'Test ' || n, 'value_text', '' || n),
    '2026-10-01T09:00:00Z'
  FROM (SELECT 1 AS n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7);
`;

test("a save of a document's items shows its summary, with what was saved folded", async ({
  page,
  rufi,
}) => {
  await opened(
    page,
    rufi,
    {
      scenario: {
        calls: [
          {
            namespace: "rufi",
            tool: "save_changes",
            arguments: {
              items: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
                item: `drf-${String(n)}`,
                version: 1,
                as: "new",
              })),
            },
          },
        ],
      },
    },
    DRAFTS,
  );
  await box(chat(page)).click();
  await box(chat(page)).fill("Save it");
  await box(chat(page)).press("Enter");
  const receipt = log(chat(page)).locator(".receipt");
  await expect(receipt.locator("p").first()).toHaveText(
    "Saved 7 results from Sunrise Labs August.pdf · 7 new",
  );
  const list = receipt.getByRole("listitem");
  await expect(list.first()).toBeHidden();
  await receipt.getByText("Show what was saved").click();
  await expect(list).toHaveCount(7);
  await expect(list.first()).toHaveText(
    'Added result Test 1 1: measured 12 Aug 2026 ("Collected 12 Aug 2026") · page 1',
  );
  await accessible(page);
});

test("a document's draft items go into the chat as chips, one or several at once, and the AI gets their exact ids", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, undefined, DRAFTS);
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByRole("button", { name: "Sunrise Labs August.pdf" }).click();
  const items = page.getByRole("region", { name: "Items" });
  const row = (test: string) =>
    items
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: test, exact: true }) });

  // One row: its own button, shown on the pointer.
  await row("Test 1").hover();
  await row("Test 1").getByRole("button", { name: "+ Add to chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(chips(page).getByRole("listitem")).toHaveText(["Test 1 1"]);
  await page.goBack();

  // Several: tick them, then add them together.
  await row("Test 2").getByRole("checkbox", { name: "Choose Test 2" }).check();
  await row("Test 5").getByRole("checkbox", { name: "Choose Test 5" }).check();
  await expect(page.getByText("2 chosen")).toBeVisible();
  await accessible(page);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/chat/draft") &&
      response.request().method() === "PUT" &&
      response.request().postData()?.includes("drf-5") === true,
  );
  await page.getByRole("button", { name: "Add 2 to chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(chips(page).getByRole("listitem")).toHaveText([
    "Test 1 1",
    "Test 2 2",
    "Test 5 5",
  ]);
  await saved;
  await page.reload();
  await expect(chips(page).getByRole("listitem")).toHaveText([
    "Test 1 1",
    "Test 2 2",
    "Test 5 5",
  ]);

  await box(page).fill("Save these");
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("");
  await expect(log(page).locator(".reply")).toHaveText(/^ok:Save these/);
  expect((await inputs(rufi)).at(-1)?.at(-1)).toBe(
    "Save these\n\nReferences the user added to this message (Rufi's, exact: read them with your tools):\n- draft item drf-1, version 1: Test 1 1\n- draft item drf-2, version 1: Test 2 2\n- draft item drf-5, version 1: Test 5 5",
  );
});
