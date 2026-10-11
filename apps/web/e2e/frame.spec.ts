// The frame on the real core: opening Rufi, first run, sign-in, Overview,
// Settings and Help, and what the page does when the core is slow or gone.
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { runningLink } from "../../server/src/server/core.ts";
import { expect, test } from "./rufi.ts";

/** No accessibility rule broken on what the page shows now. */
async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

const sidebar = (page: Page) => page.getByRole("complementary");

/** The theme the page shows now: light or dark. */
const theme = (page: Page) => () =>
  page.evaluate(() => document.documentElement.dataset["theme"]);

test.describe("opening Rufi", () => {
  test("the link opens the Overview and leaves the address bar", async ({
    page,
    rufi,
  }) => {
    await rufi.family();
    await rufi.start();
    await page.goto(rufi.link());
    await expect(
      page.getByRole("heading", {
        name: /^Good (morning|afternoon|evening), Asha Fictional$/,
      }),
    ).toBeVisible();
    expect(page.url()).not.toContain("launch");
    await expect(sidebar(page)).toContainText("Asha Fictional");
    await accessible(page);

    // Reloading keeps the tab's session.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Health record" }),
    ).toBeVisible();
  });

  test("a link works once; a fresh one opens a second tab", async ({
    context,
    page,
    rufi,
  }) => {
    await rufi.family();
    await rufi.start();
    const link = rufi.link();
    await page.goto(link);
    await expect(
      page.getByRole("heading", { name: "Health record" }),
    ).toBeVisible();

    const reused = await context.newPage();
    await reused.goto(link);
    await expect(
      reused.getByRole("heading", { name: "This session has ended" }),
    ).toBeVisible();

    // `pnpm start` again asks the running Rufi for a fresh link.
    const fresh = await runningLink(rufi.home);
    expect(fresh).toBeDefined();
    const second = await context.newPage();
    await second.goto(fresh ?? "");
    await expect(
      second.getByRole("heading", { name: "Health record" }),
    ).toBeVisible();
  });

  test("without a link there is no session", async ({ page, rufi }) => {
    await rufi.family();
    const core = await rufi.start();
    await page.goto(`http://127.0.0.1:${String(core.port)}/settings`);
    await expect(
      page.getByRole("heading", { name: "This session has ended" }),
    ).toBeVisible();
    await expect(page.getByText("pnpm start")).toBeVisible();
    await accessible(page);
  });

  test("while Rufi is stopped the page keeps what it read; a restart needs a new link", async ({
    page,
    rufi,
  }) => {
    await rufi.family();
    const { port } = await rufi.start();
    await page.goto(rufi.link());
    await expect(
      page.getByRole("heading", { name: "Health record" }),
    ).toBeVisible();

    await rufi.stop();
    await sidebar(page).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Rufi can't be reached. If you stopped it, run pnpm start",
    );
    // What the page had read stays.
    await sidebar(page).getByRole("link", { name: "Overview" }).click();
    await expect(
      page.getByRole("heading", { name: "Health record" }),
    ).toBeVisible();

    await rufi.start({ port });
    await expect(
      page.getByRole("heading", { name: "This session has ended" }),
    ).toBeVisible();
    await page.goto(rufi.link());
    await expect(
      page.getByRole("heading", { name: "Health record" }),
    ).toBeVisible();
  });
});

