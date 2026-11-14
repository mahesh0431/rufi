// A question card Rufi AI asked with (docs/adr/0036), on the real core and
// the scripted Codex: the card shows Rufi AI's words; a click on an answer,
// by mouse or keyboard, is Asha's message quoting the card and leaves the
// box's words alone; the card shows the answer on its way (waiting, not
// sent with Retry, refused) and then the answer chosen; Reply puts the
// card's quote in the box; a quote goes back to its card, also pages up;
// and a card of a kind Rufi doesn't draw shows its text.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page, Request } from "@playwright/test";
import { SIGNED_OUT as SIGNED_OUT_WORDS } from "@rufi/contracts";
import { expect, openSettings, SIGNED_OUT, test, type Rufi } from "./rufi.ts";

const TIME = "2026-10-10T09:00:00Z";

/** A turn of Asha's chat: her message and Rufi AI's reply. */
const turn = (n: number, ask: string, reply: string) => `
  INSERT INTO turns (id, person_id, chat_id, agent_turn_id, thread_id, model, status, started_at, ended_at) VALUES
    ('t-${String(n)}', 'asha', 'c-asha', 'seeded-${String(n)}', 'thread-a', 'gpt-6-astra', 'completed', '${TIME}', '${TIME}');
  INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, revision, created_at, updated_at) VALUES
    ('m-${String(n)}', 'asha', 'c-asha', ${String(n * 3 - 2)}, 't-${String(n)}', 'message', '${ask}', 1, '${TIME}', '${TIME}'),
    ('r-${String(n)}', 'asha', 'c-asha', ${String(n * 3 - 1)}, 't-${String(n)}', 'reply', '${reply}', 1, '${TIME}', '${TIME}');`;

/** A card at the end of turn `n`, as ask writes it: its text and its words. */
const card = (
  n: number,
  id: string,
  words: {
    kind?: string;
    key: string;
    details?: string;
    question: string;
    answers?: string[];
  },
) => {
  const text = [
    `**${words.key}**`,
    ...(words.details === undefined ? [] : [words.details]),
    words.question,
    ...(words.answers ? [words.answers.map((a) => `- ${a}`).join("\n")] : []),
  ].join("\n\n");
  return `
  INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, card, revision, created_at, updated_at) VALUES
    ('${id}', 'asha', 'c-asha', ${String(n * 3)}, 't-${String(n)}', 'question', '${text}', '${JSON.stringify({ kind: "choice", ...words })}', 1, '${TIME}', '${TIME}');`;
};

const VISIT = {
  key: "Next visit",
  details: "- Dr Rao, City Clinic\n- Tue 20 Oct, 10:00",
  question: "Book this visit?",
  answers: ["Book", "Not now"],
};
const LIPIDS = {
  key: "Lipid panel, 12 Aug 2026",
  details: "- LDL 138 mg/dL\n- HDL 41 mg/dL",
  question: "Save these 2 results to your health record?",
  answers: ["Save", "Not now"],
};

/** Asha's chat: a reply and the card Rufi AI asked with after it. */
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
const cardOf = (page: Page, key: string) =>
  log(page).getByRole("region", { name: key });
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

/** The ids of the card clicks the page posts. */
const clicks = (page: Page) => {
  const ids: string[] = [];
  page.on("request", (request: Request) => {
    if (request.method() === "POST" && request.url().endsWith("/messages")) {
      ids.push((request.postDataJSON() as { id: string }).id);
    }
  });
  return ids;
};

