// A document's page on the real core, after a scripted reading
// (tests/readers.ts) and Rufi AI's scripted sort: the drafts beside
// their page with the words they come from, "Worth a look only", a fix that
// keeps the drafted value, a fix from a second tab refused with the value
// now, and "Save in chat" putting the words in the box.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { readOf, readThen } from "../../server/tests/readers.ts";
import { expect, FILE_WORK_MS, sendFiles, test } from "./rufi.ts";

const REPORT = join(
  import.meta.dirname,
  "../../server/tests/fixtures/documents/sunrise-labs-august.pdf",
);

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

const COLLECTED = {
  label: "Collected",
  date: "12 Aug 2026",
  iso: "2026-08-12",
};
const draft = (
  page: number,
  test_name: string,
  value_text: string,
  unit: string,
  more = {},
) => ({
  page,
  reading: "$reading",
  test_name,
  value_text,
  unit,
  date: COLLECTED,
  quote: `${test_name} | ${value_text} | ${unit}`,
  ...more,
});

/** Rufi AI's sort of the report, once it is read: one document, three drafts. */
const SORT = [
  {
    id: "sort-aug",
    tool: "sort_documents",
    arguments: {
      document: "$document",
      documents: [
        {
          id: "$document",
          pages: [1, 2],
          kind: "lab_report",
          date: "2026-08-12",
          lab: "Sunrise Labs",
        },
      ],
      drafts: [
        draft(1, "Haemoglobin", "13.2", "g/dL"),
        draft(1, "Platelet count", "2.1", "lakh/µL", {
          reference_range: "1.5-4.1",
          worth_a_look: "the decimal point is faint",
        }),
        draft(2, "Haemoglobin", "13.2", "g/dL"),
      ],
    },
  },
];

