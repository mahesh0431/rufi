// What a reply shows besides its text, on the real core with its real
// headers: a picture the AI made, one it generated (once, also when the reply
// links it, also after a reload), a page it made (a card that opens in a
// locked frame), a Mermaid diagram (drawn styled, in its own frame), and a
// file that is gone. A page's script runs, but can't read Rufi's page or an
// API answer or the network. Standalone requests receive an inert page.
// The screens' strict CSP refuses nothing.
import { AxeBuilder } from "@axe-core/playwright";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
<h1>Asha's fictional results</h1><button id="tab" type="button">2025</button>
<label>Filter <input id="filter"></label><ul id="out"></ul>
<script>
const out = (line) => { const li = document.createElement("li"); li.textContent = line; document.getElementById("out").append(li); };
out("script ran");
document.getElementById("tab").onclick = () => out("tab clicked");
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
  // The focus is back on the picture it opened from.
  await expect(
    reply.getByRole("button", {
      name: "Open Sugar and sleep, September full size",
    }),
  ).toBeFocused();
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
  await send(page, `I saved the picture at ${saved}`);
  await expect(log(page).getByRole("img")).toHaveCount(3);
  await send(
    page,
    `There: ![A cat via alias](${saved.replace("/call-1.png", "/./call-1.png")})`,
  );
  await expect(
    log(page).getByRole("img", { name: "A cat via alias" }),
  ).toBeVisible();

  const check = async () => {
    // Plain words keep the native picture. A Markdown reference, including
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
async function pageFrame(page: Page): Promise<Frame> {
  const element = await page
    .getByRole("dialog")
    .locator("iframe")
    .elementHandle();
  const frame = await element.contentFrame();
  if (!frame) throw new Error("No page frame");
  return frame;
}

test("a page is a card that opens over the chat: its script runs, but it can't reach Rufi, its API or anything remote, and a standalone request is inert", async ({
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
  // Put the card among enough text to check the reading position after closing.
  const notes = Array.from(
    { length: 8 },
    (_, i) => `Fictional note ${String(i + 1)}: checked.`,
  );
  await send(
    page,
    [
      ...notes,
      "Your page: [Your 2026 results](reports/results-2026.html)",
      ...notes,
    ].join("\n\n"),
  );
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
  // The Escape signal from any sender except this page's frame is ignored.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const heard = (event: MessageEvent) => {
          if (event.data !== "rufi-page-escape") return;
          removeEventListener("message", heard);
          resolve();
        };
        addEventListener("message", heard);
        postMessage("rufi-page-escape", location.origin);
      }),
  );
  await expect(shown).toBeVisible();
  await accessible(page);
  const fileUrl = frame.url();
  const scroll = page.locator('[aria-label="Messages"]').locator("../..");
  const at = await scroll.evaluate((element) => element.scrollTop);
  expect(at).toBeGreaterThan(0);
  await shown.getByRole("button", { name: "Close" }).click();
  await expect(shown).toHaveCount(0);
  // Close and Esc give the focus back to Open.
  const open = reply.getByRole("button", { name: "Open Your 2026 results" });
  await expect(open).toBeFocused();
  const box = chat(page).getByRole("textbox", { name: "Message to Rufi" });
  await expect(box).toBeVisible();
  await expect(
    chat(page).getByRole("button", { name: "Minimise" }),
  ).toBeVisible();
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(at);
  await reply.getByRole("button", { name: "Open Your 2026 results" }).click();
  await expect(shown).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shown).toHaveCount(0);
  await expect(open).toBeFocused();
  // A person can click, pause, and type inside the page without losing focus.
  await open.click();
  const filter = (await pageFrame(page)).getByRole("textbox", {
    name: "Filter",
  });
  await filter.click();
  await page.waitForTimeout(300);
  await page.keyboard.type("HbA1c");
  await expect(filter).toHaveValue("HbA1c");
  // Esc closes it after a click inside the page, and the click still works.
  await (await pageFrame(page)).locator("#tab").click();
  await expect((await pageFrame(page)).locator("#out")).toContainText(
    "tab clicked",
  );
  await page.keyboard.press("Escape");
  await expect(shown).toHaveCount(0);
  await expect(open).toBeFocused();
  // Tab reaches the page, Enter activates its control, and Esc closes it.
  await open.click();
  await expect((await pageFrame(page)).locator("#out")).toContainText(
    "script ran",
  );
  await shown.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Tab");
  await expect((await pageFrame(page)).locator("#tab")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect((await pageFrame(page)).locator("#out")).toContainText(
    "tab clicked",
  );
  await page.keyboard.press("Escape");
  await expect(shown).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(box).toBeVisible();
  await expect(
    chat(page).getByRole("button", { name: "Minimise" }),
  ).toBeVisible();
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(at);
  expect(await refusedIn(page)).toEqual([]);

  // A standalone request gets an inert instruction, never the file's script.
  const alone = await page.context().newPage();
  await alone.goto(fileUrl);
  await expect(
    alone.getByText("Open this page from the chat in Rufi."),
  ).toBeVisible();
  await expect(alone.locator("script, #out")).toHaveCount(0);
  await alone.close();

  expect(remote.length).toBeGreaterThan(0);
  expect(new Set(remote)).toEqual(new Set(["csp"]));
  // The page itself asked nothing of Rufi's API.
  expect(asked.filter((url) => url.endsWith("/api/people"))).toEqual([]);

  // An automatic navigation is different from fetch. The parent policy
  // must stop it before it reaches a second, reachable origin.
  const received: string[] = [];
  const outside = createServer((request, response) => {
    received.push(request.url ?? "");
    response.end("Fictional external page");
  });
  await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve));
  try {
    const address = outside.address();
    if (address === null || typeof address === "string")
      throw new Error("No listener");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    expect((await page.context().request.get(`${origin}/ready`)).status()).toBe(
      200,
    );
    const destination = `${origin}/navigate`;
    let ran = 0;
    page.on("console", (message) => {
      if (message.text() === "navigation script ran") ran++;
    });
    await writeFile(
      join(rufi.home, "ai", "reports", "navigation.html"),
      `<!doctype html><html lang="en"><title>Fictional navigation</title><script>console.log("navigation script ran"); location.href = ${JSON.stringify(destination)};</script></html>`,
    );
    await send(page, "[Fictional navigation](reports/navigation.html)");
    await log(page)
      .getByRole("button", { name: "Open Fictional navigation" })
      .click();
    const navigating = page.getByRole("dialog", {
      name: "Fictional navigation",
    });
    const url = new URL(
      (await navigating.locator("iframe").getAttribute("src")) ?? "",
      page.url(),
    ).href;
    await expect.poll(() => ran).toBe(1);
    await expect.poll(() => refusedIn(page)).toEqual([`frame-src ${origin}`]);
    expect(received).toEqual(["/ready"]);
    await navigating.getByRole("button", { name: "Close" }).click();
    const direct = await page.context().newPage();
    await direct.goto(url);
    await expect(
      direct.getByText("Open this page from the chat in Rufi."),
    ).toBeVisible();
    await expect(direct.locator("script")).toHaveCount(0);
    expect(ran).toBe(1);
    expect(received).toEqual(["/ready"]);
    await direct.close();
    expect(await refusedIn(page)).toEqual([`frame-src ${origin}`]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      outside.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
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

test("in the dark theme, a diagram draws on the chat's dark surface, its edge labels too", async ({
  page,
  rufi,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await opened(page, rufi);
  await send(
    page,
    [
      "In two steps:",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[You add a report] -->|then| B[Rufi reads it]",
      "```",
    ].join("\n"),
  );
  const frame = await diagramFrame(page);
  const surface = await page.evaluate(() => {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue("--surface")
      .trim();
    return `rgb(${[1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)).join(", ")})`;
  });
  expect(surface).not.toBe("rgb(255, 255, 255)");
  const looks = await frame.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor,
    label: [...document.querySelectorAll(".edgeLabel rect")].map(
      (rect) => getComputedStyle(rect).fill,
    ),
  }));
  // The frame isn't a light page painted white behind the diagram.
  expect(looks.scheme).toBe("dark");
  expect(looks.background).toBe(surface);
  expect(looks.label.length).toBeGreaterThan(0);
  expect(new Set(looks.label)).toEqual(new Set([surface]));
  expect(await refusedIn(page)).toEqual([]);
});
