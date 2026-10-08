// The frame on the real core: opening Rufi, first run, sign-in, Overview,
// Settings and Help, and what the page does when the core is slow or gone.
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { strFromU8, unzipSync } from "fflate";
import type { Page } from "@playwright/test";
import { runningLink } from "../../server/src/server/core.ts";
import { expect, test } from "./rufi.ts";

/** No accessibility rule broken on what the page shows now. */
async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

const sidebar = (page: Page) => page.getByRole("complementary");

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
    await expect(page.getByText("Latest results")).toBeVisible();
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
    await expect(page.getByText("Latest results")).toBeVisible();

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
    await expect(second.getByText("Latest results")).toBeVisible();
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
    await expect(page.getByText("Latest results")).toBeVisible();

    await rufi.stop();
    await sidebar(page).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Rufi can't be reached. If you stopped it, run pnpm start",
    );
    // What the page had read stays.
    await sidebar(page).getByRole("link", { name: "Overview" }).click();
    await expect(page.getByText("Latest results")).toBeVisible();

    await rufi.start({ port });
    await expect(
      page.getByRole("heading", { name: "This session has ended" }),
    ).toBeVisible();
    await page.goto(rufi.link());
    await expect(page.getByText("Latest results")).toBeVisible();
  });
});

test.describe("first run", () => {
  test("not a doctor, your name, sign-in or skip, the region; a reload continues where it was", async ({
    page,
    rufi,
  }) => {
    rufi.account = { account: "signed_out", email: null };
    await rufi.start();
    await page.goto(rufi.link());
    // Each step is titled Welcome, and the sidebar offers no chat
    // or Overview until the first run is done.
    const title = page.getByRole("banner").getByRole("heading");
    const welcoming = async () => {
      await expect(title).toHaveText("Welcome");
      await expect(
        sidebar(page).getByRole("link", { name: "Overview" }),
      ).toHaveCount(0);
      await expect(
        sidebar(page).getByRole("button", { name: "New chat" }),
      ).toHaveCount(0);
    };
    await expect(
      page.getByRole("heading", { name: "Welcome to Rufi" }),
    ).toBeVisible();
    await welcoming();
    await expect(page.getByRole("main")).toContainText(
      "What you ask, and the parts of your record the AI reads to answer, are sent to the AI in the cloud. Your record is kept on your Mac.",
    );
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
      page.getByRole("heading", { name: "Sign in with ChatGPT", level: 2 }),
    ).toBeVisible();
    await welcoming();
    await accessible(page);
    await page.reload();
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
    await expect(
      page.getByText(
        "Your latest results will be shown here when your record has some.",
      ),
    ).toBeVisible();
    await expect(sidebar(page)).toContainText("Mira Fictional");
    await expect(title).toHaveText("Overview");
    await expect(
      sidebar(page).getByRole("button", { name: "New chat" }),
    ).toBeVisible();
    await sidebar(page).getByRole("link", { name: "Settings" }).click();
    await expect(
      page.getByRole("combobox", { name: "Emergency region" }),
    ).toHaveValue("IN");
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

    await expect(
      page.getByRole("combobox", { name: "Emergency region" }),
    ).toBeVisible();
    await expect(sidebar(page)).not.toContainText("Not signed in");
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
    await expect(sidebar(page)).toContainText("Mira Fictional");
    // The other tab still shows the form; its name isn't added.
    await other.getByRole("button", { name: "Continue" }).click();
    await expect(
      other.getByRole("combobox", { name: "Emergency region" }),
    ).toBeVisible();
    await expect(sidebar(other)).toContainText("Mira Fictional");
  });
});

test.describe("sign-in status", () => {
  test("signed in: nothing to say", async ({ page, rufi }) => {
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
  });

  test("signed in, but the plan can't be used", async ({ page, rufi }) => {
    rufi.account = { account: "no_plan_use", email: "asha@example.com" };
    await rufi.start();
    await page.goto(rufi.link());
    await expect(
      sidebar(page).getByRole("link", { name: "ChatGPT plan can't be used" }),
    ).toBeVisible();
  });
});

test.describe("Overview", () => {
  test("shows results as the lab printed them", async ({ page, rufi }) => {
    await rufi.family();
    await rufi.start();
    await page.goto(rufi.link());
    const row = (test: string) =>
      page
        .getByRole("row")
        .filter({ has: page.getByRole("cell", { name: test }) });
    await expect(row("HbA1c")).toContainText("6.8 %4.0 - 5.6High12 Aug 2026");
    await expect(row("Glucose")).toContainText("12 Aug 2026 · Fasting");
    await expect(row("TSH amended")).toContainText("4.6 mIU/L");
    // A partial date stays partial; no date stays empty.
    await expect(row("Vitamin D")).toContainText("May 2026");
    await expect(row("Blood group")).toHaveText("Blood groupB positive");
    await expect(page.getByText(/Showing the newest/)).toHaveCount(0);
  });

  test("says when it shows only the newest results", async ({ page, rufi }) => {
    const more = Array.from(
      { length: 20 },
      (_, index) =>
        `('res-x${String(index)}', 'asha', NULL, 'Test ${String(index)}', '1', NULL, 1, NULL, NULL, NULL, NULL, '2026-09-20', '2026-09-20T10:00:00Z', NULL)`,
    );
    await rufi.family(
      `INSERT INTO results (id, person_id, report_id, test_name, value_text, comparator, value_number,
         unit, reference_range, flag_text, context_text, measured_at, entered_at, replaces_id)
       VALUES ${more.join(",\n")};`,
    );
    await rufi.start();
    await page.goto(rufi.link());
    await expect(
      page.getByText("Showing the newest 20 of 27 results."),
    ).toBeVisible();
  });

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
    await expect(page.getByText("Latest results")).toBeVisible();
  });
});

test.describe("when Rufi is slow or away", () => {
  test("the frame shows while the link is still being opened", async ({
    page,
    rufi,
  }) => {
    await rufi.start();
    // The core never answers the swap.
    await page.route("**/api/session", () => undefined);
    await page.goto(rufi.link());
    await sidebar(page).getByRole("link", { name: "Help" }).click();
    await expect(
      page.getByRole("heading", { name: "Rufi help", level: 1 }),
    ).toBeVisible();
  });

  test("a read that never answers shows Rufi as offline", async ({
    page,
    rufi,
  }) => {
    await rufi.family();
    await rufi.start();
    await page.clock.install();
    await page.route("**/api/people", () => undefined);
    await page.goto(rufi.link());
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
    await expect(page.getByText("Latest results")).toBeVisible();

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
  await rufi.start(); // before first run, too
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

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export my data" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^rufi-export-\d{4}-\d{2}-\d{2}\.zip$/,
  );
  const files = unzipSync(await readFile(await file.path()));
  const folder = file.suggestedFilename().replace(/\.zip$/, "");
  expect(
    strFromU8(files[`${folder}/json/people.json`] ?? new Uint8Array()),
  ).toContain("Asha Fictional");
  await expect(page.getByRole("status")).toHaveText(
    `Exported ${file.suggestedFilename()}.`,
  );
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
  await page.clock.runFor(5 * 60_000);
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
    await rufi.start();
    await page.goto(rufi.link());
    await page.goto(new URL("/help/your-data-and-the-ai", page.url()).href);
    const web = page.locator('a[href^="https://"]').first();
    await expect(web).toHaveAttribute("target", "_blank");
    await expect(web).toHaveAttribute("rel", "noopener noreferrer");
  });
});
