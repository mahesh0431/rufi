// Rufi AI's open question (docs/adr/0036), on the real core and the
// scripted Codex: the card isn't drawn in the chat; the question panel
// takes the box's place, with Rufi AI's words, Recommended only on the
// answer it marks, and a field for Asha's own answer. A click on an answer,
// by mouse or keyboard, or her own answer sent, is her message quoting the
// card; the panel says how it goes (Not sent with Retry, Can't send,
// signed out) and goes once the chat has it, and the box is back with its
// words. Minimise folds it to a line; in the bar the line opens the chat.
// A quote opens the whole question, also from an earlier page; a card of a
// kind Rufi doesn't draw shows its text.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page, Request } from "@playwright/test";
import { SIGNED_OUT as SIGNED_OUT_WORDS } from "@rufi/contracts";
import { NOTE } from "../../server/tests/fake-model.ts";
import { expect, openSettings, SIGNED_OUT, test, type Rufi } from "./rufi.ts";

const TIME = "2026-10-10T09:00:00Z";

/** A turn of Asha's chat: her message and Rufi AI's reply. */
const turn = (n: number, ask: string, reply: string) => `
  INSERT INTO turns (id, person_id, chat_id, agent_turn_id, thread_id, model, status, started_at, ended_at) VALUES
    ('t-${String(n)}', 'asha', 'c-asha', 'seeded-${String(n)}', 'thread-a', 'gpt-6-astra', 'completed', '${TIME}', '${TIME}');
  INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, revision, created_at, updated_at) VALUES
    ('m-${String(n)}', 'asha', 'c-asha', ${String(n * 3 - 2)}, 't-${String(n)}', 'message', '${ask}', 1, '${TIME}', '${TIME}'),
    ('r-${String(n)}', 'asha', 'c-asha', ${String(n * 3 - 1)}, 't-${String(n)}', 'reply', '${reply}', 1, '${TIME}', '${TIME}');`;

interface Words {
  kind?: string;
  key: string;
  details?: string;
  question: string;
  answers?: { label: string; description?: string; recommended?: boolean }[];
}

/** A card at the end of turn `n`, as ask writes it: its text and its words. */
const card = (n: number, id: string, words: Words) => {
  const text = [
    `**${words.key}**`,
    ...(words.details === undefined ? [] : [words.details]),
    words.question,
    ...(words.answers
      ? [words.answers.map((a) => `- ${a.label}`).join("\n")]
      : []),
  ].join("\n\n");
  return `
  INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, card, revision, created_at, updated_at) VALUES
    ('${id}', 'asha', 'c-asha', ${String(n * 3)}, 't-${String(n)}', 'question', '${text}', '${JSON.stringify({ kind: "choice", ...words })}', 1, '${TIME}', '${TIME}');`;
};

const VISIT: Words = {
  key: "Next visit",
  details: "- Dr Rao, City Clinic\n- Tue 20 Oct, 10:00",
  question: "Book this visit?",
  answers: [{ label: "Book" }, { label: "Not now" }],
};
const LIPIDS: Words = {
  key: "Lipid panel, 12 Aug 2026",
  details: "- LDL 138 mg/dL\n- HDL 41 mg/dL",
  question: "Save these 2 results to your health record?",
  answers: [
    {
      label: "Save",
      description: "Adds both to your health record",
      recommended: true,
    },
    { label: "Not now" },
  ],
};

/** Asha's chat: an answered card, then a reply and the card still open. */
const ASKED = [
  turn(1, "When can I see Dr Rao?", "Dr Rao has Tuesday free."),
  card(1, "q-visit", VISIT),
  turn(2, "My lipid panel came back", "Your LDL is above the range."),
  card(2, "q-lipids", LIPIDS),
  "UPDATE chats SET revision = 1;",
].join("\n");

const log = (page: Page) => page.getByRole("log", { name: "Messages" });
const box = (page: Page) =>
  page.getByRole("textbox", { name: "Message to Rufi" });
const panelOf = (page: Page, key: string) =>
  page.getByRole("region", { name: `Rufi asks · ${key}` });
const ownAnswer = (page: Page) =>
  page.getByRole("textbox", { name: "Your own answer" });
const quoteOf = (page: Page, key: string) =>
  log(page).getByRole("button", { name: key, exact: true });

/** The chat's page, opened from the sidebar. */
async function openChat(page: Page, rufi: Rufi, ...rows: string[]) {
  await rufi.family(...rows);
  await rufi.start();
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Chat with Rufi" })
    .click();
  await expect(log(page)).toBeVisible();
}