test("follows the Mac's light or dark appearance, also when it changes while Rufi is open; readable in the dark", async ({
  page,
  rufi,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await rufi.family();
  await rufi.start();
  await page.goto(rufi.link());
  await expect(
    page.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();
  const background = () =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await theme(page)()).toBe("dark");
  const dark = await background();
  await accessible(page);

  // The chat with a reply, and a help page with code and a table.
  const chat = page.getByRole("region", { name: "Chat" });
  const box = chat.getByRole("textbox", { name: "Message to Rufi" });
  await chat.getByRole("button", { name: "Open the chat" }).click();
  await box.fill("Hello in the dark");
  await box.press("Enter");
  await expect(chat.locator(".reply")).toHaveText("ok:Hello in the dark");
  await accessible(page);
  await page.keyboard.press("Escape");
  await page.goto(new URL("/help/backups-and-export", page.url()).href);
  await expect(page.locator(".prose table")).toBeVisible();
  await accessible(page);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(theme(page)).toBe("light");
  expect(await background()).not.toBe(dark);
});

test("Settings chooses light, dark or the Mac's; every open tab changes at once, and a new tab or a restart starts in it", async ({
  context,
  page,
  rufi,
}) => {
  // The theme each page shows in its first frame, before anything paints.
  await context.addInitScript(() => {
    requestAnimationFrame(() => {
      sessionStorage.setItem(
        "first-frame",
        document.documentElement.dataset["theme"] ?? "",
      );
    });
  });
  const firstFrame = (tab: Page) =>
    tab.evaluate(() => sessionStorage.getItem("first-frame"));
  await rufi.family();
  const { port } = await rufi.start();
  await page.goto(rufi.link());
  await sidebar(page).getByRole("link", { name: "Settings" }).click();
  const appearance = page.getByRole("radiogroup", { name: "Appearance" });
  await expect(appearance.getByRole("radio", { name: "System" })).toBeChecked();
  expect(await theme(page)()).toBe("light");
  const other = await context.newPage();
  await other.goto((await runningLink(rufi.home)) ?? "");
  await expect(
    other.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();

  await appearance.getByRole("radio", { name: "Dark" }).check();
  await expect.poll(theme(page)).toBe("dark");
  await expect.poll(theme(other)).toBe("dark");
  await accessible(page);
  const fresh = await context.newPage();
  await fresh.goto((await runningLink(rufi.home)) ?? "");
  await expect(
    fresh.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();
  expect(await firstFrame(fresh)).toBe("dark");

  await rufi.stop();
  await rufi.start({ port });
  await page.goto(rufi.link());
  await expect(
    page.getByRole("heading", { name: "Health record" }),
  ).toBeVisible();
  expect(await firstFrame(page)).toBe("dark");

  // Light stays light on a dark Mac; System follows the Mac again.
  await page.emulateMedia({ colorScheme: "dark" });
  await sidebar(page).getByRole("link", { name: "Settings" }).click();
  await expect(appearance.getByRole("radio", { name: "Dark" })).toBeChecked();
  await appearance.getByRole("radio", { name: "Light" }).check();
  await expect.poll(theme(page)).toBe("light");
  await accessible(page);
  await appearance.getByRole("radio", { name: "System" }).check();
  await expect.poll(theme(page)).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(theme(page)).toBe("light");
});

test("a settings read from before a save never undoes the look just chosen", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.goto(rufi.link());
  await sidebar(page).getByRole("link", { name: "Settings" }).click();
  const appearance = page.getByRole("radiogroup", { name: "Appearance" });
  await appearance.getByRole("radio", { name: "Dark" }).check();
  await expect.poll(theme(page)).toBe("dark");

  // Another tab changed a setting: this one reads them again, and the
  // answer (Dark) is slow to arrive.
  const held: (() => Promise<void>)[] = [];
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    held.push(() => route.fulfill({ response }));
  });
  await page.evaluate(() => {
    new BroadcastChannel("rufi.settings").postMessage("changed");
  });
  await expect.poll(() => held.length).toBe(1);

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings") &&
      response.request().method() === "PUT",
  );
  await appearance.getByRole("radio", { name: "Light" }).check();
  expect((await saved).ok()).toBe(true);
  const late = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings") &&
      response.request().method() === "GET",
  );
  await held[0]?.();
  await late;
  // The page has handled the late answer.
  await page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => setTimeout(done, 100))),
  );
  expect(await theme(page)()).toBe("light");
  await expect(appearance.getByRole("radio", { name: "Light" })).toBeChecked();
});

