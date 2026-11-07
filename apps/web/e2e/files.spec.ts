// What a reply shows, on the real core with its real headers: a picture the
// AI made, one it generated (once, also when the reply links it, also after
// a reload), and a picture that is gone; and a send while scrolled up. The
// screens' strict CSP refuses nothing.
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
  // The picture in a reply's Markdown, then by another path to it.
  await send(page, `![A cat](${saved})`);
  await expect(log(page).getByRole("img", { name: "A cat" })).toBeVisible();
  await send(page, `I saved the picture at ${saved}`);
  await expect(log(page).getByRole("img")).toHaveCount(3);
  await send(
    page,
    `![A cat via alias](${saved.replace("/call-1.png", "/./call-1.png")})`,
  );
  await expect(
    log(page).getByRole("img", { name: "A cat via alias" }),
  ).toBeVisible();

  const check = async () => {
    // Plain words keep the native picture. A reply's Markdown, including by
    // an equivalent path, shows it once. Intentional reuse in a later turn stays.
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

test("a send while scrolled up brings the chat to its end: Steer on a waiting message", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, "Your CRP was high in March.");
  const earlier = log(page)
    .locator(".reply")
    .first()
    .getByText("Your CRP was high in March.");
  await expect(earlier).toBeVisible();
  // A long reply after it, then a scroll up to the earlier one, as you read.
  await send(
    page,
    Array.from({ length: 60 }, (_, i) => `Note ${String(i + 1)}`).join("\n\n"),
  );
  await expect(
    log(page).locator(".reply").last().getByText("Note 60"),
  ).toBeInViewport();

  // A message waits behind a reply that runs on; scrolled up, Steer sends it.
  const box = chat(page).getByRole("textbox", { name: "Message to Rufi" });
  await send(page, "hang");
  await box.fill("And my iron?");
  await box.press("ControlOrMeta+Enter");
  const waiting = chat(page).getByRole("region", { name: "Waiting messages" });
  await expect(waiting).toContainText("And my iron?");
  await log(page).hover();
  await page.mouse.wheel(0, -10_000);
  await expect(earlier).toBeInViewport();
  await waiting.getByRole("button", { name: "Steer" }).click();
  await expect(
    log(page).locator("p", { hasText: /^And my iron\?$/ }),
  ).toBeInViewport();
  await chat(page).getByRole("button", { name: "Stop" }).click();
});
