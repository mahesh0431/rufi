// Reading documents on the screens, on the real core with a scripted reader
// (tests/fake-reader.ts): files wait in the chat box until Send, then one
// reply has Rufi's reader copying the pages and Rufi AI's scripted sort and
// answer; Stop and a failure end the reply before the AI, with Retry; Retry
// on the Documents page puts a read again chip in the box; the model and
// effort chosen in Settings; View reading with the reader's copies.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { SIGNED_OUT } from "../../server/src/agent/codex/appserver.ts";
import { SignedOut } from "../../server/src/agent/runtime.ts";
import type { Scenario } from "../../server/tests/fake-codex.ts";
import { readPage, scriptedReader } from "../../server/tests/fake-reader.ts";
import { backupsPath, makeBackup } from "../../server/src/core/store/backup.ts";
import { restore } from "../../server/src/core/store/restore.ts";
import { expect, FILE_WORK_MS, Rufi, sendFiles, test } from "./rufi.ts";

// Wide enough for the Documents page beside the chat panel.
test.use({ viewport: { width: 2000, height: 800 } });

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
            {
              id: "$document",
              pages: [1, 2],
              kind: "lab_report",
              date: "2026-08-12",
            },
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
  await page.getByRole("link", { name: "Documents" }).click();
}

/** The fictional report, as the picker gives it. */
async function report() {
  return {
    name: "sunrise-labs-august.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(REPORT),
  };
}

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });
const log = (page: Page) => chat(page).getByRole("log", { name: "Messages" });
/** The chips in the box (a sent message shows its own). */
const chips = (page: Page) =>
  chat(page)
    .locator("form")
    .getByRole("list", { name: "Added to this message" })
    .getByRole("listitem");
/** A click outside the chat panel steps back to the bar: open it again. */
const reopen = (page: Page) =>
  chat(page)
    .getByRole("button", { name: /^Open the chat/ })
    .click();
/** The rows of the reply's open Activity (the last one). */
const steps = (page: Page) =>
  log(page)
    .getByRole("list", { name: "Activity" })
    .last()
    .locator(":scope > li");
const row = (page: Page) =>
  page.getByRole("row").filter({ hasText: "sunrise-labs-august.pdf" });

