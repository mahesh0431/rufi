// What a reply shows, on the real core with its real headers: a picture the
// AI made, one it generated (once, also when the reply links it, also after
// a reload), a reply in OpenUI Lang (drawn by OpenUI, or shown as its text
// when it isn't whole), and a picture that is gone. The screens' strict CSP
// refuses nothing.
import { AxeBuilder } from "@axe-core/playwright";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Locator, Page } from "@playwright/test";
import { expect, test, type Rufi } from "./rufi.ts";

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

// The CSP's refusals, collected in Rufi's own page.
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
const refusedIn = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { refused: string[] }).refused);

/** A PNG of one colour, `width` × `height`. */
function png(width: number, height: number, [r, g, b]: number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([
    0,
    ...Array.from({ length: width }, () => [r ?? 0, g ?? 0, b ?? 0]).flat(),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(Buffer.concat(Array.from({ length: height }, () => row))),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });
const log = (page: Page) => chat(page).getByRole("log", { name: "Messages" });

/** Rufi with the fictional family and files in the AI's folder, at Overview. */
async function opened(
  page: Page,
  rufi: Rufi,
  options?: Parameters<Rufi["start"]>[0],
) {
  await rufi.family();
  const ai = join(rufi.home, "ai");
  await mkdir(join(ai, "analysis"), { recursive: true });
  await writeFile(
    join(ai, "analysis", "sugar-vs-sleep.png"),
    png(320, 180, [37, 99, 235]),
  );
  await rufi.start(options);
  await page.goto(rufi.link());
  await expect(
    page.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();
}

/** Sends a message; the scripted Codex answers "ok:" and the message. */
async function send(page: Page, text: string) {
  const opener = chat(page).getByRole("button", { name: "Open the chat" });
  const box = chat(page).getByRole("textbox", { name: "Message to Rufi" });
  // Right after a load, neither the bar nor the box has drawn yet.
  await expect(opener.or(box).first()).toBeVisible();
  if (await opener.isVisible()) await opener.click();
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

/** Whether a picture is drawn: loaded, at its own size. */
const drawn = (img: Locator) =>
  img.evaluate((element) => (element as HTMLImageElement).naturalWidth);

test("a picture in the AI's folder shows in the reply with its caption, opens full size, and Esc closes it", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(
    page,
    "Here: ![Sugar and sleep, September](analysis/sugar-vs-sleep.png)",
  );
  const reply = log(page).locator(".reply");
  const picture = reply.getByRole("img", {
    name: "Sugar and sleep, September",
  });
  await expect(picture).toBeVisible();
  await expect.poll(() => drawn(picture)).toBe(320);
  await expect(reply).toContainText("Sugar and sleep, September");
  await accessible(page);

  await reply
    .getByRole("button", { name: "Open Sugar and sleep, September full size" })
    .click();
  const full = page.getByRole("dialog", { name: "Sugar and sleep, September" });
  await expect(full.getByRole("img")).toBeVisible();
  await accessible(page);
  await page.keyboard.press("Escape");
  await expect(full).toHaveCount(0);
  // The focus is back on the picture it opened from.
  await expect(
    reply.getByRole("button", {
      name: "Open Sugar and sleep, September full size",
    }),
  ).toBeFocused();
  expect(await refusedIn(page)).toEqual([]);
});

test("a picture the AI generated shows even without a link, and once when its reply shows it, also after a reload", async ({
  page,
  rufi,
}) => {
  const saved = join(
    rufi.home,
    "codex",
    "generated_images",
    "thread-1",
    "call-1.png",
  );
  await mkdir(join(saved, ".."), { recursive: true });
  await writeFile(saved, png(200, 120, [148, 163, 184]));
  await opened(page, rufi, { scenario: { picture: { savedPath: saved } } });

  await send(page, "a fictional cat");
  await expect(log(page).getByText("ok:a fictional cat")).toBeVisible();
  // OpenUI replies: the picture by Image, then in Markdown text by another path.
  await send(page, `There:\nroot = Card([Image("A cat", "${saved}")])`);
  await expect(log(page).getByRole("img", { name: "A cat" })).toBeVisible();
  await send(page, `I saved the picture at ${saved}`);
  await expect(log(page).getByRole("img")).toHaveCount(3);
  await send(
    page,
    `There:\nroot = Card([TextContent("![A cat via alias](${saved.replace("/call-1.png", "/./call-1.png")})")])`,
  );
  await expect(
    log(page).getByRole("img", { name: "A cat via alias" }),
  ).toBeVisible();

  const check = async () => {
    // Plain words keep the native picture. A reply's Image or Markdown text,
    // including by an equivalent path, shows it once. Intentional reuse in a later turn stays.
    await expect(log(page).getByRole("img")).toHaveCount(4);
    await expect(log(page).getByText("Made by the AI")).toHaveCount(2);
    for (const img of await log(page).getByRole("img").all()) {
      await expect.poll(() => drawn(img)).toBe(200);
    }
  };
  await check();
  await page.reload();
  await chat(page).getByRole("button", { name: "Open the chat" }).click();
  await check();
  // Deleting the file still leaves one missing-file card per turn after reload.
  await unlink(saved);
  await page.reload();
  await chat(page).getByRole("button", { name: "Open the chat" }).click();
  await expect(
    log(page).getByText("This file is no longer in the AI's folder."),
  ).toHaveCount(4);
  expect(await refusedIn(page)).toEqual([]);
});

/** The frame of the opened page. */
test("a picture that is gone keeps its card and says so", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "Old: ![Sleep in August](analysis/sleep-august.png)");
  const reply = log(page).locator(".reply");
  await expect(reply.getByText("Sleep in August")).toBeVisible();
  await expect(
    reply.getByText("This file is no longer in the AI's folder."),
  ).toBeVisible();
  await accessible(page);
  expect(await refusedIn(page)).toEqual([]);
});

