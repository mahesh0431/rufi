/// <reference lib="dom" />
// The Rufi app on the real `rufi start`: whose Rufi the window opens on, what
// quitting and crashing leave behind, what the person is told when something
// fails, new windows, and what the page can't do. Dock, menus, focus and the
// looks are checked by hand on the Mac.
import type { Page } from "@playwright/test";
import { holdRufiLock } from "../../server/src/platform/files.ts";
import {
  alive,
  type App,
  type Desktop,
  ended,
  expect,
  rufiStarts,
  test,
} from "./app.ts";

/** The first-run question: the page loaded and its session works. */
const working = (page: Page) =>
  expect(page.getByLabel("What's your name?")).toBeVisible();

/** The app's only `rufi start`, which runs its Rufi. */
async function core(desktop: Desktop, app: App): Promise<number> {
  const found = await rufiStarts(app.process.pid);
  expect(found).toHaveLength(1);
  const pid = found[0] ?? 0;
  desktop.cores.add(pid);
  return pid;
}

test.describe("starting", () => {
  test("opens on the Rufi it starts", async ({ desktop }) => {
    const app = await desktop.launch();
    await working(await app.electron.firstWindow());
    expect(await desktop.running()).toBe(true);
    await core(desktop, app);
  });

  test("opens on the Rufi that pnpm start runs, and leaves it running when it quits", async ({
    desktop,
  }) => {
    const { rufi } = await desktop.terminal();
    const app = await desktop.launch();
    await working(await app.electron.firstWindow());
    // It found that Rufi: it runs none of its own.
    expect(await rufiStarts(app.process.pid)).toEqual([]);

    await app.electron.evaluate(({ app }) => {
      app.quit();
    });
    expect(await app.exited).toBe(0);
    expect(rufi.exitCode).toBeNull();
    expect(await desktop.running()).toBe(true);
  });

  test("says why when Rufi can't start, and opens no window", async ({
    desktop,
  }) => {
    // Another Rufi command has the data folder.
    const release = await holdRufiLock(desktop.home, () => undefined);
    try {
      const app = await desktop.launch();
      const windows: unknown[] = [];
      app.electron.on("window", (page) => windows.push(page));
      expect(await app.exited).toBe(0);
      expect(app.told).toEqual([
        {
          kind: "dialog",
          value: {
            message: "Rufi couldn't start",
            detail:
              "Rufi is already running with this data folder, or another Rufi command is. Quit it first, then try again.",
          },
        },
      ]);
      expect(windows).toEqual([]);
    } finally {
      await release();
    }
  });

  test("a second launch leaves one window; after the window closes, it opens a new one", async ({
    desktop,
  }) => {
    const app = await desktop.launch();
    await working(await app.electron.firstWindow());

    expect(await desktop.again()).toBe(0);
    expect(app.electron.windows()).toHaveLength(1);

    // ⌘W: the window closes, Rufi keeps running.
    const pid = await core(desktop, app);
    await app.electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect.poll(() => app.electron.windows().length).toBe(0);
    expect(await rufiStarts(app.process.pid)).toEqual([pid]);

    // Opening the app again opens a window with a fresh link that works.
    const opened = app.electron.waitForEvent("window");
    expect(await desktop.again()).toBe(0);
    await working(await opened);
  });
});

