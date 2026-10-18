// Adding to the chat on the real core: Needs you lines, results, a report,
// documents and a document's draft items go into the chat box as chips with
// Ask Rufi, and the page stays (the closed bar says what is added); files
// added with the paperclip become documents with their chips, which say what
// Rufi does with them; the chips survive a reload and go with the message to
// the AI, and a big save's receipt shows its summary with the list folded.
// The strict CSP refuses nothing.
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
/** The closed bar says what is added: the first chip and how many more. */
const added = (scope: Locator, shown: string) =>
  expect(opener(scope)).toHaveAccessibleDescription(
    new RegExp(`^${shown.replace(/[.+?]/g, "\\$&")} `),
  );
/** The closed bar: a pill that opens the chat panel. */
const opener = (scope: Locator) =>
  scope.getByRole("button", { name: "Open the chat" });
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
    page.getByRole("heading", { name: "Health record" }),
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

test("Ask Rufi puts chips of several kinds in the box, a report as one, and the page stays; they survive a reload and go with the message", async ({
  page,
  rufi,
}) => {
  await opened(
    page,
    rufi,
    undefined,
    "INSERT INTO follow_ups (id, person_id, title, due) VALUES ('f-hba1c', 'asha', 'Repeat HbA1c', '2026-01-15');",
  );
  const bar = chat(page);
  const minimise = bar.getByRole("button", { name: "Minimise" });

  // A Needs you line: its chip goes in the box; the bar says so, closed.
  await page
    .getByRole("region", { name: "Needs you" })
    .getByRole("button", { name: "Ask Rufi about Repeat HbA1c" })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await added(bar, "Repeat HbA1c · 15 Jan 2026");
  await expect(minimise).toHaveCount(0);

  await sidebar(page)
    .getByRole("link", { name: /^Lab results/ })
    .click();
  const results = page.url();
  const row = (name: string) =>
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name, exact: true }) });

  // A row: Ask Rufi, shown on the pointer.
  await row("CRP").hover();
  await row("CRP").getByRole("button", { name: "Ask Rufi" }).click();
  // A report: one chip for its results, from its heading.
  await page
    .getByRole("button", {
      name: "Ask Rufi about this report: Sunrise Labs · 1 Sep 2026 · 2 results",
    })
    .click();
  expect(page.url()).toBe(results);
  await expect(minimise).toHaveCount(0);
  await added(bar, "Repeat HbA1c · 15 Jan 2026 +2");
  await accessible(page);

  // The panel shows them all.
  await opener(bar).click();
  await expect(box(bar)).toBeFocused();
  await expect(chips(bar).getByRole("listitem")).toHaveText([
    "Repeat HbA1c · 15 Jan 2026",
    "CRP <5 mg/L · 12 Aug 2026",
    "Sunrise Labs · 1 Sep 2026 · 2 results",
  ]);
  await accessible(page);

  // Taken out of the box, a chip changes nothing else; the rest are kept.
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/chat/draft") &&
      response.request().method() === "PUT" &&
      response.request().postData()?.includes("rep-asha-sep") === true &&
      response.request().postData()?.includes("res-a3") === false,
  );
  await chips(bar)
    .getByRole("button", {
      name: "Take CRP <5 mg/L · 12 Aug 2026 out of the message",
    })
    .click();
  await expect(chips(bar).getByRole("listitem")).toHaveCount(2);
  await saved;
  await page.reload();
  await added(bar, "Repeat HbA1c · 15 Jan 2026 +1");
  await opener(bar).click();
  await expect(chips(bar).getByRole("listitem")).toHaveText([
    "Repeat HbA1c · 15 Jan 2026",
    "Sunrise Labs · 1 Sep 2026 · 2 results",
  ]);

  await box(bar).fill("Are these high?");
  await box(bar).press("Enter");
  await expect(box(bar)).toHaveValue("");
  // Only the sent message's chips are left.
  await expect(chips(bar)).toHaveCount(1);
  const message = log(bar).locator("[data-entry]").first();
  await expect(chips(message).getByRole("listitem")).toHaveText([
    "Repeat HbA1c · 15 Jan 2026",
    "Sunrise Labs · 1 Sep 2026 · 2 results",
  ]);
  await expect(log(bar).locator(".reply")).toHaveText(/^ok:Are these high\?/);
  expect(page.url()).toBe(results);
  expect((await inputs(rufi)).at(-1)?.at(-1)).toBe(
    "Are these high?\n\nReferences the user added to this message (Rufi's, exact: read them with your tools):\n- follow-up f-hba1c (kind follow_up), version null: Repeat HbA1c · 15 Jan 2026\n- report rep-asha-sep, version null: Sunrise Labs · 1 Sep 2026 · 2 results",
  );

  // With the panel open, Ask Rufi adds to its box, and it stays open (a
  // window wide enough to show the row beside the panel).
  await page.setViewportSize({ width: 2000, height: 800 });
  await row("HbA1c").hover();
  await row("HbA1c").getByRole("button", { name: "Ask Rufi" }).click();
  await expect(minimise).toBeVisible();
  await expect(chips(bar.locator("form")).getByRole("listitem")).toHaveText([
    "HbA1c 6.8 % · 12 Aug 2026",
  ]);
  await expect(box(bar)).toBeFocused();
});