test("Rufi AI asks with ask: the card it gives shows in the chat, and a click answers it, quoting the card", async ({
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
              answers: ["City Clinic", "Lakeside Clinic", "Not now"],
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
  await box(page).fill("Where can I get my scan?");
  await box(page).press("Enter");

  const asked = cardOf(page, "Ultrasound clinic");
  await expect(asked).toContainText("Which clinic suits you?");
  await asked.getByRole("button", { name: "Lakeside Clinic" }).click();
  await expect(asked).toMatchAriaSnapshot(
    `- paragraph: "Answered: Lakeside Clinic"`,
  );
  await expect(quoteOf(page, "Ultrasound clinic")).toBeVisible();
});

test("a card shows Rufi AI's words; Reply quotes it in the box and leaves it open; a click or Enter on an answer sends it quoting the card, once, keeping the box's words, and the card shows it chosen", async ({
  page,
  rufi,
}) => {
  await openChat(page, rufi, ASKED);
  const visit = cardOf(page, "Next visit");
  await expect(visit).toContainText("Dr Rao, City Clinic");
  await expect(visit.getByRole("listitem")).toHaveText([
    "Dr Rao, City Clinic",
    "Tue 20 Oct, 10:00",
  ]);
  await expect(visit).toContainText("Book this visit?");
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);

  // Reply: the card's quote goes into the box, for Asha's own words; the
  // card stays open.
  await visit.getByRole("button", { name: "Reply" }).click();
  await expect(box(page)).toBeFocused();
  await expect(
    page.getByRole("list", { name: "Added to this message" }),
  ).toContainText("Next visit");
  await box(page).fill("Can it be Wednesday?");
  await expect(visit.getByRole("button", { name: "Book" })).toBeVisible();

  // An answer by keyboard is Asha's message, quoting the card; the box keeps
  // her words and its quote.
  await visit.getByRole("button", { name: "Book" }).focus();
  await page.keyboard.press("Enter");
  await expect(visit).toContainText("Book");
  await expect(visit.getByRole("button", { name: "Book" })).toHaveCount(0);
  await expect(visit.getByRole("button", { name: "Not now" })).toHaveCount(0);
  await expect(quoteOf(page, "Next visit")).toBeVisible();
  await expect(box(page)).toHaveValue("Can it be Wednesday?");
  await expect(
    page.getByRole("list", { name: "Added to this message" }),
  ).toContainText("Next visit");
  await expect
    .poll(() =>
      rufi
        .given("> [Next visit](rufi:/chat/questions/q-visit)")
        .catch(() => undefined),
    )
    .toContain("Book");

  // A double click sends one answer.
  const ids = clicks(page);
  const lipids = cardOf(page, "Lipid panel, 12 Aug 2026");
  await lipids.getByRole("button", { name: "Not now" }).dblclick();
  await expect(lipids.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(quoteOf(page, "Lipid panel, 12 Aug 2026")).toHaveCount(1);
  expect(ids).toHaveLength(1);

  // After a reload, the card still shows the answer chosen.
  await page.reload();
  await expect(cardOf(page, "Next visit")).toMatchAriaSnapshot(
    `- paragraph: "Answered: Book"`,
  );
  await expect(
    cardOf(page, "Next visit").getByRole("button", { name: "Book" }),
  ).toHaveCount(0);
});

test("while a reply runs, a click with Queue chosen waits, and its card says so; removed, the card is open again", async ({
  page,
  rufi,
}) => {
  await openChat(page, rufi, ASKED);
  const settings = await openSettings(page, "Chat");
  await settings.getByRole("radio", { name: "Queue" }).check();
  await expect(settings.getByRole("radio", { name: "Queue" })).toBeChecked();
  await page.keyboard.press("Escape");
  await box(page).fill("hang");
  await box(page).press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  const visit = cardOf(page, "Next visit");
  await visit.getByRole("button", { name: "Book" }).click();
  await expect(visit).toContainText("Book · Waiting");
  const waiting = page.getByRole("region", { name: "Waiting messages" });
  await expect(waiting).toContainText("Next visit");
  await expect(waiting).toContainText("Book");
  await waiting.getByRole("button", { name: "Remove" }).click();
  await expect(waiting).toHaveCount(0);
  await expect(visit.getByRole("button", { name: "Book" })).toBeVisible();
});

test("a click the core took whose answer was lost waits, with no Retry; removed from the queue, the card is open and a new click goes", async ({
  page,
  rufi,
}) => {
  await openChat(page, rufi, ASKED);
  const settings = await openSettings(page, "Chat");
  await settings.getByRole("radio", { name: "Queue" }).check();
  await expect(settings.getByRole("radio", { name: "Queue" })).toBeChecked();
  await page.keyboard.press("Escape");
  await box(page).fill("hang");
  await box(page).press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  // The click reaches the core; its answer never reaches the page.
  await page.route("**/messages", async (route) => {
    await route.fetch();
    await route.abort();
  });
  const visit = cardOf(page, "Next visit");
  await visit.getByRole("button", { name: "Book" }).click();
  await expect(visit).toContainText("Book · Waiting");
  await expect(visit.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.unroute("**/messages");

  const waiting = page.getByRole("region", { name: "Waiting messages" });
  await waiting.getByRole("button", { name: "Remove" }).click();
  await expect(waiting).toHaveCount(0);
  await expect(visit).not.toContainText("Not sent");
  await visit.getByRole("button", { name: "Not now" }).click();
  await expect(visit).toContainText("Not now · Waiting");
});

test("a click whose answer is lost says Not sent and keeps the box; Retry sends it by the same id; a refused one says Can't send and stays open", async ({
  page,
  rufi,
}) => {
  await openChat(page, rufi, ASKED);
  await box(page).fill("Keep this");
  const ids = clicks(page);

  await page.route("**/messages", (route) => route.abort());
  const visit = cardOf(page, "Next visit");
  await visit.getByRole("button", { name: "Book" }).click();
  await expect(visit).toContainText("Book · Not sent");
  await expect(box(page)).toHaveValue("Keep this");
  await page.unroute("**/messages");
  await visit.getByRole("button", { name: "Retry" }).click();
  await expect(quoteOf(page, "Next visit")).toBeVisible();
  await expect(visit.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(visit.getByRole("button", { name: "Book" })).toHaveCount(0);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);

  const refusal =
    "Something added to this message isn't in this person's record. Take it out of the message and add it again.";
  await page.route("**/messages", (route) =>
    route.fulfill({ status: 400, json: { error: refusal } }),
  );
  const lipids = cardOf(page, "Lipid panel, 12 Aug 2026");
  await lipids.getByRole("button", { name: "Save" }).click();
  await expect(lipids.getByRole("alert")).toHaveText("Can't send");
  await expect(lipids.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(box(page)).toHaveValue("Keep this");
});

test("signed out, a click says so on the card, with Sign in; the box keeps its words", async ({
  page,
  rufi,
}) => {
  rufi.codex = SIGNED_OUT;
  await openChat(page, rufi, ASKED);
  await box(page).fill("Keep this");
  const lipids = cardOf(page, "Lipid panel, 12 Aug 2026");
  await lipids.getByRole("button", { name: "Save" }).click();
  await expect(lipids.getByRole("alert")).toHaveText(
    `${SIGNED_OUT_WORDS}Sign in`,
  );
  await expect(lipids.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(box(page)).toHaveValue("Keep this");
  await lipids.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/sign-in/);
});

test("a quote goes back to its card, loading earlier pages until it is there; a card of a kind Rufi doesn't draw shows its text", async ({
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
  await expect(cardOf(page, "Next scan")).toHaveCount(0);
  await expect(cardOf(page, "Next visit")).toHaveCount(0);

  await quoteOf(page, "Next visit").click();
  const visit = cardOf(page, "Next visit");
  await expect(visit).toBeFocused();
  await expect(visit).toBeInViewport();
  await expect(visit).toContainText("Book");
});