/**
 * A stored reply in OpenUI Lang (openui/library.ts): keep it as written when
 * OpenUI changes, so an old reply still draws. A header, text with a web
 * link, a link to a page of Rufi and a citation of the Card's source (a page
 * of Rufi), OpenUI's line chart of one test and a table with every value
 * ("<5" too), a callout with a link, an editable table with an address of
 * Rufi's, a button whose action names the test, and follow-ups.
 */
const STORED_REPLY = [
  "root = Card([header, intro, chart, table, note, reports, explain, followUps], [src])",
  'header = CardHeader("CRP", "Your last four results")',
  'intro = TextContent("Your CRP was **high** in March and August. [What CRP measures](https://example.com/crp) · [Your profile](rufi:/profile) [1]")',
  'src = {title: "Your birth date and sex", sourceName: "Your profile", url: "rufi:/profile"}',
  'chart = LineChart(["4 Mar 2026", "12 Aug 2026"], [Series("CRP (mg/L)", [8.2, 6.0])])',
  'table = Table([Col("Date", ["1 Dec 2025", "4 Mar 2026", "12 Aug 2026"]), Col("CRP", ["<5 mg/L", "8.2 mg/L", "6.0 mg/L"]), Col("Lab range", ["<5", "<5", "<5"])])',
  'note = Callout("info", "Lab ranges", "Your ranges depend on [your sex](rufi:/profile).")',
  'reports = EditableTable("reports", [{type: "url", key: "source", header: "Report"}], [{id: "p1", values: ["rufi:/profile"]}])',
  'explain = Buttons([Button("Explain", @ToAssistant("Explain this result", {test: "CRP"}))])',
  'followUps = FollowUpBlock([FollowUpItem("Show my ferritin too")])',
].join("\n");

