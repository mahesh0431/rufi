// A long chat on the real core: it opens at its latest page, older pages
// load as you scroll up without moving what you read, each day has its line
// in the Mac's time zone, and a quiet line shows where the AI started afresh
// or compacted its memory. The Mac here is in India on Thu 8 Oct 2026.
import type { Page } from "@playwright/test";
import { expect, test, type Rufi } from "./rufi.ts";

test.use({ timezoneId: "Asia/Kolkata" });

const NOW = new Date("2026-10-08T12:00:00+05:30");
const TURNS = 200;

/** 09:00 in India on a day of Oct 2026, and `minute` minutes after. */
const at = (day: number, minute: number) =>
  new Date(Date.UTC(2026, 9, day, 3, 30 + minute)).toISOString();

/**
 * Asha's chat with 200 fictional questions and answers: Mon 5 Oct, then
 * yesterday, then today. The AI's thread changes at question 120; it
 * compacted its memory in question 90's reply, and a compaction in 95's was
 * cut off.
 */
function longChat(): string {
  const rows: string[] = [];
  let seq = 0;
  const entry = (
    n: number,
    kind: string,
    text: string,
    time: string,
    activity = "NULL, NULL",
  ) => {
    seq += 1;
    rows.push(
      `INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, activity, status, revision, created_at, updated_at) SELECT 'e-${String(seq)}', 'asha', id, ${String(seq)}, 't-${String(n)}', '${kind}', '${text}', ${activity}, 1, '${time}', '${time}' FROM chats WHERE person_id = 'asha';`,
    );
  };
  for (let n = 1; n <= TURNS; n++) {
    const time = n <= 60 ? at(5, n) : n <= 150 ? at(7, n - 60) : at(8, n - 150);
    rows.push(
      `INSERT INTO turns (id, person_id, chat_id, agent_turn_id, thread_id, model, status, started_at, ended_at) SELECT 't-${String(n)}', 'asha', id, 'seeded-${String(n)}', '${n < 120 ? "thread-a" : "thread-b"}', 'gpt-6-astra', 'completed', '${time}', '${time}' FROM chats WHERE person_id = 'asha';`,
    );
    entry(n, "message", `Fictional question ${String(n)}`, time);
    if (n === 90 || n === 95) {
      entry(
        n,
        "activity",
        "Compacted its memory of the chat",
        time,
        n === 90 ? "'compaction', 'done'" : "'compaction', 'stopped'",
      );
    }
    entry(n, "reply", `Fictional answer ${String(n)}`, time);
  }
  rows.push("UPDATE chats SET revision = 1;");
  return rows.join("\n");
}

const log = (page: Page) => page.getByRole("log", { name: "Messages" });
const questions = (page: Page) =>
  log(page)
    .locator("[data-entry]")
    .filter({ hasText: /^Fictional question/ });
const scroller = (page: Page) => log(page).locator("xpath=../..");

/** The chat's page, opened from the sidebar. */
async function openChat(page: Page, rufi: Rufi) {
  await page.goto(rufi.link());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Chat with Rufi" })
    .click();
  await expect(log(page).locator(".reply").last()).toHaveText(
    "Fictional answer 200",
  );
}

/** Where a message is on the screen, from the top of the window. */
const topOf = async (page: Page, text: string) =>
  (await log(page).getByText(text, { exact: true }).boundingBox())?.y;

