// Open work in Needs you on the real core: a question Rufi asked waits there
// with nothing else waiting; Answer puts its chip in the chat box and sends
// nothing; Later hides it and Bring back shows it again; Drop closes it and
// Reopen opens it again; the unfinished task waits behind its quiet line.
// Another window sees each change through the chat's stream, and a click
// on a row that changed in another window shows how it is now.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./rufi.ts";

const QUESTION =
  "Save HbA1c 6.1 % from Sunrise Labs, 12 Mar 2026, as a lab result?";

const OPEN_WORK = `
  INSERT INTO turns (id, person_id, chat_id, agent_turn_id, thread_id, model, status, started_at)
    VALUES ('t-asked', 'asha', 'c-asha', 'agent-asked', 'thread-old', 'gpt-6.1-sol', 'completed', '2026-10-10T09:00:00Z');
  INSERT INTO open_items (id, person_id, chat_id, turn_id, kind, text, created_at, updated_at)
    VALUES ('item-q', 'asha', 'c-asha', 't-asked', 'question', '${QUESTION}', '2026-10-10T09:00:00Z', '2026-10-10T09:00:00Z'),
           ('item-t', 'asha', 'c-asha', 't-asked', 'task', 'Compare the last three lipid panels', '2026-10-10T09:01:00Z', '2026-10-10T09:01:00Z');
  INSERT INTO open_item_changes (person_id, item_id, version, at, by, change, chat_id, call_id, turn_id, request, status)
    VALUES ('asha', 'item-q', 1, '2026-10-10T09:00:00Z', 'ai', 'added', 'c-asha', 'call-q', 't-asked', '{}', 'open'),
           ('asha', 'item-t', 1, '2026-10-10T09:01:00Z', 'ai', 'added', 'c-asha', 'call-t', 't-asked', '{}', 'open');
`;

const needsYou = (page: Page) =>
  page.getByRole("region", { name: "Needs you" });
const asked = (page: Page) =>
  needsYou(page).getByRole("list", { name: "Rufi asked" });

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

test("a question Rufi asked waits in Needs you: Answer, Later, Bring back, Drop and Reopen", async ({
  page,
  rufi,
}) => {
  await rufi.family(OPEN_WORK);
  await rufi.start();
  await page.goto(rufi.link());

  await expect(asked(page).getByRole("listitem")).toHaveText([
    new RegExp(`^${QUESTION.replace(/[.?%]/g, "\\$&")}10 Oct 2026`),
  ]);
  await accessible(page);

  // Answer: its chip goes in the box; nothing is sent.
  await asked(page)
    .getByRole("button", { name: /^Answer: Save HbA1c/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Open the chat" }),
  ).toHaveAccessibleDescription(/^Save HbA1c 6\.1 %/);
  expect(rufi.query("SELECT count(*) AS n FROM chat_queue")).toEqual([
    { n: 0 },
  ]);

  // Later: hidden, and under Later (1) until it is brought back.
  await asked(page)
    .getByRole("button", { name: /^Later: / })
    .click();
  await expect(asked(page)).toHaveCount(0);
  await needsYou(page).getByRole("button", { name: "Later (1)" }).click();
  const later = needsYou(page).getByRole("list", { name: "Later" });
  await expect(later).toContainText(/Back on \d+ \w+ \d{4}/);
  await later.getByRole("button", { name: /^Bring back: / }).click();
  await expect(asked(page).getByRole("listitem")).toHaveCount(1);

  // Drop: closed this week, with how it closed, until it is reopened.
  await asked(page)
    .getByRole("button", { name: /^Drop: / })
    .click();
  await expect(asked(page)).toHaveCount(0);
  await needsYou(page)
    .getByRole("button", { name: "Closed this week (1)" })
    .click();
  const closed = needsYou(page).getByRole("list", {
    name: "Closed this week",
  });
  await expect(closed.getByRole("listitem")).toContainText("Dropped");
  await accessible(page);
  await closed.getByRole("button", { name: /^Reopen: / }).click();
  await expect(asked(page).getByRole("listitem")).toHaveCount(1);

  // The task waits behind its quiet line, with Continue.
  await needsYou(page)
    .getByRole("button", { name: "Rufi has 1 unfinished task" })
    .click();
  await expect(
    needsYou(page)
      .getByRole("list", { name: "Unfinished tasks" })
      .getByRole("button", { name: /^Continue: Compare/ }),
  ).toBeVisible();
  expect(
    rufi.query(
      "SELECT item_id, change, by FROM open_item_changes WHERE version > 1 ORDER BY item_id, version",
    ),
  ).toEqual([
    { item_id: "item-q", change: "later", by: "person" },
    { item_id: "item-q", change: "brought_back", by: "person" },
    { item_id: "item-q", change: "dropped", by: "person" },
    { item_id: "item-q", change: "reopened", by: "person" },
  ]);
});

test("another window sees a change at once, and a click on a row that changed there shows it as it is now", async ({
  page,
  context,
  rufi,
}) => {
  await rufi.family(OPEN_WORK);
  await rufi.start();
  await page.goto(rufi.link());
  const other = await context.newPage();
  await other.goto(rufi.link());
  // A third window hears nothing from the stream: it stays as it was read.
  const stale = await context.newPage();
  await stale.route("**/chat/stream", (route) => route.abort());
  await stale.goto(rufi.link());
  await expect(asked(other).getByRole("listitem")).toHaveCount(1);
  await expect(asked(stale).getByRole("listitem")).toHaveCount(1);

  await asked(page)
    .getByRole("button", { name: /^Drop: / })
    .click();

  await expect(asked(other)).toHaveCount(0);
  await expect(
    needsYou(other).getByRole("button", { name: "Closed this week (1)" }),
  ).toBeVisible();

  await asked(stale)
    .getByRole("button", { name: /^Later: / })
    .click();
  await expect(needsYou(stale).getByRole("status")).toHaveText(
    "“Save HbA1c 6.1 % from Sunrise Labs, 12 Mar 2026, as a lab r…” changed in another window. It is dropped now.",
  );
  await expect(asked(stale)).toHaveCount(0);
  expect(
    rufi.query("SELECT status, version FROM open_items WHERE id = 'item-q'"),
  ).toEqual([{ status: "dropped", version: 2 }]);
});
