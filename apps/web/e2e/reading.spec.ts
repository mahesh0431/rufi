// Reading documents on the screens, on the real core with a scripted reader
// (tests/fake-reader.ts): reading as a document is added, with the model and
// effort chosen in Settings, the reader strip above the chat box, a chip's
// state in the box, the start and end lines, Rufi AI's scripted sort, and
// Open with the reader's copies and the document's page.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ChatGptError } from "../../server/src/agent/chatgpt/openai.ts";
import type { Scenario } from "../../server/tests/fake-codex.ts";
import { readPage, scriptedReader } from "../../server/tests/fake-reader.ts";
import { expect, test, type Rufi } from "./rufi.ts";

const REPORT = join(
  import.meta.dirname,
  "../../server/tests/fixtures/documents/sunrise-labs-august.pdf",
);

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

/** Rufi AI's sort of the report, in the chat's first turn: one draft a page. */
const SORT: Scenario = {
  callsByTurn: [
    [
      {
        id: "sort-report",
        tool: "sort_documents",
        arguments: {
          document: "$document",
          documents: [
            { pages: [1, 2], kind: "lab_report", date: "2026-08-12" },
          ],
          drafts: [1, 2].map((page) => ({
            page,
            test_name: "Haemoglobin",
            value_text: "13.2",
            unit: "g/dL",
            quote: "Haemoglobin | 13.2 | g/dL",
          })),
        },
      },
    ],
  ],
};

/** Rufi with the family and no documents, reading with `reader`. */
async function opened(
  page: Page,
  rufi: Rufi,
  reader: ReturnType<typeof scriptedReader>,
  scenario?: Scenario,
) {
  await rufi.family(
    `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
     DELETE FROM document_pages; DELETE FROM documents;`,
  );
  await rufi.start({
    reader: reader.run,
    ...(scenario !== undefined && { scenario }),
  });
  await page.goto(rufi.link());
}

/** As `opened`, with the fictional report just added. */
async function start(
  page: Page,
  rufi: Rufi,
  reader: ReturnType<typeof scriptedReader>,
  scenario?: Scenario,
) {
  await opened(page, rufi, reader, scenario);
  await add(page);
}

/** Adds the fictional report on the Documents page. */
async function add(page: Page) {
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByLabel("Choose documents", { exact: true }).setInputFiles({
    name: "sunrise-labs-august.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(REPORT),
  });
}