test.describe("stopping", () => {
  for (const how of ["⌘Q", "SIGTERM"] as const) {
    test(`${how} stops the Rufi it started, as Ctrl-C does`, async ({
      desktop,
    }) => {
      const app = await desktop.launch();
      await working(await app.electron.firstWindow());
      const pid = await core(desktop, app);

      if (how === "⌘Q") {
        await app.electron.evaluate(({ app }) => {
          app.quit();
        });
      } else {
        app.process.kill("SIGTERM");
      }
      // The app waits for Rufi: it has stopped when the app has quit.
      await app.exited;
      expect(alive(pid)).toBe(false);
      // Rufi removes core.json only when it stops in order.
      expect(await desktop.running()).toBe(false);
      expect(app.told).toEqual([]);
    });
  }

  for (const how of ["⌘Q", "SIGTERM"] as const) {
    test(`${how} waits for a Rufi that doesn't stop, and kills it after 10 s`, async ({
      desktop,
    }) => {
      const app = await desktop.launch();
      await working(await app.electron.firstWindow());
      const pid = await core(desktop, app);
      // Rufi hangs: it can't stop by itself.
      process.kill(pid, "SIGSTOP");

      const asked = Date.now();
      if (how === "⌘Q") {
        await app.electron.evaluate(({ app }) => {
          app.quit();
        });
      } else {
        app.process.kill("SIGTERM");
      }
      await app.exited;
      expect(Date.now() - asked).toBeGreaterThanOrEqual(9_500);
      expect(alive(pid)).toBe(false);
    });
  }

  test("when the app dies, the Rufi it started stops by itself", async ({
    desktop,
  }) => {
    const app = await desktop.launch();
    await working(await app.electron.firstWindow());
    const pid = await core(desktop, app);

    app.process.kill("SIGKILL");
    await ended(pid);
    expect(await desktop.running()).toBe(false);
  });

  test("when the Rufi it started stops, the app says so and quits", async ({
    desktop,
  }) => {
    const app = await desktop.launch();
    await working(await app.electron.firstWindow());

    process.kill(await core(desktop, app), "SIGKILL");
    expect(await app.exited).toBe(0);
    expect(app.told).toEqual([
      {
        kind: "dialog",
        value: {
          message: "Rufi stopped",
          detail:
            "The Rufi that this app started has stopped. Open the app again to start it.",
        },
      },
    ]);
  });
});

test.describe("the page", () => {
  test("has nothing of Node or Electron and asks for nothing", async ({
    desktop,
  }) => {
    const app = await desktop.launch();
    const page = await app.electron.firstWindow();
    await working(page);
    expect(
      await page.evaluate(() => [
        typeof (window as { require?: unknown }).require,
        typeof (window as { process?: unknown }).process,
        typeof (window as { module?: unknown }).module,
      ]),
    ).toEqual(["undefined", "undefined", "undefined"]);
    expect(await page.evaluate(() => Notification.requestPermission())).toBe(
      "denied",
    );
  });

  test("keeps Rufi in the window and sends web links to the browser", async ({
    desktop,
  }) => {
    const app = await desktop.launch();
    const page = await app.electron.firstWindow();
    await working(page);
    const home = page.url();
    // A same-origin path that the network answers with a redirect away.
    await page.route("**/away", (route) =>
      route.fulfill({
        status: 302,
        headers: { location: "https://example.com/redirected" },
      }),
    );
    const link = async (href: string, target = "") => {
      await page.evaluate(
        ([href, target]) => {
          const a = document.createElement("a");
          a.href = href ?? "";
          a.target = target ?? "";
          a.textContent = "a test link";
          a.style.cssText = "position: fixed; top: 120px; left: 320px";
          document.body.append(a);
        },
        [href, target],
      );
      // A click with the mouse where the link is: Playwright's locators
      // would wait for the navigation the app refuses.
      await page.mouse.click(324, 124);
      await page.evaluate(() => {
        for (const a of document.querySelectorAll("a")) {
          if (a.textContent === "a test link") a.remove();
        }
      });
    };

    await link("https://example.com/clicked");
    await link("https://example.com/new-tab", "_blank");
    await link("/away");
    await link("file:///etc/hosts");
    await page.evaluate(() => {
      window.open("https://example.com/opened-by-script");
    });

    await expect
      .poll(() => app.told)
      .toEqual([
        { kind: "browser", value: "https://example.com/clicked" },
        { kind: "browser", value: "https://example.com/new-tab" },
        { kind: "browser", value: "https://example.com/opened-by-script" },
      ]);
    // No other window opened, not even for a moment.
    expect(
      await app.electron.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);
    expect(page.url()).toBe(home);
    await working(page);
  });
});