test("a reply the AI wrote in OpenUI draws in the chat under Rufi's strict CSP: its chart and table, a follow-up or button shows its words while Rufi AI gets the click with its context, and every link of Rufi's opens in place", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  // The fake answers "ok:" and the message; OpenUI passes over that first line.
  await send(page, `A stored reply:\n${STORED_REPLY}`);
  const reply = log(page).locator(".reply").first();
  await expect(reply.getByText("Your last four results")).toBeVisible();
  await expect(
    reply.getByRole("link", { name: "What CRP measures" }),
  ).toHaveAttribute("href", "https://example.com/crp");
  // Every link opens by Rufi's rule, wherever OpenUI draws it.
  for (const name of ["Your profile", "your sex"]) {
    await expect(reply.getByRole("link", { name })).toHaveAttribute(
      "href",
      /^\/people\/[^/]+\/profile$/,
    );
  }
  await expect(reply.getByRole("button", { name: "Citations" })).toBeVisible();
  await expect(reply.getByRole("img", { name: /^Line chart/ })).toBeVisible();
  await expect(reply.getByText("<5 mg/L")).toBeVisible();
  // Drawn, not shown as its text.
  await expect(reply.locator("pre")).toHaveCount(0);
  await accessible(page);
  expect(await refusedIn(page)).toEqual([]);
  // A click shows its words as the person's message, and Rufi AI gets it
  // as a click; what they typed and haven't sent stays in the box.
  const box = chat(page).getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("And my iron?");
  await reply.getByText("Show my ferritin too").click();
  await expect(log(page).locator(".reply").last()).toContainText(
    "ok:User clicked: Show my ferritin too",
  );
  await expect(
    log(page).locator("p", { hasText: /^Show my ferritin too$/ }),
  ).toBeVisible();
  await expect(box).toHaveValue("And my iron?");
  // A button's action says which test it is about, as OpenUI gives it.
  await reply.getByRole("button", { name: "Explain" }).click();
  await expect(log(page).locator(".reply").last()).toContainText(
    /ok:User clicked: Explain this result\s+Context: \{"test":"CRP"\}/,
  );
  await expect(
    log(page).locator("p", { hasText: /^Explain this result$/ }),
  ).toBeVisible();
  // A source of Rufi's opens the person's page in this window.
  await reply.getByRole("button", { name: /Your birth date and sex/ }).click();
  await expect(page).toHaveURL(/\/people\/[^/]+\/profile$/);
  expect(page.context().pages()).toHaveLength(1);
  // So does an address OpenUI draws itself, in an editable table.
  await page.goBack();
  await chat(page).getByRole("button", { name: "Open the chat" }).click();
  await reply.locator('a[href="rufi:/profile"]').click();
  await expect(page).toHaveURL(/\/people\/[^/]+\/profile$/);
  expect(page.context().pages()).toHaveLength(1);
});

test("a finished reply with a broken piece draws the rest, says part isn't shown, and shows its whole text on a click", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(
    page,
    [
      "Not whole:",
      "root = Card([intro, t])",
      'intro = TextContent("Your iron results")',
      't = Table([Col("Test", ["Haemoglobin", "Ferritin"]), Col("Value", [v1, v2])])',
      'v1 = "11.6 g/dL"',
    ].join("\n"),
  );
  const first = log(page).locator(".reply").last();
  await expect(
    first.getByText("Your iron results", { exact: true }),
  ).toBeVisible();
  const toggle = first.getByText("Part of this reply couldn't be shown.");
  await expect(toggle).toBeVisible();
  await expect(first.locator("pre")).toBeHidden();
  await toggle.click();
  await expect(first.locator("pre")).toContainText('v1 = "11.6 g/dL"');
  await accessible(page);
  // Another part where a step goes: OpenUI's parser lets it through.
  await send(
    page,
    [
      "Text where a step goes:",
      'root = Card([Steps([StepsItem("Fast for 8 hours", "Water is fine."), TextContent("Ferritin: 18 ng/mL")])])',
    ].join("\n"),
  );
  const second = log(page).locator(".reply").last();
  await expect(
    second.getByText("Fast for 8 hours", { exact: true }),
  ).toBeVisible();
  await expect(
    second.getByText("Part of this reply couldn't be shown."),
  ).toBeVisible();
  await second.getByText("Part of this reply couldn't be shown.").click();
  await expect(second.locator("pre")).toContainText("Ferritin: 18 ng/mL");
});
