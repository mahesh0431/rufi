// A visit brief on the real core: the AI's create_brief call (scripted),
// Rufi's line in the chat, and the brief's page with its Sources (each opens
// its record) and Copy, in both themes; a later save shows the record changed
// since. Each test checks that the strict CSP refused nothing the screens
// need.
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

const MARKDOWN = `## For the visit on Friday

### Current medicines
- Metformin 500 mg, twice a day

### Recent results
- HbA1c 6.8 % (lab range 4.0 - 5.6, marked High), 12 Aug 2026
- Vitamin D 22 ng/mL (lab range 30 - 100, marked Low), May 2026

### Questions to ask
- Question: Is the HbA1c a reason to change the Metformin?`;

test("a brief's line opens its page: dated, as written, with its Sources and Copy; a later save shows the record changed since, and a source opens its record", async ({
  page,
  rufi,
  context,
}) => {
  await rufi.family();
  await rufi.start({
    scenario: {
      callsByTurn: [
        [
          {
            tool: "create_brief",
            arguments: {
              markdown: MARKDOWN,
              record_version: 0,
              cited: [
                { kind: "medicine_use", id: "med-a1" },
                { kind: "result", id: "res-a1" },
                { kind: "result", id: "res-a7" },
              ],
            },
          },
        ],
        [
          {
            tool: "save_changes",
            arguments: {
              changes: [
                {
                  kind: "medicine_use",
                  action: "change",
                  id: "med-a1",
                  fields: { status: "stopped" },
                },
              ],
            },
          },
        ],
      ],
    },
  });
  await page.goto(rufi.link());
  const chat = page.getByRole("region", { name: "Chat" });
  const box = chat.getByRole("textbox", { name: "Message to Rufi" });
  await chat.getByRole("button", { name: "Open the chat" }).click();
  await box.fill("Make a brief for my visit on Friday");
  await box.press("Enter");

  // Rufi's own line, which opens the brief.
  const line = chat
    .getByRole("log", { name: "Messages" })
    .locator("[data-entry]", { hasText: "records cited" });
  await expect(line).toHaveText(
    /^RufiVisit brief · Made \d{1,2} \w{3} \d{4} · 3 records citedOpen$/,
  );
  await accessible(page);
  await line.getByRole("link", { name: /^Open Visit brief/ }).click();

  await expect(page).toHaveURL(/\/people\/asha\/briefs\/[^/]+$/);
  await expect(page.getByRole("banner")).toHaveText("Visit brief");
  await expect(page.getByText(/^Made at \d\d:\d\d on /)).toContainText(
    "from Asha Fictional's saved record",
  );
  const brief = page.getByRole("article", { name: "The brief" });
  await expect(
    brief.getByRole("heading", { name: "Questions to ask" }),
  ).toBeVisible();
  await expect(brief.getByRole("listitem").last()).toHaveText(
    "Question: Is the HbA1c a reason to change the Metformin?",
  );
  const sources = page
    .getByRole("region", { name: "Sources" })
    .getByRole("listitem");
  await expect(sources).toHaveText([
    "Medicine useMetformin 500 mg · Mar 2024 · currentSaved before Rufi kept sources",
    "ResultHbA1c 6.8 % · 12 Aug 2026Sunrise Labs report, collected 12 Aug 2026 · Sunrise Labs August.pdf, page 1",
    "ResultVitamin D 22 ng/mL · May 2026Saved before Rufi kept sources",
  ]);
  await expect(page.getByText("The record changed since")).toHaveCount(0);
  await accessible(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await accessible(page);

  // Copy: the date, the brief as written and its Sources, as plain text.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("Copied")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^Visit brief · Made at \d\d:\d\d on /);
  expect(copied).toContain(`saved record\n\n${MARKDOWN}\n\nSources\n`);
  expect(copied).toContain(
    "\n- Result: HbA1c 6.8 % · 12 Aug 2026 (Sunrise Labs report, collected 12 Aug 2026 · Sunrise Labs August.pdf, page 1)",
  );

  // The second scripted turn changes the record through the running chat.
  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  const message = page.getByRole("textbox", { name: "Message to Rufi" });
  await message.fill("I stopped Metformin");
  await message.press("Enter");
  await expect(page.locator(".receipt").getByRole("listitem")).toHaveText(
    "Changed medicine use Metformin 500 mg: status current → stopped",
  );
  await page.getByRole("link", { name: /^Open Visit brief/ }).click();
  await page.reload();
  await expect(page.getByRole("status").getByText(/changed since/)).toHaveText(
    "The record changed since this brief was made. The brief stays as it was; ask Rufi in the chat for a new one to include the changes.",
  );
  // As the brief cited it, marked.
  await expect(sources.first()).toHaveText(
    "Medicine useMetformin 500 mg · Mar 2024 · currentchanged sinceSaved before Rufi kept sources",
  );
  await expect(brief).toContainText("Metformin 500 mg, twice a day");
  await accessible(page);

  // A source opens its record on its page, open and in view.
  await page
    .getByRole("region", { name: "Sources" })
    .getByRole("link", { name: "HbA1c 6.8 % · 12 Aug 2026" })
    .click();
  await expect(page).toHaveURL(
    /\/people\/asha\/record\/lab_result\?open=res-a1$/,
  );
  const row = page.getByRole("button", { name: "HbA1c", exact: true });
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(row).toBeInViewport();
});

test("a brief that isn't there says so", async ({ page, rufi }) => {
  await rufi.family();
  await rufi.start();
  await page.goto(rufi.link());
  await expect(
    page.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();
  await page.goto(
    new URL("/people/asha/briefs/no-such-brief", page.url()).href,
  );
  await expect(page.getByRole("alert")).toContainText(
    "There is no such brief.",
  );
});

test("the chat bar leaves the last Sources row of a long brief in view", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  // Every result of Asha's cited: a page longer than the window.
  const cited = [
    { kind: "medicine_use", id: "med-a1" },
    ...Array.from({ length: 11 }, (_, i) => ({
      kind: "result",
      id: `res-a${String(i + 1)}`,
    })),
  ];
  await rufi.start({
    scenario: {
      callsByTurn: [
        [
          {
            tool: "create_brief",
            arguments: { markdown: MARKDOWN, record_version: 0, cited },
          },
        ],
      ],
    },
  });
  await page.goto(rufi.link());
  const chat = page.getByRole("region", { name: "Chat" });
  const box = chat.getByRole("textbox", { name: "Message to Rufi" });
  await chat.getByRole("button", { name: "Open the chat" }).click();
  await box.fill("Make a brief for my visit on Friday");
  await box.press("Enter");
  await chat.getByRole("link", { name: /^Open Visit brief/ }).click();
  const sources = page
    .getByRole("region", { name: "Sources" })
    .getByRole("listitem");
  await expect(sources).toHaveCount(cited.length);

  for (const size of [
    { width: 1280, height: 720 },
    { width: 800, height: 600 },
  ]) {
    await page.setViewportSize(size);
    await page.getByRole("main").evaluate((main) => {
      main.scrollTop = main.scrollHeight;
    });
    const last = await sources.last().boundingBox();
    // The bar: the box floating over the page's bottom right.
    const bar = await chat
      .getByRole("button", { name: "Open the chat" })
      .evaluate((element) => {
        let shown: Element | null = element;
        while (shown && getComputedStyle(shown).position !== "fixed") {
          shown = shown.parentElement;
        }
        return shown?.getBoundingClientRect().top;
      });
    expect(last).not.toBeNull();
    expect(bar).toBeDefined();
    expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(bar ?? 0);
  }
});