/** The ids of the answers the page posts. */
const posts = (page: Page) => {
  const ids: string[] = [];
  page.on("request", (request: Request) => {
    if (request.method() === "POST" && request.url().endsWith("/messages")) {
      ids.push((request.postDataJSON() as { id: string }).id);
    }
  });
  return ids;
};

test("Rufi AI asks with ask: the text it wrote first stays in the chat, the card takes the box's place, and a click answers it, quoting the card; the box comes back with its words", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start({
    scenario: {
      callsByText: {
        "Where can I get my scan": [
          {
            id: "call-ask",
            tool: "ask",
            arguments: {
              key: "Ultrasound clinic",
              details:
                "- City Clinic, Tue 20 Oct\n- Lakeside Clinic, Thu 22 Oct",
              question: "Which clinic suits you?",
              answers: [
                { label: "City Clinic" },
                {
                  label: "Lakeside Clinic",
                  description: "Closer to home",
                },
                { label: "Not now" },
              ],
            },
          },
        ],
      },
    },
  });
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Chat with Rufi" })
    .click();
  await box(page).fill("Where can I get my scan? note first");
  await box(page).press("Enter");
  await box(page).fill("Also, my ferritin");

  const asked = panelOf(page, "Ultrasound clinic");
  await expect(asked).toContainText("Which clinic suits you?");
  await expect(asked).toContainText("Closer to home");
  await expect(box(page)).toHaveCount(0);
  // Nothing is recommended: Rufi AI marked none.
  await expect(asked).not.toContainText("Recommended");
  // The words before the card stay in the chat; the card isn't there.
  await expect(page.locator(".reply").last()).toContainText("ok:");
  await expect(page.locator(".reply", { hasText: NOTE })).toBeVisible();
  await expect(log(page)).not.toContainText("Which clinic suits you?");

  await asked.getByRole("button", { name: "Lakeside Clinic" }).click();
  await expect(asked).toHaveCount(0);
  await expect(quoteOf(page, "Ultrasound clinic")).toBeVisible();
  await expect(box(page)).toHaveValue("Also, my ferritin");
});