test.describe("first run", () => {
  test("not a doctor, your name, sign-in or skip, the region; a reload continues where it was", async ({
    page,
    rufi,
  }) => {
    rufi.account = { account: "signed_out", email: null };
    await rufi.start();
    await page.goto(rufi.link());
    // Each step fills the window: no sidebar, toolbar or chat, and no
    // link to anything else, until the first run is done.
    const title = page.getByRole("banner").getByRole("heading");
    const welcoming = async () => {
      await expect(page.getByRole("main").getByRole("heading")).toBeVisible();
      await expect(sidebar(page)).toHaveCount(0);
      await expect(page.getByRole("banner")).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Chat", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("link")).toHaveCount(0);
    };
    await expect(
      page.getByRole("heading", { name: "Welcome to Rufi" }),
    ).toBeVisible();
    await welcoming();
    await expect(page.getByRole("main")).toContainText(
      "Rufi uses AI. What you ask, the documents you add and the parts of your health record the AI reads go to the AI provider you sign in with. Your health record is kept on your Mac.",
    );
    await accessible(page);
    // The look can be chosen here too, and stays chosen.
    await page
      .getByRole("radiogroup", { name: "Appearance" })
      .getByRole("radio", { name: "Dark" })
      .check();
    await expect.poll(theme(page)).toBe("dark");
    await accessible(page);
    const next = page.getByRole("button", { name: "Continue" });
    await expect(next).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "I understand Rufi is not a doctor" })
      .check();
    await next.click();

    const name = page.getByRole("textbox", { name: "What's your name?" });
    await expect(name).toBeFocused();
    await page.reload();
    await name.fill("Mira Fictional");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Sign in with ChatGPT", level: 1 }),
    ).toBeVisible();
    await welcoming();
    await accessible(page);
    // Another page's address shows the step too.
    await page.goto(new URL("/settings", page.url()).href);
    await expect(
      page.getByRole("heading", { name: "Sign in with ChatGPT", level: 1 }),
    ).toBeVisible();
    await welcoming();
    await page.getByRole("button", { name: "Skip for now" }).click();

    const region = page.getByRole("combobox", { name: "Emergency region" });
    await welcoming();
    await accessible(page);
    await page.reload();
    await region.selectOption("IN");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: /, Mira Fictional$/ }),
    ).toBeVisible();
    // A new record: every page's tile is there, empty.
    for (const name of ["Lab results", "Measurements"]) {
      await expect(
        page.getByRole("main").getByRole("link", { name: `${name} None yet` }),
      ).toBeVisible();
    }
    await expect(sidebar(page)).toContainText("Mira Fictional");
    await expect(title).toHaveText("Overview");
    // The person's chat was made with them: the bar works at once.
    const bar = page.getByRole("region", { name: "Chat" });
    await bar.getByRole("button", { name: "Open the chat" }).click();
    await bar
      .getByRole("textbox", { name: "Message to Rufi" })
      .fill("Hello from the first page");
    await bar.getByRole("textbox", { name: "Message to Rufi" }).press("Enter");
    // Signed out, it waits; signing in alone sends nothing.
    const waiting = bar.getByRole("region", { name: "Waiting messages" });
    await expect(waiting).toContainText(
      "You're signed out. Sign in, then Send.",
    );
    rufi.account = { account: "signed_in", email: "mira@example.com" };
    await waiting.getByRole("button", { name: "Send", exact: true }).click();
    await expect(bar.locator(".reply")).toHaveText(
      "ok:Hello from the first page",
    );
    await sidebar(page).getByRole("link", { name: "Chat with Rufi" }).click();
    await expect(page.locator(".reply")).toHaveText(
      "ok:Hello from the first page",
    );
    await sidebar(page).getByRole("link", { name: "Settings" }).click();
    await expect(
      page.getByRole("combobox", { name: "Emergency region" }),
    ).toHaveValue("IN");
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  });

  test("signs in with ChatGPT from the app", async ({ page, rufi }) => {
    rufi.account = { account: "signed_out", email: null };
    await rufi.start();
    await page.goto(rufi.link());
    await page
      .getByRole("checkbox", { name: "I understand Rufi is not a doctor" })
      .check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page
      .getByRole("textbox", { name: "What's your name?" })
      .fill("Mira Fictional");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Your browser opens ChatGPT's sign-in.",
    );
    await expect(
      page.getByRole("link", { name: "open the sign-in page" }),
    ).toHaveAttribute("href", "https://auth.example.com/authorize?fictional=1");
    expect(rufi.signIns).toHaveLength(1);
    rufi.signIns[0]?.resolve(undefined);

    await page
      .getByRole("combobox", { name: "Emergency region" })
      .selectOption("IN");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(sidebar(page)).toContainText("Mira Fictional");
    await expect(sidebar(page)).not.toContainText("Not signed in");
  });

  test("shows nothing of the app until first run is known to be done", async ({
    page,
    rufi,
  }) => {
    await rufi.family();
    await rufi.start();
    const answer = Promise.withResolvers<undefined>();
    await page.route("**/api/first-run", async (route) => {
      await answer.promise;
      await route.continue();
    });
    await page.goto(rufi.link());
    await expect.poll(() => page.getByRole("link").count()).toBe(0);
    await expect(sidebar(page)).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Chat", exact: true }),
    ).toHaveCount(0);
    answer.resolve(undefined);
    await expect(sidebar(page).getByRole("link")).toHaveText([
      "Chat with Rufi",
      "Overview",
      "Lab results7",
      "Measurements3",
      "Medicines2",
      "Prescriptions",
      "Conditions",
      "Allergies",
      "Symptoms",
      "Care events",
      "Follow-ups",
      "Documents",
      "Help",
      "Settings",
    ]);
  });

  test("two tabs make one person", async ({ page, rufi, context }) => {
    await rufi.start();
    await page.goto(rufi.link());
    await page
      .getByRole("checkbox", { name: "I understand Rufi is not a doctor" })
      .check();
    await page.getByRole("button", { name: "Continue" }).click();
    const other = await context.newPage();
    await other.goto(rufi.link());

    await other
      .getByRole("textbox", { name: "What's your name?" })
      .fill("Mira F.");
    await page
      .getByRole("textbox", { name: "What's your name?" })
      .fill("Mira Fictional");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("combobox", { name: "Emergency region" }),
    ).toBeVisible();
    // The other tab still shows the form; its name isn't added.
    await other.getByRole("button", { name: "Continue" }).click();
    const region = other.getByRole("combobox", { name: "Emergency region" });
    await region.selectOption("IN");
    await other.getByRole("button", { name: "Continue" }).click();
    await expect(sidebar(other)).toContainText("Mira Fictional");
  });
});