test("reads a report in the background as it is added: the strip, the lines, Rufi AI's sort and Open", async ({
  page,
  rufi,
}) => {
  const gate = Promise.withResolvers<undefined>();
  const reader = scriptedReader([
    async (turn) => {
      await turn.look(1);
      await turn.save(1, readPage());
      await gate.promise;
      await turn.look(2);
      await turn.save(2, readPage());
      return undefined;
    },
  ]);
  await start(page, rufi, reader, SORT);

  await expect(
    page.getByRole("cell", { name: /Reading · read 1 of 2/ }),
  ).toBeVisible();
  await accessible(page);
  // Its chip in the chat box says what Rufi is doing with it.
  const row = page
    .getByRole("row")
    .filter({ hasText: "sunrise-labs-august.pdf" });
  await row.hover();
  await row.getByRole("button", { name: "Ask Rufi" }).click();
  const chip = page
    .getByRole("list", { name: "Added to this message" })
    .getByRole("listitem");

  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(chip).toHaveText(
    "sunrise-labs-august.pdf · Reading… 1 of 2 pages",
  );
  // As laid out, the state stands apart from the name.
  const gap = await chip.evaluate((item) => {
    const [name, state] = item.querySelectorAll(":scope > span > span");
    return (
      (state?.getBoundingClientRect().left ?? 0) -
      (name?.getBoundingClientRect().right ?? 0)
    );
  });
  expect(gap).toBeGreaterThanOrEqual(3);
  await expect(
    page.getByText("Reading sunrise-labs-august.pdf · 2 pages"),
  ).toBeVisible();
  const strip = page.getByRole("region", { name: "Reading documents" });
  await expect(strip).toContainText("sunrise-labs-august.pdf");
  await expect(strip).toContainText("read 1 of 2");
  await strip.getByRole("button", { name: "View reading" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("reading · read 1 of 2");
  // The page's copy, as the reader saved it.
  await expect(sheet.locator("pre")).toHaveCount(1);
  await expect(sheet.locator("pre")).toContainText("| Haemoglobin | 13.2 |");
  await expect(sheet).toContainText("Page 2");
  await accessible(page);
  await sheet.getByRole("button", { name: "Close" }).click();

  gate.resolve(undefined);
  const end = page.getByText(
    "Read sunrise-labs-august.pdf · 2 pages. Rufi AI is sorting it.",
  );
  await expect(end).toBeVisible();
  await expect(strip).toBeHidden();
  await expect(chip).toHaveText("sunrise-labs-august.pdf · Read");
  // Rufi AI sorted it in the chat, with one call, and said so.
  await expect(page.getByText("ok:", { exact: false }).last()).toBeVisible();
  // Open leads to the document's page; View reading is a button there.
  await page.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page.getByRole("region", { name: "Items" })).toContainText(
    "2 results · 0 worth a look",
  );
  await page.getByRole("button", { name: "View reading" }).click();
  await expect(sheet).toContainText("sunrise-labs-august.pdf · read");
  // Both pages read, each showing its copy.
  await expect(sheet.locator("pre")).toHaveCount(2);
  await expect(sheet.locator("pre").nth(1)).toContainText("| Haemoglobin |");
});

test("View reading says where a reading is while the reader's work loads, also on a retry of one page", async ({
  page,
  rufi,
}) => {
  const first = Promise.withResolvers<undefined>();
  const again = Promise.withResolvers<undefined>();
  const reader = scriptedReader([
    async (turn) => {
      await first.promise;
      await turn.look(1);
      await turn.save(1, readPage());
      await turn.look(2);
      await turn.save(2, { outcome: "unreadable", why: "Blurred.", copy: "" });
      return undefined;
    },
    // Retry reads only page 2.
    async (turn) => {
      await again.promise;
      await turn.look(2);
      await turn.save(2, readPage());
      return undefined;
    },
  ]);
  // Rufi AI sorts the first reading, so Retry reads page 2 again.
  await start(page, rufi, reader, {
    callsByTurn: [
      [
        {
          id: "sort-first",
          tool: "sort_documents",
          arguments: {
            document: "$document",
            documents: [{ pages: [1, 2], kind: "lab_report" }],
            drafts: [],
          },
        },
      ],
    ],
  });
  // The reader's work comes only when the test lets it.
  const held = { work: Promise.withResolvers<undefined>() };
  await page.route("**/documents/*/reading", async (route) => {
    await held.work.promise;
    await route.continue();
  });
  const strip = page.getByRole("region", { name: "Reading documents" });
  const sheet = page.getByRole("dialog");
  const title = sheet.getByRole("heading", { level: 2 });
  const view = async () => {
    await page.getByRole("link", { name: "Chat with Rufi" }).click();
    await strip.getByRole("button", { name: "View reading" }).click();
  };

  await view();
  await expect(title).toHaveText(
    /^sunrise-labs-august\.pdf · read 0 of 2 · under a minute$/,
  );
  await expect(sheet).toContainText("Reading… 0 of 2 pages");
  await accessible(page);
  held.work.resolve(undefined);
  await expect(title).toHaveText(
    /^sunrise-labs-august\.pdf · reading · read 0 of 2 · under a minute$/,
  );
  await expect(sheet).not.toContainText("Reading… 0 of 2 pages");
  await expect(sheet.getByText("not read yet")).toHaveCount(2);
  await sheet.getByRole("button", { name: "Close" }).click();
  first.resolve(undefined);
  await expect(strip).toBeHidden();

  // A retry reads only page 2: its progress counts one page, never "page 1".
  held.work = Promise.withResolvers<undefined>();
  await page.getByRole("link", { name: "Documents" }).click();
  await page
    .getByRole("row", { name: /sunrise-labs-august.pdf/ })
    .getByRole("button", { name: "Retry" })
    .click();
  await view();
  await expect(title).toHaveText(
    /^sunrise-labs-august\.pdf · read 0 of 1 · under a minute$/,
  );
  await expect(sheet).toContainText("Reading… 0 of 1 page");
  held.work.resolve(undefined);
  await sheet.getByRole("button", { name: "Close" }).click();
  // The reading ends before Rufi stops.
  again.resolve(undefined);
  await expect(strip).toBeHidden();
});

test("Settings keeps the reader's model and effort, and the next reading runs with them", async ({
  page,
  rufi,
}) => {
  const reader = scriptedReader([
    async (turn) => {
      await turn.look(1);
      await turn.save(1, readPage());
      await turn.look(2);
      await turn.save(2, readPage());
      return undefined;
    },
  ]);
  await opened(page, rufi, reader, SORT);
  await page.getByRole("link", { name: "Settings" }).click();
  const model = page.getByRole("combobox", { name: "Reader model" });
  await expect(model).toHaveValue("gpt-6.1-sol");
  await expect(model.getByRole("option")).toHaveText([
    "GPT-6.1-Sol",
    "GPT-5.5",
  ]);
  const effort = page.getByRole("radiogroup", { name: "Effort" });
  await expect(effort.getByRole("radio", { name: "Medium" })).toBeChecked();
  await accessible(page);
  await model.selectOption("gpt-5.5");
  await effort.getByRole("radio", { name: "High" }).click();
  await expect(effort.getByRole("radio", { name: "High" })).toBeChecked();
  await page.reload();
  await expect(model).toHaveValue("gpt-5.5");
  await expect(effort.getByRole("radio", { name: "High" })).toBeChecked();

  await add(page);
  await expect(
    page.getByRole("cell", { name: /Not saved · 2 results/ }),
  ).toBeVisible({ timeout: 10_000 });
  expect(reader.runs.map(({ model, effort }) => ({ model, effort }))).toEqual([
    { model: "gpt-5.5", effort: "high" },
  ]);
});

test("keeps unreadable pages to check and reserves Nothing to save for a completed empty reading", async ({
  page,
  rufi,
}) => {
  const reader = scriptedReader([
    async (turn) => {
      await turn.look(1);
      await turn.save(1, {
        outcome: "unreadable",
        why: "The print is blurred.",
        copy: "",
      });
      await turn.look(2);
      await turn.save(2, { outcome: "nothing_here", copy: "" });
      return undefined;
    },
    async (turn) => {
      await turn.look(1);
      await turn.save(1, {
        outcome: "read",
        copy: "Dear Asha,\n\nYour results were normal.",
      });
      return undefined;
    },
  ]);
  // Rufi AI sorts each reading: nothing to draft either time.
  const sort = (pages: number[], kind: string) => [
    {
      id: `sort-${kind}`,
      tool: "sort_documents",
      arguments: {
        document: "$document",
        documents: [{ pages, kind }],
        drafts: [],
      },
    },
  ];
  await rufi.family(
    `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
     DELETE FROM document_pages; DELETE FROM documents;`,
  );
  await rufi.start({
    reader: reader.run,
    scenario: { callsByTurn: [sort([1, 2], "other"), sort([1], "letter")] },
  });
  await page.goto(rufi.link());
  await add(page);
  const status = page
    .getByRole("row", { name: /sunrise-labs-august.pdf/ })
    .getByRole("cell")
    .nth(4); // Status
  await expect(status).toContainText("To check");
  await expect(status).not.toContainText("Nothing to save");
  await status.getByRole("button", { name: "Retry" }).click();
  await expect(status).toContainText("Nothing to save");
  await expect(status.getByRole("button", { name: "Retry" })).toBeHidden();
});

test("a reading that failed signed out gives its reason in full, in View reading and on the document page", async ({
  page,
  rufi,
}) => {
  const why =
    "Not signed in. Sign in with ChatGPT: in Rufi, or with pnpm rufi signin.";
  const reader = scriptedReader([
    () => Promise.reject(new ChatGptError("not_signed_in", why)),
  ]);
  await start(page, rufi, reader);
  const row = page.getByRole("row", { name: /sunrise-labs-august\.pdf/ });
  await expect(row).toContainText("Failed · read 0 of 2");
  /** The line is all there: none of it cut off. */
  const whole = async (text: string) => {
    const line = page.getByText(text, { exact: true });
    await expect(line).toBeVisible();
    expect(
      await line.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth &&
          element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
  };

  await row.getByRole("button", { name: "View reading" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { level: 2 })).toHaveText(
    "sunrise-labs-august.pdf · failed · read 0 of 2",
  );
  await whole(why);
  await accessible(page);
  await sheet.getByRole("button", { name: "Close" }).click();

  await row.getByRole("link", { name: "sunrise-labs-august.pdf" }).click();
  const items = page.getByRole("region", { name: "Items" });
  // Also in a small window, the reason leaves room for the Items list.
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1024, height: 720 },
    { width: 800, height: 600 },
  ]) {
    await page.setViewportSize(size);
    await whole(`Failed · ${why}`);
    // When it wraps, its last line isn't one word on its own.
    const last = await page
      .getByText(`Failed · ${why}`, { exact: true })
      .evaluate((line) => {
        const tops: number[] = [];
        const texts = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let text = texts.nextNode(); text; text = texts.nextNode()) {
          for (const word of (text as Text).data.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(text, word.index);
            range.setEnd(text, word.index + word[0].length);
            tops.push(range.getBoundingClientRect().top);
          }
        }
        const bottom = Math.max(...tops);
        return tops.filter((top) => top === bottom).length;
      });
    expect(last).toBeGreaterThan(1);
    for (const position of [1, 2]) {
      await expect(
        items.getByRole("cell", { name: `Page ${String(position)} · ` }),
      ).toBeInViewport({ ratio: 1 });
    }
  }
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await accessible(page);
});