test("a long chat opens at its latest page; older pages load as you scroll up, in order, without moving what you read", async ({
  page,
  rufi,
}) => {
  await page.clock.setFixedTime(NOW);
  await rufi.family(longChat());
  // The core stamps the new message on the same day as the page's clock.
  await rufi.start({ now: () => NOW.toISOString() });
  await openChat(page, rufi);
  // One page: the latest replies only.
  await expect(questions(page).first()).toHaveText("Fictional question 171");
  await expect(questions(page)).toHaveCount(30);

  // A reply streams in while older pages load above.
  await page
    .getByRole("textbox", { name: "Message to Rufi" })
    .fill("drip: while I read back");
  await page.getByRole("textbox", { name: "Message to Rufi" }).press("Enter");

  // Scrolled to the top, the page before comes in above, and the first
  // message stays where it was on the screen.
  const held = Promise.withResolvers<undefined>();
  await page.route("**/chat?before=*", async (route) => {
    await held.promise;
    await route.continue();
  });
  await scroller(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(log(page)).toContainText("Loading earlier messages…");
  const before = await topOf(page, "Fictional question 171");
  held.resolve(undefined);
  await expect(questions(page).first()).toHaveText("Fictional question 141");
  const after = await topOf(page, "Fictional question 171");
  expect(Math.abs((after ?? 0) - (before ?? 0))).toBeLessThan(2);
  await page.unroute("**/chat?before=*");

  // Back to the start of the chat.
  for (let tries = 0; tries < 10; tries++) {
    if (
      (await questions(page).first().textContent()) === "Fictional question 1"
    )
      break;
    await scroller(page).evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(200);
  }
  await expect(questions(page).first()).toHaveText("Fictional question 1");
  // Every message once, in order: nothing skipped or shown twice.
  await expect(questions(page)).toHaveText(
    Array.from(
      { length: TURNS },
      (_, i) => `Fictional question ${String(i + 1)}`,
    ),
  );
  await expect(log(page).locator(".reply").last()).toHaveText("ok:drip");
  await expect(
    log(page).locator(".reply").filter({ hasText: "ok:drip" }),
  ).toHaveCount(1);

  // A line for each day, once, also where a day spans pages.
  await expect(log(page).getByRole("heading")).toHaveText([
    "Mon 5 Oct",
    "Yesterday",
    "Today",
  ]);

  // Quiet lines: before question 120 (a new thread), at the compaction in
  // 90's reply, and before the new message (the AI's thread is new after a
  // restart here); none for the cut compaction or the chat's first turn.
  const quiet = log(page).getByText(
    "The AI started afresh here. It can still read earlier messages.",
  );
  await expect(quiet).toHaveCount(3);
  await expect(
    quiet.nth(1).locator("xpath=following-sibling::*[1]"),
  ).toHaveText("Fictional question 120");
  await expect(
    quiet.nth(0).locator("xpath=preceding-sibling::*[1]"),
  ).toHaveText("Fictional question 90");

  // A reload opens at the latest page again.
  await page.reload();
  await expect(log(page).locator(".reply").last()).toHaveText("ok:drip");
  await expect(questions(page).first()).not.toHaveText("Fictional question 1");
});

test("an older page that can't be loaded says so, and Try again loads it", async ({
  page,
  rufi,
}) => {
  await page.clock.setFixedTime(NOW);
  await rufi.family(longChat());
  await rufi.start();
  await openChat(page, rufi);
  await page.route("**/chat?before=*", (route) =>
    route.fulfill({ status: 500, json: { error: "Rufi had a problem." } }),
  );
  await scroller(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(log(page).getByRole("alert")).toHaveText(
    "Rufi couldn't load earlier messages. Try again",
  );
  await page.unroute("**/chat?before=*");
  await log(page).getByRole("button", { name: "Try again" }).click();
  await expect(questions(page).first()).toHaveText("Fictional question 141");
});

test("after the connection drops while you read higher up, the chat opens at the latest reply again; a page asked for before is dropped", async ({
  page,
  rufi,
}) => {
  // The connection can be dropped, as a sleeping Mac or a network change
  // drops it.
  await page.addInitScript(() => {
    const drops: AbortController[] = [];
    const fetched = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (!(typeof input === "string" && input.endsWith("/stream"))) {
        return fetched(input, init);
      }
      const drop = new AbortController();
      drops.push(drop);
      const signals = [drop.signal, init?.signal].filter((one) => !!one);
      return fetched(input, { ...init, signal: AbortSignal.any(signals) });
    };
    Object.assign(globalThis, {
      dropStream: () => {
        for (const drop of drops.splice(0)) drop.abort();
      },
    });
  });
  await page.clock.setFixedTime(NOW);
  await rufi.family(longChat());
  await rufi.start();
  await openChat(page, rufi);
  // An older page is on its way while you read at the top.
  const held = Promise.withResolvers<undefined>();
  let asked = 0;
  await page.route("**/chat?before=*", async (route) => {
    asked += 1;
    const response = await route.fetch();
    await held.promise;
    await route.fulfill({ response });
  });
  await scroller(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(log(page)).toContainText("Loading earlier messages…");

  // The connection drops, and Rufi connects again.
  const again = page.waitForResponse("**/chat/stream");
  await page.evaluate(() => {
    (globalThis as unknown as { dropStream: () => void }).dropStream();
  });
  await again;

  // The latest reply shows, and no older page is asked for until you
  // scroll up again.
  await expect(log(page).getByText("Fictional answer 200")).toBeInViewport();
  await expect(log(page)).not.toContainText("Loading earlier messages…");
  // The page asked for before changes nothing when it comes.
  held.resolve(undefined);
  await page.waitForTimeout(300);
  expect(asked).toBe(1);
  await expect(questions(page).first()).toHaveText("Fictional question 171");
  await expect(log(page).getByText("Fictional answer 200")).toBeInViewport();
});

test("a day line says what day it is now: at midnight, and when you come back to Rufi after the Mac slept", async ({
  page,
  rufi,
}) => {
  await page.clock.install({ time: new Date("2026-10-08T23:59:00+05:30") });
  await rufi.family(longChat());
  await rufi.start();
  await openChat(page, rufi);
  const days = log(page).getByRole("heading");
  await expect(days).toHaveText(["Today"]);
  // Rufi stays open past midnight.
  await page.clock.runFor(2 * 60_000);
  await expect(days).toHaveText(["Yesterday"]);
  // The Mac sleeps through the next midnight, and you come back to Rufi.
  await page.clock.setSystemTime(new Date("2026-10-10T09:00:00+05:30"));
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await expect(days).toHaveText(["Thu 8 Oct"]);
});