test("the paperclip says it adds a file, then gives its chip with what Rufi does with it; the same file again gives the chip of the one you have; a Documents row adds its chip", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  const bar = chat(page);
  await opener(bar).click();
  // The upload is held: the box says what it adds before the chip exists.
  const upload = Promise.withResolvers<undefined>();
  await page.route("**/api/people/asha/documents", async (route) => {
    if (route.request().method() === "POST") await upload.promise;
    await route.continue();
  });
  const picker = bar.getByLabel("Choose documents to add");
  await picker.setInputFiles({
    name: "Asha lipid panel.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(join(FIXTURES, "ravi-lipid-panel.pdf")),
  });
  await expect(bar.getByText("Adding Asha lipid panel.pdf…")).toBeVisible();
  await expect(chips(bar)).toHaveCount(0);
  upload.resolve(undefined);
  // With no reader, its reading waits.
  await expect(chips(bar).getByRole("listitem")).toHaveText([
    "Asha lipid panel.pdf · Waiting to read",
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
  await expect(chips(bar).getByRole("listitem")).toHaveText([
    "Asha lipid panel.pdf · Waiting to read",
    "Sunrise Labs August.pdf",
  ]);
  await accessible(page);

  // The new document is on the Documents page, added from the chat; Ask
  // Rufi on a row adds its chip, and the page stays.
  await page.getByRole("link", { name: "Documents" }).click();
  const documents = page.url();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("thyroid recheck.jpg") });
  await row.hover();
  await row.getByRole("button", { name: "Ask Rufi" }).click();
  expect(page.url()).toBe(documents);
  await added(bar, "Asha lipid panel.pdf +2");
  await opener(bar).click();
  await expect(chips(bar).getByRole("listitem")).toHaveText([
    "Asha lipid panel.pdf · Waiting to read",
    "Sunrise Labs August.pdf",
    "thyroid recheck.jpg",
  ]);

  // A sent message's chips say nothing of the reading.
  await box(bar).fill("What are these?");
  await box(bar).press("Enter");
  const message = log(bar).locator("[data-entry]").first();
  await expect(chips(message).getByRole("listitem")).toHaveText([
    "Asha lipid panel.pdf",
    "Sunrise Labs August.pdf",
    "thyroid recheck.jpg",
  ]);
});

