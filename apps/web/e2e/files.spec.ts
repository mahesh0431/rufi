// What a reply shows besides its text, on the real core with its real
// headers: a picture the AI made, one it generated (once, also when the reply
// links it, also after a reload), a page it made (a card that opens in a
// locked frame), a Mermaid diagram (drawn styled, in its own frame), and a
// file that is gone. A page's script runs, but can't read Rufi's page or an
// API answer, stays locked when opened on its own, and loads nothing remote.
// The screens' strict CSP refuses nothing.
import { AxeBuilder } from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Frame, Locator, Page } from "@playwright/test";
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

/** A page the AI made that tries what a page mustn't, and writes what happened. */
const TRYING = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Fictional results</title></head><body>
<h1>Asha's fictional results</h1><ul id="out"></ul>
<script>
const out = (line) => { const li = document.createElement("li"); li.textContent = line; document.getElementById("out").append(li); };
out("script ran");
out("eval: " + eval("6 * 7"));
try { out("parent: " + parent.document.title); } catch { out("parent: blocked"); }
try { out("storage: " + sessionStorage.length); } catch { out("storage: blocked"); }
out("origin: " + self.origin);
fetch("/api/people").then(() => out("api: read"), () => out("api: blocked"));
fetch("http://127.0.0.1:9/send").then(() => out("send: sent"), () => out("send: blocked"));
const img = new Image(); img.onload = () => out("remote image: loaded"); img.onerror = () => out("remote image: blocked"); img.src = "http://127.0.0.1:9/pixel.png";
const s = document.createElement("script"); s.onload = () => out("remote script: loaded"); s.onerror = () => out("remote script: blocked"); s.src = "http://127.0.0.1:9/lib.js"; document.head.append(s);
</script></body></html>`;

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
  await mkdir(join(ai, "reports"), { recursive: true });
  await writeFile(
    join(ai, "analysis", "sugar-vs-sleep.png"),
    png(320, 180, [37, 99, 235]),
  );
  await writeFile(join(ai, "reports", "results-2026.html"), TRYING);
  await rufi.start(options);
  await page.goto(rufi.link());
  await expect(
    page.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();
}

/** Sends a message; the scripted Codex answers "ok:" and the message. */
async function send(page: Page, text: string) {
  const opener = chat(page).getByRole("button", { name: "Open the chat" });
  if (await opener.isVisible()) await opener.click();
  const box = chat(page).getByRole("textbox", { name: "Message to Rufi" });
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
  expect(await refusedIn(page)).toEqual([]);
});

test("a picture the AI generated shows even without a link, and once when its reply links it, also after a reload", async ({
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
  await send(page, `There: ![A cat](${saved})`);
  await expect(log(page).getByRole("img", { name: "A cat" })).toBeVisible();

  const check = async () => {
    // One picture for each reply: the first shows the generated one, the
    // second shows it where its reply links it, not twice.
    await expect(log(page).getByRole("img")).toHaveCount(2);
    await expect(log(page).getByText("Made by the AI")).toHaveCount(1);
    for (const img of await log(page).getByRole("img").all()) {
      await expect.poll(() => drawn(img)).toBe(200);
    }
  };
  await check();
  await page.reload();
  await chat(page).getByRole("button", { name: "Open the chat" }).click();
  await check();
  expect(await refusedIn(page)).toEqual([]);
});

/** The frame of the opened page. */
async function pageFrame(page: Page): Promise<Frame> {
  const element = await page
    .getByRole("dialog")
    .locator("iframe")
    .elementHandle();
  const frame = await element.contentFrame();
  if (!frame) throw new Error("No page frame");
  return frame;
}

test("a page is a card that opens over the chat: its script runs, but it can't reach Rufi, its API or anything remote, also when opened on its own", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  // Remote loads, and why each one failed: the page's policy refused it.
  const remote: string[] = [];
  const asked: string[] = [];
  page.context().on("request", (request) => asked.push(request.url()));
  page.context().on("requestfailed", (request) => {
    if (request.url().includes("127.0.0.1:9/")) {
      remote.push(request.failure()?.errorText ?? "");
    }
  });
  page.context().on("response", (response) => {
    if (response.url().includes("127.0.0.1:9/")) remote.push("answered");
  });
  await send(page, "Your page: [Your 2026 results](reports/results-2026.html)");
  const reply = log(page).locator(".reply");
  await expect(reply).toContainText("Your 2026 results");
  await expect(reply).toContainText("reports/results-2026.html");
  await accessible(page);

  await reply.getByRole("button", { name: "Open Your 2026 results" }).click();
  const shown = page.getByRole("dialog", { name: "Your 2026 results" });
  await expect(shown).toBeVisible();
  const frame = await pageFrame(page);
  const out = frame.locator("#out");
  // Its script ran first, so what it couldn't do proves the locks.
  await expect(out).toContainText("script ran");
  await expect(out).toContainText("eval: 42");
  await expect(out).toContainText("parent: blocked");
  await expect(out).toContainText("storage: blocked");
  await expect(out).toContainText("origin: null");
  await expect(out).toContainText("api: blocked");
  await expect(out).toContainText("send: blocked");
  await expect(out).toContainText("remote image: blocked");
  await expect(out).toContainText("remote script: blocked");
  await accessible(page);
  await shown.getByRole("button", { name: "Close" }).click();
  await expect(shown).toHaveCount(0);
  expect(await refusedIn(page)).toEqual([]);

  // Opened on its own, at its address: still locked.
  const alone = await page.context().newPage();
  await alone.goto(frame.url());
  const own = alone.locator("#out");
  await expect(own).toContainText("script ran");
  await expect(own).toContainText("eval: 42");
  await expect(own).toContainText("storage: blocked");
  await expect(own).toContainText("origin: null");
  await expect(own).toContainText("api: blocked");
  await expect(own).toContainText("send: blocked");
  await expect(own).toContainText("remote image: blocked");
  await expect(own).toContainText("remote script: blocked");

  expect(remote.length).toBeGreaterThan(0);
  expect(new Set(remote)).toEqual(new Set(["csp"]));
  // The page itself asked nothing of Rufi's API.
  expect(asked.filter((url) => url.endsWith("/api/people"))).toEqual([]);
});

test("a file that is gone keeps its card and says so", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(
    page,
    "Old: [Your 2025 results](reports/results-2025.html) ![Sleep in August](analysis/sleep-august.png)",
  );
  const reply = log(page).locator(".reply");
  await expect(reply.getByText("Your 2025 results")).toBeVisible();
  await expect(reply.getByText("Sleep in August")).toBeVisible();
  await expect(
    reply.getByText("This file is no longer in the AI's folder."),
  ).toHaveCount(2);
  await accessible(page);
  expect(await refusedIn(page)).toEqual([]);
});

/** The diagram's frame, once drawn. */
async function diagramFrame(page: Page): Promise<Frame> {
  const element = log(page).getByTitle("Diagram");
  await expect(element).toBeVisible();
  const frame = await (await element.elementHandle()).contentFrame();
  if (!frame) throw new Error("No diagram frame");
  return frame;
}

test("a Mermaid diagram draws styled in the theme, with its labelled edge and arrow; its own settings can't restyle it; a broken one stays readable", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(
    page,
    [
      "In two steps:",
      "",
      "```mermaid",
      '%%{init: {"theme": "dark", "themeCSS": ".node rect { fill: red; }"}}%%',
      "flowchart LR",
      "  A[You add a report] -->|then| B[Rufi reads it]",
      "```",
    ].join("\n"),
  );
  const frame = await diagramFrame(page);
  const accentSoft = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-soft")
      .trim(),
  );
  const looks = await frame.evaluate(() => {
    const rgb = (value: string) => value;
    const node = document.querySelector(".node rect, .node path");
    const label = [...document.querySelectorAll("text, tspan")].find(
      (text) => text.textContent === "then",
    );
    const arrow = document.querySelector("marker path");
    const box = node?.getBoundingClientRect();
    const words = [...document.querySelectorAll(".node text")].map((text) => {
      const r = text.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    return {
      fill: node ? rgb(getComputedStyle(node).fill) : null,
      nodeWidth: box?.width ?? 0,
      label: label !== undefined,
      arrow: arrow ? getComputedStyle(arrow).fill : null,
      words,
    };
  });
  // Mermaid's own styles applied: the node is filled in the theme's soft
  // accent (never the diagram's red), and the arrow is drawn.
  const toRgb = (hex: string) =>
    `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  expect(looks.fill).toBe(toRgb(accentSoft));
  expect(looks.label).toBe(true);
  expect(looks.arrow).not.toBe("none");
  expect(looks.arrow).not.toBeNull();
  expect(looks.words.every((word) => word.width > 0 && word.height > 0)).toBe(
    true,
  );
  // Not the code block: the diagram replaced it.
  await expect(log(page).locator(".reply pre")).toHaveCount(0);
  await accessible(page);

  await send(
    page,
    ["Broken:", "", "```mermaid", "flowchart LR", "  A -->", "```"].join("\n"),
  );
  const broken = log(page).locator(".reply").last();
  await expect(broken.locator("pre")).toContainText("A -->");
  await expect(broken.getByTitle("Diagram")).toHaveCount(0, {
    timeout: 20_000,
  });
  expect(await refusedIn(page)).toEqual([]);
});