test("checks a report against its pages: worth a look only, a fix, a fix from another tab, then the chat", async ({
  page,
  rufi,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const first = readOf(1);
  const pages = [
    {
      ...first,
      // A row the reader wrote as HTML: its quote is the row's words.
      copy: `${first.copy}\n\n<table><tr><td>Platelet count</td><td><strong>2.1</strong></td><td>lakh/µL</td><td>1.5-4.1</td></tr></table>`,
    },
    readOf(2),
  ];
  await rufi.family(
    `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
     DELETE FROM document_pages; DELETE FROM documents;`,
  );
  await rufi.start({
    scenario: { callsByText: readThen("Sort this report", pages, SORT) },
  });
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
  await sendFiles(
    page,
    {
      name: "sunrise-labs-august.pdf",
      mimeType: "application/pdf",
      buffer: await readFile(REPORT),
    },
    "Sort this report",
  );
  await expect(
    page.getByRole("cell", { name: /Not saved · 3 results/ }),
  ).toBeVisible({ timeout: FILE_WORK_MS });
  // The reply is on its way; fold the chat back to its bar.
  await page
    .getByRole("region", { name: "Chat" })
    .getByRole("button", { name: "Minimise" })
    .click();

  // Items beside the page; a row shows its page and the words it came from.
  await page.getByRole("link", { name: "sunrise-labs-august.pdf" }).click();
  const items = page.getByRole("region", { name: "Items" });
  const shown = page.getByRole("region", { name: "Page" });
  await expect(items).toContainText("3 results · 1 worth a look");
  await expect(items).toContainText("Page 2 · read · 1 item");
  await expect(items).toContainText(
    "From the page: “Platelet count | 2.1 | lakh/µL”",
  );
  await expect(items).not.toContainText("<td>");
  await expect(shown.getByRole("img", { name: "Page 1 of 2" })).toBeVisible();
  await items.getByRole("button", { name: "Haemoglobin" }).nth(1).click();
  await expect(shown.getByRole("img", { name: "Page 2 of 2" })).toBeVisible();
  await accessible(page);

  // Worth a look only.
  await items.getByLabel("Worth a look only (1)").check();
  await expect(items.getByRole("button", { name: "Haemoglobin" })).toHaveCount(
    0,
  );
  await expect(items).toContainText("Worth a look: the decimal point is faint");

  // A fix keeps the drafted value.
  await items.getByRole("button", { name: "Platelet count" }).click();
  await items.getByRole("button", { name: "Fix" }).click();
  const form = items.getByRole("form", { name: "Fix Platelet count" });
  await form.getByLabel("Value").fill("2.7");
  await form.getByRole("button", { name: "Save fix" }).click();
  await expect(form).toHaveCount(0);
  await expect(items).toContainText("2.7 lakh/µL");
  await expect(items).toContainText("Drafted: value 2.1");
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
  await form.getByRole("button", { name: "Replace fix" }).click();
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
  const opener = chat.getByRole("button", { name: "Open the chat" });
  const minimise = chat.getByRole("button", { name: "Minimise" });
  const save = page.getByRole("button", { name: "Save in chat" });

  // Save in chat, twice: after what the box holds, and the page
  // stays; the person sends. The bar stays one line, whatever the text.
  await opener.click();
  await box.fill("What changed since March?\nAnd since June?");
  await page.keyboard.press("Escape");
  await save.click();
  await save.click();
  expect(page.url()).toBe(documentPage);
  await expect(minimise).toHaveCount(0);
  await expect(opener).toHaveAccessibleName(
    /^Open the chat: sunrise-labs-august\.pdf What changed since March\?/,
  );

  // In a short window, the footer's button is above the bar: a click at
  // its middle and near its corner reaches it.
  await page.setViewportSize({ width: 1000, height: 420 });
  await page.getByRole("main").evaluate((main) => {
    main.scrollTo(0, main.scrollHeight);
  });
  const button = await save.boundingBox();
  for (const [x, y] of [
    [0.5, 0.5],
    [0.9, 0.9],
  ] as const) {
    const at = {
      x: (button?.x ?? 0) + (button?.width ?? 0) * x,
      y: (button?.y ?? 0) + (button?.height ?? 0) * y,
    };
    // What is there is the button or a part of it, such as its icon.
    expect(
      await save.evaluate((element, { x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && element.contains(hit);
      }, at),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await opener.click();
  await expect(box).toHaveValue(
    "What changed since March?\nAnd since June?\n\nSave these 3 results.\n\nSave these 3 results.",
  );
  await expect(
    chat
      .locator("form")
      .getByRole("list", { name: "Added to this message" })
      .getByRole("listitem"),
  ).toHaveText(["sunrise-labs-august.pdf"]);
  await accessible(page);
  await box.fill("What changed since March?");

  // A lost send's answer blocks adding, also after a reload, and the bar
  // says why each time.
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
  // Why it can't be used yet stays beside the button, as its description.
  await expect(save).toBeDisabled();
  await expect(save).toHaveAccessibleDescription(
    "Retry the message in the chat first.",
  );
  const refused =
    "Your last message may not have reached Rufi: send it again or change it first.";
  const ask = async () => {
    await items.getByRole("row").filter({ hasText: "Platelet count" }).hover();
    await items.getByRole("button", { name: "Ask Rufi" }).first().click();
    await expect(chat.getByRole("alert")).toHaveText(refused);
    await expect(opener).toHaveAccessibleName(
      new RegExp(`${refused.replace(/[.?:]/g, "\\$&")}$`),
    );
  };
  await ask();
  await page.reload();
  await expect(save).toHaveAccessibleDescription(
    "Retry the message in the chat first.",
  );
  await ask();
  expect(submitted).toHaveLength(1);
  // The core took it, so its reply runs: ⌘J opens the panel, which says why
  // in full.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(chat.getByRole("alert")).toHaveText(refused);
  await expect(box).toHaveValue(submitted[0]?.text ?? "");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  expect(submitted).toEqual([submitted[0], submitted[0]]);
  expect(page.url()).toBe(documentPage);
  await expect(save).toBeEnabled();
});

/**
 * Three drafts Rufi AI wrote from page 1 of Asha's August report; the person
 * fixed the first one's value (drafted as 13.2).
 */
const DRAFTS = `
  INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, created_at)
    VALUES ('job-aug', 'asha', 'document_read', 'doc-asha-aug', 'done', 1, '[1,2]', '2026-10-01T09:00:00Z');
  UPDATE document_pages SET state = 'read', entry_job_id = 'job-aug'
    WHERE document_id = 'doc-asha-aug';
  UPDATE documents SET version = 1, kind = 'lab_report', issuer = 'Sunrise Labs', date = '2026-08-12'
    WHERE id = 'doc-asha-aug';
  INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, version, fields, original, quote, created_at)
  SELECT 'drf-' || n, 'asha', 'doc-asha-aug', 1, n, 'job-aug', 'lab_result',
    CASE n WHEN 1 THEN 2 ELSE 1 END,
    json_object('test_name', 'Test ' || n, 'value_text', CASE n WHEN 1 THEN '13.4' ELSE '' || n END, 'date', json('{"label":"Collected","date":"12 Aug 2026","iso":"2026-08-12"}')),
    json_object('test_name', 'Test ' || n, 'value_text', CASE n WHEN 1 THEN '13.2' ELSE '' || n END, 'date', json('{"label":"Collected","date":"12 Aug 2026","iso":"2026-08-12"}')),
    'Test ' || n || ' | ' || CASE n WHEN 1 THEN '13.2' ELSE '' || n END, '2026-10-01T09:00:00Z'
  FROM (SELECT 1 AS n UNION SELECT 2 UNION SELECT 3);
  INSERT INTO tests (id, person_id, name)
  SELECT 'tst-' || n, 'asha', 'Test ' || n FROM (SELECT 1 AS n UNION SELECT 2 UNION SELECT 3);
`;

test("the list stays Not saved while an earlier value waits, then shows Saved when it is set aside", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    DRAFTS,
    `DELETE FROM draft_items WHERE id = 'drf-3';
     UPDATE draft_items SET fields = json_set(fields, '$.column', 'earlier'),
       original = json_set(original, '$.column', 'earlier')
       WHERE id = 'drf-2';
`,
  );
  await rufi.start({
    scenario: {
      callsByTurn: [
        [
          {
            id: "save-current",
            tool: "save_changes",
            arguments: {
              items: [
                {
                  item: "drf-1",
                  version: 2,
                  as: "new",
                  category: "lab",
                  in_test: "tst-1",
                },
              ],
            },
          },
        ],
        [
          {
            id: "set-aside-earlier",
            tool: "dismiss_items",
            arguments: { items: [{ item: "drf-2", version: 1 }] },
          },
        ],
      ],
    },
  });
  await page.goto(rufi.link());
  const document = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Sunrise Labs August.pdf" }),
  });
  await page.getByRole("link", { name: "Documents" }).click();
  await expect(document).toContainText("Not saved · 1 result");

  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  const box = page.getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("Save only the current result");
  await box.press("Enter");
  await expect(page.locator(".receipt")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Documents" }).click();
  await expect(document.getByText("Not saved", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  await box.fill("Set the earlier value aside");
  await box.press("Enter");
  await expect(page.locator(".receipt")).toHaveCount(2);
  await page.getByRole("link", { name: "Documents" }).click();
  await expect(document).toContainText("Saved · 1 result");
});

test("once nothing waits, the page says its results were saved to the health record, counts what was saved and set aside, has no Save in chat, and opens without the earlier state", async ({
  page,
  rufi,
}) => {
  await rufi.family(DRAFTS);
  await rufi.start({
    scenario: {
      calls: [
        {
          tool: "save_changes",
          arguments: {
            items: [1, 2].map((n) => ({
              item: `drf-${String(n)}`,
              version: n === 1 ? 2 : 1,
              as: "new",
              category: "lab",
              in_test: `tst-${String(n)}`,
            })),
          },
        },
        {
          tool: "dismiss_items",
          arguments: { items: [{ item: "drf-3", version: 1 }] },
        },
      ],
    },
  });
  await page.goto(rufi.link());
  const open = async () => {
    await page.getByRole("link", { name: "Documents" }).click();
    await page.getByRole("link", { name: "Sunrise Labs August.pdf" }).click();
  };
  await open();
  const items = page.getByRole("region", { name: "Items" });
  const save = page.getByRole("button", { name: "Save in chat" });
  const waiting =
    "What the reader read, not saved. These become part of your health record only when you save them in the chat.";
  const inRecord = "These results were saved to your health record.";
  await expect(page.getByText(waiting)).toBeVisible();
  await expect(items).toContainText(
    "3 results · 0 worth a look · 1 fixed by you",
  );
  await expect(page.getByText("Not saved yet: 3 results.")).toBeVisible();
  await expect(save).toBeVisible();

  // Saved and set aside in the chat while the page is closed.
  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  const box = page.getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("Save the first two; the third isn't mine");
  await box.press("Enter");
  await expect(page.locator(".receipt")).toHaveCount(2);

  // Opened again, it shows nothing until its items come: never the
  // earlier "not saved" state.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = false;
  await page.route("**/items", async (route) => {
    asked = true;
    await held;
    await route.continue();
  });
  await open();
  await expect.poll(() => asked).toBe(true);
  await expect(page.getByText(waiting)).toHaveCount(0);
  await expect(page.getByText(inRecord)).toHaveCount(0);
  await expect(save).toHaveCount(0);
  release();

  await expect(page.getByText(inRecord)).toBeVisible();
  await expect(page.getByText(waiting)).toHaveCount(0);
  await expect(items).toContainText("2 saved · 1 set aside");
  // Each row says the same: saved, or set aside.
  const row = (test: string) =>
    items.getByRole("row").filter({
      has: page.getByRole("button", { name: test, exact: true }),
    });
  await expect(row("Test 1")).toContainText("saved");
  await expect(row("Test 3")).toContainText("set aside");
  await expect(items).not.toContainText("dismissed");
  await expect(items).not.toContainText("0 results");
  await expect(page.getByText("Nothing here waits to be saved.")).toBeVisible();
  await expect(save).toHaveCount(0);
  await accessible(page);
  // The reader's work says the same.
  await page.getByRole("button", { name: "View reading" }).click();
  const reading = page.getByRole("dialog");
  await expect(reading.getByText(inRecord)).toBeVisible();
  await expect(reading.getByText(/not saved/)).toHaveCount(0);
  // What was saved is the person's fix, shown beside the reader's value.
  const read = reading.getByRole("row").filter({ hasText: "Test 1" });
  await expect(read.getByRole("cell").nth(1)).toHaveText("13.4");
  await expect(read).toContainText("Drafted: value 13.2");
  await expect(read).toContainText("fixed by you");
  await page.keyboard.press("Escape");
  await page.unrouteAll({ behavior: "wait" });

  // From Documents there is no mounted items query to share. The reading
  // may arrive first, but must show neither an unsaved claim nor the
  // reader's old value while the person's fix is still loading.
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  const document = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Sunrise Labs August.pdf" }),
  });
  // The list counts what was saved, not "nothing to save".
  await expect(document).toContainText("Saved · 2 results");
  const requested = Promise.withResolvers<undefined>();
  const delayed = Promise.withResolvers<undefined>();
  await page.route("**/items", async (route) => {
    requested.resolve(undefined);
    await delayed.promise;
    await route.continue();
  });
  try {
    await document.getByRole("button", { name: "View reading" }).click();
    await requested.promise;
    await expect(reading.getByRole("heading", { name: "Pages" })).toBeVisible();
    await expect(reading.getByText(inRecord)).toHaveCount(0);
    await expect(
      reading.getByText(/What the reader read, not saved/),
    ).toHaveCount(0);
    await expect(read).toHaveCount(0);
  } finally {
    delayed.resolve(undefined);
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(reading.getByText(inRecord)).toBeVisible();
  await expect(read.getByRole("cell").nth(1)).toHaveText("13.4");
  await page.keyboard.press("Escape");

  // A failed items read is an error to retry, not an unsaved claim. Retry
  // reaches the real core and restores the saved state without reopening.
  await page.route(
    "**/items",
    (route) =>
      route.fulfill({
        status: 500,
        json: { error: "Fictional items read failed." },
      }),
    { times: 1 },
  );
  await document.getByRole("button", { name: "View reading" }).click();
  const problem = reading.getByRole("alert");
  await expect(problem).toContainText("Fictional items read failed.");
  await expect(
    reading.getByText(/What the reader read, not saved/),
  ).toHaveCount(0);
  await expect(read).toHaveCount(0);
  await problem.getByRole("button", { name: "Retry" }).click();
  await expect(problem).toHaveCount(0);
  await expect(reading.getByText(inRecord)).toBeVisible();
  await expect(read.getByRole("cell").nth(1)).toHaveText("13.4");
});

test("once every result is set aside, the page, View reading and the list say nothing from it was saved to the health record", async ({
  page,
  rufi,
}) => {
  await rufi.family(DRAFTS);
  await rufi.start({
    scenario: {
      calls: [
        {
          tool: "dismiss_items",
          arguments: {
            items: [1, 2, 3].map((n) => ({
              item: `drf-${String(n)}`,
              version: n === 1 ? 2 : 1,
            })),
          },
        },
      ],
    },
  });
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
  const document = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Sunrise Labs August.pdf" }),
  });
  await expect(document).toContainText("Not saved · 3 results");

  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  const box = page.getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("None of these are mine");
  await box.press("Enter");
  await expect(page.locator(".receipt")).toHaveCount(1);

  await page.getByRole("link", { name: "Documents" }).click();
  await expect(document).toContainText("Set aside · 3 results");
  await expect(document).not.toContainText("Saved");

  await page.getByRole("link", { name: "Sunrise Labs August.pdf" }).click();
  const nothing = "Nothing from this document was saved to your health record.";
  await expect(page.getByText(nothing)).toBeVisible();
  await expect(
    page.getByText("These results were saved to your health record."),
  ).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Items" })).toContainText(
    "3 set aside",
  );
  await page.getByRole("button", { name: "View reading" }).click();
  const reading = page.getByRole("dialog");
  await expect(reading.getByText(nothing)).toBeVisible();
  await expect(
    reading.getByText("These results were saved to your health record."),
  ).toHaveCount(0);
});