test("a file waits in the box until Send; then one reply copies its pages as Rufi's reader, Rufi AI sorts it and answers, and View reading shows the copies", async ({
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
  await opened(page, rufi, reader, SORT);
  await page
    .getByLabel("Choose documents", { exact: true })
    .setInputFiles(await report());

  // In the box by its name, and nowhere else: not listed, not read.
  await expect(chips(page)).toHaveText(["sunrise-labs-august.pdf"]);
  await expect(page.getByText("No documents yet")).toBeVisible();
  expect(reader.runs).toHaveLength(0);
  await accessible(page);

  await chat(page)
    .getByRole("textbox", { name: "Message to Rufi" })
    .fill("What is my haemoglobin?");
  await chat(page).getByRole("button", { name: "Send" }).click();

  // The reply starts with Rufi's reader counting pages; the Documents page
  // shows the reading and its copies so far.
  await expect(log(page)).toContainText("What is my haemoglobin?");
  await expect(steps(page).first()).toContainText(
    "Rufi's reader · sunrise-labs-august.pdf",
  );
  await expect(steps(page).first()).toContainText("1 of 2 pages");
  await expect(row(page)).toContainText("Reading · read 1 of 2");
  await row(page).getByRole("button", { name: "View reading" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("reading · read 1 of 2");
  await expect(sheet.locator("pre")).toHaveCount(1);
  await expect(sheet.locator("pre")).toContainText("| Haemoglobin | 13.2 |");
  await expect(sheet).toContainText("Page 2");
  await accessible(page);
  await sheet.getByRole("button", { name: "Close" }).click();
  await reopen(page);

  // The same reply goes on to the AI: its sort, then one answer.
  gate.resolve(undefined);
  await expect(log(page).locator(".reply")).toHaveCount(1);
  await expect(log(page).locator(".reply")).toContainText("ok:");
  await log(page)
    .getByRole("button", { name: /^Activity · / })
    .click();
  // Rufi's part first, then the AI's own steps.
  await expect(steps(page).nth(0)).toHaveText(
    /Rufi's reader · sunrise-labs-august\.pdf.*2 pages/,
  );
  await expect(steps(page).nth(1)).toHaveText(/rufi\.sort_documents/);
  await expect(row(page)).toContainText("Not saved · 2 results");

  // The document's page has the same copies, both pages.
  await row(page)
    .getByRole("link", { name: "sunrise-labs-august.pdf" })
    .click();
  await expect(page.getByRole("region", { name: "Items" })).toContainText(
    "2 results · 0 worth a look",
  );
  await page.getByRole("button", { name: "View reading" }).click();
  await expect(sheet).toContainText("sunrise-labs-august.pdf · read");
  await expect(sheet.locator("pre")).toHaveCount(2);
  await expect(sheet.locator("pre").nth(1)).toContainText("| Haemoglobin |");
});

test("a Stop in Rufi's reader ends the reply before the AI with Retry, no waiting message; Retry goes on and the AI answers once; restored from a backup, the message waits with Send and Remove", async ({
  page,
  rufi,
}) => {
  const reader = scriptedReader([
    async (turn) => {
      await turn.look(1);
      await turn.save(1, readPage());
      await turn.stopped();
      return { end: { status: "interrupted", reason: "stopped" } };
    },
    async (turn) => {
      await turn.look(2);
      await turn.save(2, readPage());
      return undefined;
    },
    // The restored Rufi's reading.
    async (turn) => {
      await turn.look(2);
      await turn.save(2, readPage());
      return undefined;
    },
  ]);
  await opened(page, rufi, reader, SORT);
  await sendFiles(page, await report(), "Sort this please");

  await expect(row(page)).toContainText("Reading · read 1 of 2");
  // A backup made now has the message as Rufi reads it.
  const reading = await makeBackup(rufi.home, new Date());
  await chat(page).getByRole("button", { name: "Stop" }).click();
  await expect(log(page)).toContainText("Stopped. · read 1 of 2");
  // The AI never got the message; the message isn't waiting; Retry is.
  await expect(log(page).locator(".reply")).toHaveCount(0);
  await expect(
    chat(page).getByRole("region", { name: "Waiting messages" }),
  ).toHaveCount(0);
  await log(page)
    .getByRole("button", { name: /^Activity · / })
    .click();
  await expect(steps(page).first()).toContainText("stopped · 1 of 2");
  // A backup made now has the message waiting for Retry.
  const stopped = await makeBackup(rufi.home, new Date());

  await log(page).getByRole("button", { name: "Retry" }).click();
  await expect(log(page).locator(".reply")).toHaveCount(1);
  // Your message shows once, though it was sent twice.
  await expect(
    log(page).getByText("Sort this please", { exact: true }),
  ).toHaveCount(1);
  await expect(row(page)).toContainText("Not saved · 2 results");

  // Restored from either backup, the message is in the chat with its
  // reply, and waits held from the backup, with Send and Remove: one is
  // removed, the other sent.
  for (const [backup, action] of [
    [reading, "Remove"],
    [stopped, "Send"],
  ] as const) {
    const target = await mkdtemp(join(tmpdir(), "rufi-restored-"));
    const restored = new Rufi(target);
    try {
      await restore(join(backupsPath(rufi.home), backup.name), target);
      await restored.start({ reader: reader.run, scenario: SORT });
      await page.goto(restored.link());
      await reopen(page);
      const waiting = chat(page).getByRole("region", {
        name: "Waiting messages",
      });
      await expect(waiting).toContainText("Sort this please");
      await expect(waiting).toContainText("From a backup");
      await expect(
        waiting.getByRole("button", { name: "Send", exact: true }),
      ).toBeVisible();
      await expect(
        waiting.getByRole("button", { name: "Remove" }),
      ).toBeVisible();
      await waiting.getByRole("button", { name: action, exact: true }).click();
      await expect(waiting).toHaveCount(0);
      await expect(log(page).locator(".reply")).toHaveCount(
        action === "Send" ? 1 : 0,
      );
    } finally {
      await restored.close();
      await rm(target, { recursive: true, force: true });
    }
  }
});

test("View reading says where a reading is while the reader's work loads; Retry on the Documents page reads only the pages that couldn't be read, when sent", async ({
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
  await opened(page, rufi, reader, {
    callsByTurn: [
      [
        {
          id: "sort-first",
          tool: "sort_documents",
          arguments: {
            document: "$document",
            documents: [{ id: "$document", pages: [1, 2], kind: "lab_report" }],
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
  const sheet = page.getByRole("dialog");
  const title = sheet.getByRole("heading", { level: 2 });
  const view = () =>
    row(page).getByRole("button", { name: "View reading" }).click();

  await sendFiles(page, await report());
  await view();
  await expect(title).toHaveText(
    /^sunrise-labs-august\.pdf · reading · read 0 of 2$/,
  );
  await accessible(page);
  held.work.resolve(undefined);
  await expect(title).toHaveText(
    /^sunrise-labs-august\.pdf · reading · read 0 of 2 · under a minute$/,
  );
  await expect(sheet.getByText("not read yet")).toHaveCount(2);
  await sheet.getByRole("button", { name: "Close" }).click();
  first.resolve(undefined);

  // Retry puts the file in the box; only Send reads: page 2 alone, its
  // progress counting one page, never "page 1".
  held.work = Promise.withResolvers<undefined>();
  await row(page).getByRole("button", { name: "Retry" }).click();
  await expect(chips(page)).toHaveText([
    "sunrise-labs-august.pdf · read again",
  ]);
  await chat(page).getByRole("button", { name: "Send" }).click();
  await view();
  await expect(title).toHaveText(
    /^sunrise-labs-august\.pdf · reading · read 0 of 1$/,
  );
  held.work.resolve(undefined);
  await sheet.getByRole("button", { name: "Close" }).click();
  again.resolve(undefined);
  await reopen(page);
  await expect(log(page).locator(".reply")).toHaveCount(2);
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

  await page.getByRole("link", { name: "Documents" }).click();
  await sendFiles(page, await report());
  await expect(
    page.getByRole("cell", { name: /Not saved · 2 results/ }),
  ).toBeVisible({ timeout: FILE_WORK_MS });
  expect(reader.runs.map(({ model, effort }) => ({ model, effort }))).toEqual([
    { model: "gpt-5.5", effort: "high" },
  ]);
});

test("keeps unreadable pages to check and reserves Nothing to save for a completed empty reading; Retry reads nothing until Send", async ({
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
  // Rufi AI sorts each reading: nothing to draft either time. The page
  // read again joins its document as it is.
  const sort = (id: string, pages: number[], kind?: string) => [
    {
      id,
      tool: "sort_documents",
      arguments: {
        document: "$document",
        documents: [
          { id: "$document", pages, ...(kind !== undefined && { kind }) },
        ],
        drafts: [],
      },
    },
  ];
  await opened(page, rufi, reader, {
    callsByTurn: [sort("sort-first", [1, 2], "other"), sort("sort-again", [1])],
  });
  await sendFiles(page, await report());
  const status = row(page).getByRole("cell").nth(4); // Status
  await expect(status).toContainText("To check", { timeout: FILE_WORK_MS });
  await expect(status).not.toContainText("Nothing to save");

  await status.getByRole("button", { name: "Retry" }).click();
  await expect(chips(page)).toHaveText([
    "sunrise-labs-august.pdf · read again",
  ]);
  expect(reader.runs).toHaveLength(1);
  await expect(status).toContainText("To check");
  await chat(page).getByRole("button", { name: "Send" }).click();
  await expect(status).toContainText("Nothing to save");
  await expect(status.getByRole("button", { name: "Retry" })).toBeHidden();
});

test("a reading that failed signed out ends the reply with its reason in full, in View reading and on the document page; Retry goes on and the AI answers", async ({
  page,
  rufi,
}) => {
  const why = SIGNED_OUT;
  const reader = scriptedReader([
    () => Promise.reject(new SignedOut(why)),
    async (turn) => {
      for (const number of [1, 2]) {
        await turn.look(number);
        await turn.save(number, readPage());
      }
      return undefined;
    },
  ]);
  await opened(page, rufi, reader, SORT);
  await sendFiles(page, await report());
  await expect(log(page)).toContainText(
    `Couldn't read sunrise-labs-august.pdf · ${why} · read 0 of 2`,
  );
  await expect(log(page).locator(".reply")).toHaveCount(0);
  await expect(row(page)).toContainText("Failed · read 0 of 2");
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

  await row(page).getByRole("button", { name: "View reading" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { level: 2 })).toHaveText(
    "sunrise-labs-august.pdf · failed · read 0 of 2",
  );
  await whole(why);
  await accessible(page);
  await sheet.getByRole("button", { name: "Close" }).click();

  await row(page)
    .getByRole("link", { name: "sunrise-labs-august.pdf" })
    .click();
  await whole(`Failed · ${why}`);
  await accessible(page);

  await reopen(page);
  await log(page).getByRole("button", { name: "Retry" }).click();
  await expect(log(page).locator(".reply")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Items" })).toContainText(
    "2 results",
  );
});