test("the open question shows Rufi AI's words with Recommended on the answer it marks; a click or Enter sends it once, quoting the card; after a reload the box is back", async ({
  page,
  rufi,
}) => {
  await openChat(page, rufi, ASKED);
  // The answered card shows nowhere; the open one is the panel.
  await expect(page.getByRole("region", { name: /^Rufi asks/ })).toHaveCount(1);
  const lipids = panelOf(page, "Lipid panel, 12 Aug 2026");
  await expect(lipids.getByRole("listitem")).toContainText([
    "LDL 138 mg/dL",
    "HDL 41 mg/dL",
  ]);
  await expect(lipids).toContainText(
    "Save these 2 results to your health record?",
  );
  await expect(lipids.getByRole("button", { name: "Save" })).toContainText(
    "Recommended",
  );
  await expect(
    lipids.getByRole("button", { name: "Not now" }),
  ).not.toContainText("Recommended");
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);

  // By keyboard, once: a double press sends one answer.
  const ids = posts(page);
  await lipids.getByRole("button", { name: "Save" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter").catch(() => undefined);
  await expect(lipids).toHaveCount(0);
  await expect(box(page)).toBeVisible();
  await expect(quoteOf(page, "Lipid panel, 12 Aug 2026")).toHaveCount(1);
  expect(ids).toHaveLength(1);
  await expect
    .poll(() =>
      rufi
        .given("> [Lipid panel, 12 Aug 2026](rufi:/chat/questions/q-lipids)")
        .catch(() => undefined),
    )
    .toContain("Save");

  await page.reload();
  await expect(box(page)).toBeVisible();
  await expect(page.getByRole("region", { name: /^Rufi asks/ })).toHaveCount(0);
});

test("Asha's own answer goes as her message quoting the card, with no answer chosen; the box keeps its words", async ({
  page,
  rufi,
}) => {
  // Her draft from before the question stays the box's.
  await openChat(
    page,
    rufi,
    ASKED,
    `INSERT OR REPLACE INTO drafts (person_id, chat_id, text, refs, updated_at) VALUES ('asha', 'c-asha', 'Half a thought', '[]', '${TIME}');`,
  );
  const lipids = panelOf(page, "Lipid panel, 12 Aug 2026");
  await expect(ownAnswer(page)).toBeFocused();
  await ownAnswer(page).fill("Save only the LDL");
  await ownAnswer(page).press("Enter");
  await expect(lipids).toHaveCount(0);
  await expect(box(page)).toHaveValue("Half a thought");
  await expect(log(page)).toContainText("Save only the LDL");
  await expect(quoteOf(page, "Lipid panel, 12 Aug 2026")).toBeVisible();
  await expect
    .poll(() =>
      rufi
        .given("> [Lipid panel, 12 Aug 2026](rufi:/chat/questions/q-lipids)")
        .catch(() => undefined),
    )
    .toContain("Save only the LDL");
  // The quote names no answer: it is Asha's own.
  await quoteOf(page, "Lipid panel, 12 Aug 2026").click();
  const sheet = page.getByRole("dialog", { name: /^Rufi asked/ });
  await expect(sheet).toContainText("Save these 2 results");
  await expect(sheet).not.toContainText("Your answer");
});

test("Minimise folds the panel to a line and the chat can be read; the line opens it again with the own answer as typed, kept through a reload; in the bar, the line opens the chat", async ({
  page,
  rufi,
}) => {
  await openChat(page, rufi, ASKED);
  const lipids = panelOf(page, "Lipid panel, 12 Aug 2026");
  await ownAnswer(page).fill("Save the LDL");
  await lipids.getByRole("button", { name: "Minimise" }).click();
  await expect(lipids).toHaveCount(0);
  const line = page.getByRole("button", {
    name: "Rufi asks · Lipid panel, 12 Aug 2026",
  });
  await expect(line).toBeVisible();
  await expect(box(page)).toHaveCount(0);
  await line.click();
  await expect(lipids).toContainText("Save these 2 results");
  // What Asha typed is still there, also after a reload.
  await expect(ownAnswer(page)).toHaveValue("Save the LDL");
  await page.reload();
  await expect(ownAnswer(page)).toHaveValue("Save the LDL");

  // On a reading page, the bar is the line, and it opens the chat.
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Overview" })
    .click();
  const dock = page.getByRole("region", { name: "Chat" });
  await dock
    .getByRole("button", { name: "Rufi asks · Lipid panel, 12 Aug 2026" })
    .click();
  await expect(
    dock.getByRole("region", { name: "Rufi asks · Lipid panel, 12 Aug 2026" }),
  ).toBeVisible();
  await expect(dock.getByRole("log", { name: "Messages" })).toBeVisible();
});

/**
 * Rufi AI asks while its reply still runs (it never ends), with Queue
 * chosen for what Asha sends meanwhile.
 */
async function askWhileReplying(page: Page, rufi: Rufi) {
  await rufi.family();
  await rufi.start({
    scenario: {
      callsByText: {
        "Check my lipids": [{ id: "call-ask", tool: "ask", arguments: LIPIDS }],
      },
    },
  });
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Chat with Rufi" })
    .click();
  const settings = await openSettings(page, "Chat");
  await settings.getByRole("radio", { name: "Queue" }).check();
  await expect(settings.getByRole("radio", { name: "Queue" })).toBeChecked();
  await page.keyboard.press("Escape");
  await box(page).fill("Check my lipids, and hang");
  await box(page).press("Enter");
  return panelOf(page, "Lipid panel, 12 Aug 2026");
}

test("while a reply runs, a click with Queue chosen waits in the queue and the box is back; removed, the panel is open again", async ({
  page,
  rufi,
}) => {
  const lipids = await askWhileReplying(page, rufi);
  await lipids.getByRole("button", { name: "Save" }).click();
  const waiting = page.getByRole("region", { name: "Waiting messages" });
  await expect(waiting).toContainText("Lipid panel, 12 Aug 2026");
  await expect(waiting).toContainText("Save");
  await expect(lipids).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await waiting.getByRole("button", { name: "Remove" }).click();
  await expect(waiting).toHaveCount(0);
  await expect(lipids.getByRole("button", { name: "Save" })).toBeVisible();
});

test("a click the core took whose response was lost waits in the queue, with no Retry; removed, the panel is open and a new click goes", async ({
  page,
  rufi,
}) => {
  const lipids = await askWhileReplying(page, rufi);
  // The click reaches the core; its answer never reaches the page.
  await page.route("**/messages", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await lipids.getByRole("button", { name: "Save" }).click();
  const waiting = page.getByRole("region", { name: "Waiting messages" });
  await expect(waiting).toContainText("Save");
  await expect(lipids).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.unroute("**/messages");

  await waiting.getByRole("button", { name: "Remove" }).click();
  await expect(waiting).toHaveCount(0);
  await expect(lipids).not.toContainText("Not sent");
  await lipids.getByRole("button", { name: "Not now" }).click();
  await expect(waiting).toContainText("Not now");
});

test("an answer whose response is lost says Not sent; Retry sends it by the same id; a refused one says Can't send and the panel stays open with Asha's words", async ({
  page,
  rufi,
}) => {
  await openChat(page, rufi, ASKED);
  const ids = posts(page);
  const lipids = panelOf(page, "Lipid panel, 12 Aug 2026");

  const refusal =
    "Something added to this message isn't in this person's record. Take it out of the message and add it again.";
  await page.route("**/messages", (route) =>
    route.fulfill({ status: 400, json: { error: refusal } }),
  );
  await ownAnswer(page).fill("Only the LDL");
  await ownAnswer(page).press("Enter");
  await expect(lipids.getByRole("alert")).toHaveText("Can't send");
  await expect(ownAnswer(page)).toHaveValue("Only the LDL");
  await page.unroute("**/messages");

  await page.route("**/messages", (route) => route.abort());
  await lipids.getByRole("button", { name: "Not now" }).click();
  await expect(lipids).toContainText("Not now · Not sent");
  await page.unroute("**/messages");
  await lipids.getByRole("button", { name: "Retry" }).click();
  await expect(lipids).toHaveCount(0);
  await expect(quoteOf(page, "Lipid panel, 12 Aug 2026")).toBeVisible();
  expect(ids).toHaveLength(3);
  expect(ids[2]).toBe(ids[1]);
});

test("signed out, an answer says so on the panel, with Sign in; back from signing in, Asha's own answer is still there", async ({
  page,
  rufi,
}) => {
  rufi.codex = SIGNED_OUT;
  await openChat(page, rufi, ASKED);
  const lipids = panelOf(page, "Lipid panel, 12 Aug 2026");
  await lipids.getByRole("button", { name: "Save" }).click();
  await expect(lipids.getByRole("alert")).toHaveText(
    `${SIGNED_OUT_WORDS}Sign in`,
  );
  await expect(lipids.getByRole("button", { name: "Save" })).toBeVisible();
  await ownAnswer(page).fill("Only the LDL");
  await lipids.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/sign-in/);
  await page.goBack();
  await expect(ownAnswer(page)).toHaveValue("Only the LDL");
});

test("a quote opens the whole question with the chosen answer marked, loading earlier pages; a card of a kind Rufi doesn't draw shows its text", async ({
  page,
  rufi,
}) => {
  const later = {
    kind: "date",
    key: "Next scan",
    question: "Which day suits you?",
  };
  const rows = [
    turn(1, "When can I see Dr Rao?", "Dr Rao has Tuesday free."),
    card(1, "q-visit", VISIT),
    ...Array.from({ length: 60 }, (_, i) =>
      turn(
        i + 2,
        `Fictional question ${String(i + 2)}`,
        `Fictional answer ${String(i + 2)}`,
      ),
    ),
    `INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, refs, revision, created_at, updated_at) VALUES
      ('m-book', 'asha', 'c-asha', 300, NULL, 'message', 'Book', '[{"ref":{"type":"question","id":"q-visit","answer":0},"label":"Next visit","detail":"Rufi AI''s question"}]', 1, '${TIME}', '${TIME}');
    UPDATE transcript_entries SET answer = '{"message":"m-book","index":0}' WHERE id = 'q-visit';
    INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, card, revision, created_at, updated_at) VALUES
      ('q-later', 'asha', 'c-asha', 301, NULL, 'question', '**Next scan**

Which day suits you?', '${JSON.stringify(later)}', 1, '${TIME}', '${TIME}');`,
    "UPDATE chats SET revision = 1;",
  ];
  await openChat(page, rufi, ...rows);
  await expect(log(page)).toContainText("Which day suits you?");
  // A kind Rufi doesn't draw is no panel: the box stays.
  await expect(box(page)).toBeVisible();

  await quoteOf(page, "Next visit").click();
  const sheet = page.getByRole("dialog", { name: "Rufi asked · Next visit" });
  await expect(sheet).toContainText("Book this visit?");
  await expect(sheet).toContainText("Dr Rao, City Clinic");
  await expect(
    sheet.getByRole("listitem").filter({ hasText: "Book" }),
  ).toHaveText("Your answer: Book");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});