test("once every result was saved, the page and the list say so, and still do after one is undone", async ({
  page,
  rufi,
}) => {
  // All three saved earlier, the third as the record's CRP result.
  await rufi.family(
    DRAFTS,
    `INSERT INTO operations (id, seq, person_id, chat_id, call_id, request, created_at)
       VALUES ('op-aug', 1, 'asha', 'c-asha', 'call-aug', '{}', '2026-10-01T09:05:00Z');
     UPDATE draft_items SET status = 'saved', saved_as = 'new', record_kind = 'result',
       record_id = 'res-a' || substr(id, 5), operation_id = 'op-aug'
       WHERE document_id = 'doc-asha-aug';`,
  );
  await rufi.start({
    scenario: {
      calls: [
        {
          tool: "save_changes",
          arguments: {
            changes: [{ kind: "result", action: "remove", id: "res-a3" }],
          },
        },
      ],
    },
  });
  await page.goto(rufi.link());
  const document = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Sunrise Labs August.pdf" }),
  });
  const saved = "These results were saved to your health record.";
  const check = async () => {
    await page.getByRole("link", { name: "Documents" }).click();
    await expect(document).toContainText("Saved · 3 results");
    await page.getByRole("link", { name: "Sunrise Labs August.pdf" }).click();
    await expect(page.getByText(saved)).toBeVisible();
    await expect(page.getByRole("region", { name: "Items" })).toContainText(
      "3 saved",
    );
    await expect(page.getByRole("region", { name: "Items" })).not.toContainText(
      "set aside",
    );
  };
  await check();

  // An undo removes the result from the record; it was still saved from
  // this document, so neither line turns into "set aside" or "nothing".
  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  const box = page.getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("Undo the CRP");
  await box.press("Enter");
  await expect(page.locator(".receipt")).toHaveCount(1);
  await check();
});