/** Seven draft items read from page 1 of Asha's August report. */
const DRAFTS = `
  INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, sorted_at, created_at)
    VALUES ('job-aug', 'asha', 'document_read', 'doc-asha-aug', 'done', 1, '[1,2]', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z');
  UPDATE document_pages SET state = 'read', entry_job_id = 'job-aug'
    WHERE document_id = 'doc-asha-aug';
  UPDATE documents SET version = 1, kind = 'lab_report', issuer = 'Sunrise Labs', date = '2026-08-12'
    WHERE id = 'doc-asha-aug';
  INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, fields, original, quote, created_at)
  SELECT 'drf-' || n, 'asha', 'doc-asha-aug', 1, n, 'job-aug', 'lab_result',
    json_object('test_name', 'Test ' || n, 'value_text', '' || n, 'date', json('{"label":"Collected","date":"12 Aug 2026","iso":"2026-08-12"}')),
    json_object('test_name', 'Test ' || n, 'value_text', '' || n, 'date', json('{"label":"Collected","date":"12 Aug 2026","iso":"2026-08-12"}')),
    'Test ' || n || ' | ' || n, '2026-10-01T09:00:00Z'
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
            tool: "save_changes",
            arguments: {
              items: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
                item: `drf-${String(n)}`,
                version: 1,
                as: "new",
                category: "lab",
              })),
            },
          },
        ],
      },
    },
    DRAFTS,
  );
  await opener(chat(page)).click();
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
    'Added result Test 1 1: category lab, measured 12 Aug 2026 ("Collected 12 Aug 2026") · page 1',
  );
  await accessible(page);
  // Overview's Recent changes names it by its summary alone.
  await expect(
    page
      .getByRole("region", { name: "Recent changes" })
      .locator("summary")
      .first(),
  ).toHaveText(
    /^Today \d\d:\d\dSaved 7 results from Sunrise Labs August\.pdf · 7 new$/,
  );
});

test("setting a document's items aside shows its receipt, with the items folded", async ({
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
            tool: "dismiss_items",
            arguments: {
              items: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
                item: `drf-${String(n)}`,
                version: 1,
              })),
            },
          },
        ],
      },
    },
    DRAFTS,
  );
  await opener(chat(page)).click();
  await box(chat(page)).fill("None of these are mine");
  await box(chat(page)).press("Enter");
  const receipt = log(chat(page)).locator(".receipt");
  await expect(receipt.locator("p").first()).toHaveText(
    "Set aside 7 items from Sunrise Labs August.pdf: not saved",
  );
  const list = receipt.getByRole("listitem");
  await expect(list.first()).toBeHidden();
  await receipt.getByText("Show the items").click();
  await expect(list).toHaveCount(7);
  await expect(list.first()).toHaveText("Test 1 1 · page 1");
});

test("a document's draft items go into the chat as chips, and the AI gets their exact ids", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, undefined, DRAFTS);
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByRole("link", { name: "Sunrise Labs August.pdf" }).click();
  const items = page.getByRole("region", { name: "Items" });
  const row = (test: string) =>
    items
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: test, exact: true }) });
  const bar = chat(page);
  const documentPage = page.url();

  // Each row: its own Ask Rufi, shown on the pointer; the page stays.
  for (const test of ["Test 1", "Test 5"]) {
    await row(test).hover();
    await row(test).getByRole("button", { name: "Ask Rufi" }).click();
  }
  expect(page.url()).toBe(documentPage);
  await added(bar, "Test 1 1 +1");
  await accessible(page);
  await page.reload();
  await opener(bar).click();
  await expect(chips(bar).getByRole("listitem")).toHaveText([
    "Test 1 1",
    "Test 5 5",
  ]);

  await box(bar).fill("Save these");
  await box(bar).press("Enter");
  await expect(box(bar)).toHaveValue("");
  await expect(log(bar).locator(".reply")).toHaveText(/^ok:Save these/);
  expect((await inputs(rufi)).at(-1)?.at(-1)).toBe(
    "Save these\n\nReferences the user added to this message (Rufi's, exact: read them with your tools):\n- draft item drf-1, version 1: Test 1 1\n- draft item drf-5, version 1: Test 5 5",
  );
});
