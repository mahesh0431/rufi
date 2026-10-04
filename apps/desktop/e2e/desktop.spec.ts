/// <reference lib="dom" />
// The Rufi app on the real `rufi start`: whose Rufi the window opens on, what
// quitting and crashing leave behind, what the person is told when something
// fails, new windows, and what the page can't do. Dock, menus, focus and the
// looks are checked by hand on the Mac.
import { existsSync } from "node:fs";
import { join } from "node:path";
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

  test("when the Rufi that pnpm start runs stops, a new window starts its own", async ({
    desktop,
  }) => {
    const { rufi } = await desktop.terminal();
    const app = await desktop.launch();
    await working(await app.electron.firstWindow());
    rufi.kill("SIGINT");
    await ended(rufi.pid ?? 0);

    // ⌘W, then a click on Rufi in the Dock.
    await app.electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect.poll(() => app.electron.windows().length).toBe(0);
    const opened = app.electron.waitForEvent("window");
    await app.electron.evaluate(({ app }) => {
      app.emit("activate");
    });
    await working(await opened);
    await core(desktop, app);
    expect(app.told).toEqual([]);
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
    test(`${how} stops the Rufi it started, as Ctrl-C does, even when the page asks to stay`, async ({
      desktop,
    }) => {
      const app = await desktop.launch();
      const page = await app.electron.firstWindow();
      await working(page);
      const pid = await core(desktop, app);
      // A page may ask to stay ("Leave site?") once the person has used it,
      // and the answer is Stay.
      page.on("dialog", (dialog) => void dialog.dismiss());
      await page.evaluate(() => {
        addEventListener("beforeunload", (event) => {
          event.preventDefault();
        });
      });
      await page.getByLabel("What's your name?").click();

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
    // Asked, and only looked up.
    expect(await page.evaluate(() => Notification.requestPermission())).toBe(
      "denied",
    );
    expect(
      await page.evaluate(async () => [
        Notification.permission,
        (await navigator.permissions.query({ name: "geolocation" })).state,
      ]),
    ).toEqual(["denied", "denied"]);
  });

  test("saves no download", async ({ desktop }) => {
    const app = await desktop.launch();
    const page = await app.electron.firstWindow();
    await working(page);
    // A same-origin file that the network sends as an attachment.
    await page.route("**/results.txt", (route) =>
      route.fulfill({
        headers: { "content-disposition": "attachment; filename=results.txt" },
        body: "fictional results",
      }),
    );
    // Should a download get through, it goes to the test's folder, so it
    // shows as a file there instead of a Mac save dialog.
    const saved = join(desktop.folder, "results.txt");
    await app.electron.evaluate(({ session }, saved) => {
      session.fromPartition("rufi").on("will-download", (_event, item) => {
        item.setSavePath(saved);
        item.once("done", (_done, state) => {
          console.log(`rufi-test download ${JSON.stringify(state)}`);
        });
      });
    }, saved);
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "/results.txt";
      a.textContent = "a test link";
      a.style.cssText = "position: fixed; top: 120px; left: 320px";
      document.body.append(a);
    });
    await page.mouse.click(324, 124);

    await expect
      .poll(() => app.told)
      .toEqual([{ kind: "download", value: "cancelled" }]);
    expect(existsSync(saved)).toBe(false);
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
    const link = async (href: string, target = "", how = "click") => {
      await page.evaluate(
        ([href, target]) => {
          const a = document.createElement("a");
          a.href = href ?? "";
          a.target = target ?? "";
          a.textContent = "a test link";
          a.style.cssText = "position: fixed; top: 120px; left: 320px";
          document.body.append(a);
          a.focus();
        },
        [href, target],
      );
      // The mouse where the link is, or Return: Playwright's locators would
      // wait for the navigation the app refuses.
      if (how === "Return") await page.keyboard.press("Enter");
      else await page.mouse.click(324, 124);
      await page.evaluate(() => {
        for (const a of document.querySelectorAll("a")) {
          if (a.textContent === "a test link") a.remove();
        }
      });
    };

    // A same-origin page in a frame, with a web link and a script that
    // opens one; the network answers it without Rufi's guards.
    await page.route("**/framed", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<a href="https://example.com/clicked-in-frame" target="_blank" style="display: block; height: 100vh">a link</a>
<script>open("https://example.com/opened-by-frame")</script>`,
      }),
    );

    // Nobody clicked: the page goes nowhere and opens nothing by itself.
    await page.evaluate(() => {
      location.href = "https://example.com/went-by-itself";
    });
    await page.evaluate(() => {
      window.open("https://example.com/opened-by-script");
    });
    // Return on a link, before any click.
    await link("https://example.com/by-keyboard", "", "Return");
    // A frame shows nothing, so a click in it opens nothing either. One from
    // this Mac loads within milliseconds, if it loads at all.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const frame = document.createElement("iframe");
          frame.src = "/framed";
          frame.style.cssText =
            "position: fixed; top: 200px; left: 320px; width: 200px; height: 100px";
          frame.addEventListener("load", resolve);
          setTimeout(resolve, 1_000);
          document.body.append(frame);
        }),
    );
    await page.mouse.click(420, 250);

    await link("https://example.com/clicked");
    await link("https://example.com/new-tab", "_blank");
    await link("/away");
    await link("file:///etc/hosts");

    await expect
      .poll(() => app.told)
      .toEqual([
        { kind: "browser", value: "https://example.com/by-keyboard" },
        { kind: "browser", value: "https://example.com/clicked" },
        { kind: "browser", value: "https://example.com/new-tab" },
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