test.describe("sign-in status", () => {
  test("signed in: nothing to say", async ({ page, rufi }) => {
    await rufi.family();
    await rufi.start();
    const status = page.waitForResponse((response) =>
      response.url().endsWith("/api/status"),
    );
    await page.goto(rufi.link());
    expect((await status).status()).toBe(200);
    await expect(
      sidebar(page).getByRole("link", { name: "Settings" }),
    ).toBeVisible();
    await expect(sidebar(page)).not.toContainText(/signed in|ChatGPT/);

    // Settings says which plan the AI uses, first, with its usage page.
    await sidebar(page).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(
      "ChatGPT plan",
    );
    await expect(page.getByRole("main")).toContainText(
      "Rufi's AI uses your ChatGPT plan (asha@example.com). Manage usage",
    );
    const usage = page.getByRole("link", { name: "Manage usage" });
    await expect(usage).toHaveAttribute(
      "href",
      "https://chatgpt.com/codex/settings/usage",
    );
    await expect(usage).toHaveAttribute("target", "_blank");
  });

  test("signed out links to signing in", async ({ page, rufi }) => {
    rufi.account = { account: "signed_out", email: null };
    await rufi.family();
    await rufi.start();
    await page.goto(rufi.link());
    await sidebar(page).getByRole("link", { name: "Not signed in" }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in with ChatGPT" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in with ChatGPT" }),
    ).toBeVisible();
    await accessible(page);

    // Settings says so too, and signs in the same way.
    await sidebar(page).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("main")).toContainText(
      "Not signed in. Rufi's AI needs your ChatGPT plan to answer. Sign in",
    );
    await expect(page.getByRole("main")).not.toContainText("Manage usage");
    await accessible(page);
    await page
      .getByRole("main")
      .getByRole("link", { name: "Sign in", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Sign in with ChatGPT" }),
    ).toBeVisible();
  });

  test("signed in, but the plan can't be used", async ({ page, rufi }) => {
    rufi.account = { account: "no_plan_use", email: "asha@example.com" };
    await rufi.family();
    await rufi.start();
    await page.goto(rufi.link());
    await expect(
      sidebar(page).getByRole("link", { name: "ChatGPT plan can't be used" }),
    ).toBeVisible();
    await sidebar(page).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("main")).toContainText(
      "You are signed in, but ChatGPT plan use isn't allowed for Rufi. Sign in again",
    );
    await expect(
      page.getByRole("main").getByRole("link", { name: "Sign in again" }),
    ).toHaveAttribute("href", "/sign-in");
  });
});

test.describe("Overview", () => {
  test("a page that fails leaves the frame working", async ({ page, rufi }) => {
    await rufi.family();
    await rufi.start();
    await page.route("**/overview", (route) =>
      route.fulfill({
        status: 500,
        json: { error: "Rufi had a problem reading the record." },
      }),
    );
    await page.goto(rufi.link());
    await expect(page.getByRole("alert")).toContainText(
      "Rufi had a problem reading the record.",
    );
    // The sidebar works while the page shows its error.
    await sidebar(page).getByRole("link", { name: "Help" }).click();
    await expect(
      page.getByRole("heading", { name: "Rufi help", level: 1 }),
    ).toBeVisible();
    await sidebar(page).getByRole("link", { name: "Overview" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    await page.unroute("**/overview");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("heading", { name: "Health record" }),
    ).toBeVisible();
  });
});

test.describe("when Rufi is slow or away", () => {
  test("a read that never answers shows Rufi as offline", async ({
    page,
    rufi,
  }) => {
    await rufi.family();
    await rufi.start();
    await page.clock.install();
    await page.route("**/api/people", () => undefined);
    // The clock moves only once the page has asked: until its session is
    // started, it asks nothing.
    const asked = page.waitForRequest("**/api/people");
    await page.goto(rufi.link());
    await asked;
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.clock.runFor(15_000);
    await expect(page.getByRole("status")).toContainText(
      "Rufi can't be reached.",
    );
  });

  test("an answer that stops halfway shows Rufi as offline", async ({
    page,
    rufi,
  }) => {
    await rufi.family();
    await rufi.start();
    await page.clock.install();
    // The headers arrive, then the body stops. As with a real fetch, the body
    // ends only when the request is aborted.
    await page.addInitScript(() => {
      const real = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        if (input !== "/api/people") return real(input, init);
        document.documentElement.dataset["asked"] = "people";
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"people":['));
            init?.signal?.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      };
    });
    await page.goto(rufi.link());
    // The clock moves only once the page has asked: until its session is
    // started, it asks nothing.
    await expect(page.locator("html")).toHaveAttribute("data-asked", "people");
    await page.clock.runFor(15_000);
    await expect(page.getByRole("status")).toContainText(
      "Rufi can't be reached.",
    );
  });

  test("after a long outage the page comes back by itself", async ({
    page,
    rufi,
  }) => {
    await rufi.family();
    await rufi.start();
    await page.clock.install();
    await page.goto(rufi.link());
    await expect(
      page.getByRole("heading", { name: "Health record" }),
    ).toBeVisible();

    await page.route("**/api/**", (route) => route.abort());
    await sidebar(page).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Rufi can't be reached.",
    );
    // Two checks fail while it is away.
    await page.clock.runFor(7_000);
    await expect(page.getByRole("status")).toBeVisible();

    await page.unroute("**/api/**");
    await page.clock.runFor(3_000);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Emergency region" }),
    ).toBeVisible();
  });
});

test("Settings keeps the emergency region the AI uses, and clears it", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.goto(rufi.link());
  await sidebar(page).getByRole("link", { name: "Settings" }).click();
  const region = page.getByRole("combobox", { name: "Emergency region" });
  await expect(region).toHaveValue("");
  await expect(region.getByRole("option", { name: "India (112)" })).toHaveCount(
    1,
  );
  await accessible(page);

  await region.selectOption("IN");
  await expect(region).toHaveValue("IN");
  await page.reload();
  await expect(region).toHaveValue("IN");

  await region.selectOption("");
  await expect(region).toHaveValue("");
  await page.reload();
  await expect(region).toHaveValue("");
});

test("Settings backs up, says when a backup failed, and exports your data", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.goto(rufi.link());
  // Settings opens while the backup Rufi makes as it starts still runs; the
  // page follows it to its end by itself.
  let first = true;
  await page.route("**/api/backups", async (route) => {
    if (!first || route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    first = false;
    await route.fulfill({
      json: { last: null, failed: null, running: true },
    });
  });
  await sidebar(page).getByRole("link", { name: "Settings" }).click();
  await expect(
    page.getByRole("button", { name: "Backing up…" }),
  ).toBeDisabled();
  // Rufi is still finding its backups: it doesn't claim there are none.
  await expect(page.getByText(/No backup yet/)).toHaveCount(0);
  await expect(page.getByText(/^Last backup at \d\d:\d\d on /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Back up now" })).toBeEnabled();
  await accessible(page);

  await chmod(join(rufi.home, "backups"), 0o500);
  try {
    await page.getByRole("button", { name: "Back up now" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      /^The last try failed at \d\d:\d\d on .+: the backups folder can't be written\. Your last good backup is from \d\d:\d\d on /,
    );
  } finally {
    await chmod(join(rufi.home, "backups"), 0o700);
  }
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Backed up just now.");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export my data" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^rufi-export-\d{4}-\d{2}-\d{2}\.zip$/,
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Exported" }),
  ).toHaveText("Exported your data as a zip.");
});

test("an export that doesn't come in time says so, and can be tried again", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.clock.install();
  await page.goto(rufi.link());
  await sidebar(page).getByRole("link", { name: "Settings" }).click();
  // Rufi takes the request and never answers.
  await page.route("**/api/export", () => undefined);
  await page.getByRole("button", { name: "Export my data" }).click();
  await expect(page.getByRole("button", { name: "Exporting…" })).toBeDisabled();
  // Five minutes pass, as with the Mac's lid closed: each due timer fires
  // once. runFor would play every chain of timers in those minutes (the
  // stream's silence limit, read deadlines, retries) faster than the core
  // can answer, so the page would keep going offline and reading again.
  await page.clock.fastForward(5 * 60_000);
  await expect(page.getByRole("alert")).toHaveText(
    "The export didn't come in time. Try again.",
  );
  await expect(
    page.getByRole("button", { name: "Export my data" }),
  ).toBeEnabled();
});

test.describe("Help", () => {
  test("pages, links between them, anchors and the glossary", async ({
    page,
    rufi,
  }) => {
    await rufi.family();
    await rufi.start();
    await page.goto(rufi.link());
    await sidebar(page).getByRole("link", { name: "Help" }).click();
    await expect(
      page.getByRole("heading", { name: "Rufi help", level: 1 }),
    ).toBeVisible();
    await accessible(page);

    await page.getByRole("link", { name: "Glossary" }).click();
    await expect(page).toHaveURL(/\/help\/glossary$/);
    await expect(
      page.getByRole("heading", { name: "Rufi glossary" }),
    ).toBeVisible();

    // A deep link survives a reload.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Rufi glossary" }),
    ).toBeVisible();

    await page.goBack();
    await page.getByRole("link", { name: "Getting started" }).click();
    await page
      .getByRole("link", { name: "Signing in with ChatGPT" })
      .first()
      .click();
    await expect(page).toHaveURL(/\/help\/signing-in#sign-in-in-rufi$/);
    await expect(
      page.getByRole("heading", { name: "Sign in in Rufi", exact: true }),
    ).toBeInViewport();
  });

  test("web links open outside Rufi", async ({ page, rufi }) => {
    await rufi.family();
    await rufi.start();
    await page.goto(rufi.link());
    await page.goto(new URL("/help/your-data-and-the-ai", page.url()).href);
    const web = page.locator('a[href^="https://"]').first();
    await expect(web).toHaveAttribute("target", "_blank");
    await expect(web).toHaveAttribute("rel", "noopener noreferrer");
  });
});
