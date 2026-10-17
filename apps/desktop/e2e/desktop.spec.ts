/// <reference lib="dom" />
// The Rufi app on the real `rufi start`: whose Rufi the window opens on, what
// quitting and crashing leave behind, what the person is told when something
// fails, new windows, and what the page can't do. Dock, menus, focus and the
// looks are checked by hand on the Mac.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { unzipSync } from "fflate";
import {
  databasePath,
  openWritable,
} from "../../server/src/core/store/database.ts";
import { holdRufiLock } from "../../server/src/platform/files.ts";
import {
  FAMILY,
  familyFiles,
  FIRST_RUN_DONE,
} from "../../server/tests/fixtures/golden.ts";
import {
  alive,
  type App,
  type Desktop,
  ended,
  expect,
  naming,
  rufiStarts,
  test,
} from "./app.ts";

/** The first run's welcome: the page loaded and its session works. */
const working = (page: Page) =>
  expect(page.getByRole("heading", { name: "Welcome to Rufi" })).toBeVisible();

test.describe("a foreign Rufi home", () => {
  for (const chosen of ["remembered", "alias"] as const) {
    test(`refuses the ${chosen} path without writing or locking it`, async ({
      desktop,
    }) => {
      const root = join(desktop.userHome, ".rufi");
      await mkdir(join(root, "records"), { recursive: true });
      await writeFile(
        join(root, "rufi.db"),
        "the older app's fictional record",
      );
      if (chosen === "remembered") desktop.remembered();
      else await symlink(root, desktop.home);

      const app = await desktop.launch();
      expect(await app.exited).toBe(0);
      expect(app.told).toEqual([
        {
          kind: "dialog",
          value: {
            message: "Rufi couldn't start",
            detail: `${root} holds files that aren't this Rufi's home, perhaps from an older Rufi app. Rufi changed nothing there. Move that folder away (for example to ${root}-old), then start Rufi again.`,
          },
        },
      ]);
      expect((await readdir(root)).sort()).toEqual(["records", "rufi.db"]);
      expect(await readFile(join(root, "rufi.db"), "utf8")).toBe(
        "the older app's fictional record",
      );
      expect(await desktop.running()).toBe(false);
    });
  }
});

/** The app's only `rufi start`, which runs its Rufi. */
async function core(desktop: Desktop, app: App): Promise<number> {
  const found = await rufiStarts(app.process.pid);
  expect(found).toHaveLength(1);
  const pid = found[0] ?? 0;
  desktop.cores.add(pid);
  return pid;
}

/**
 * ⌘W: the app's menu must bind it to Close. On the Mac, Close is the Mac's
 * own action, which only real key presses reach, so the window is closed as
 * that action closes it; elsewhere the menu item does it.
 */
async function commandW(app: App): Promise<void> {
  const closed = await app.electron.evaluate(({ BrowserWindow, Menu }) => {
    const item = Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((entry) => entry.accelerator === "CommandOrControl+W");
    const window = BrowserWindow.getAllWindows()[0];
    if (item?.role !== "close" || window === undefined) return false;
    if (process.platform === "darwin") window.close();
    else {
      // Electron types the item's click loosely; this is how a menu calls it.
      const click = item.click as (
        event: undefined,
        window: typeof BrowserWindow.prototype,
        contents: typeof window.webContents,
      ) => void;
      click(undefined, window, window.webContents);
    }
    return true;
  });
  expect(closed).toBe(true);
}

test("scrolling a chat with activity keeps the sidebar and composer in the window", async ({
  desktop,
}) => {
  await mkdir(desktop.home, { recursive: true });
  const store = openWritable(databasePath(desktop.home));
  try {
    store.db.exec(`
      INSERT INTO settings (key, value) VALUES ('first_run.done', '2026-10-01T09:00:00Z');
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
      INSERT INTO chats (id, person_id, revision, created_at) VALUES ('chat', 'asha', 1, '2026-10-01T09:00:00Z');
      INSERT INTO turns (id, person_id, chat_id, agent_turn_id, thread_id, model, status, started_at, ended_at)
      VALUES ('turn', 'asha', 'chat', 'turn', 'thread', 'gpt-6-astra', 'completed', '2026-10-01T09:00:00Z', '2026-10-01T09:00:01Z');
    `);
    // A saved activity below a long message: its accessible status must
    // stay inside the transcript's scrolling area too.
    const insert = store.db.prepare(`
      INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, activity, status, revision, created_at, updated_at)
      VALUES (?, 'asha', 'chat', ?, 'turn', ?, ?, ?, ?, 1, '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z')
    `);
    insert.run(
      "message",
      1,
      "message",
      "Fictional question\n".repeat(80),
      null,
      null,
    );
    insert.run("activity", 2, "activity", "Read your overview", "tool", "done");
    insert.run("reply", 3, "reply", "Fictional answer", null, null);
  } finally {
    store.close();
  }
  const app = await desktop.launch();
  const page = await app.electron.firstWindow();
  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages).toContainText("Fictional answer");
  const scroller = messages.locator("xpath=../..");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  for (const delta of [1500, -500, 1500, 1500]) {
    await scroller.hover();
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(100);
    expect(
      await scroller.evaluate((element) => {
        const scrolled = [];
        for (
          let parent = element.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          if (parent.scrollTop !== 0) {
            scrolled.push({
              tag: parent.tagName,
              id: parent.id,
              scrollTop: parent.scrollTop,
            });
          }
        }
        return scrolled;
      }),
    ).toEqual([]);
    expect((await page.getByRole("complementary").boundingBox())?.y).toBe(0);
  }
  await page.keyboard.press("ControlOrMeta+j");
  const box = page.getByRole("textbox", { name: "Message to Rufi" });
  await expect(box).toBeFocused();
  const bounds = await box.boundingBox();
  expect(bounds?.y).toBeGreaterThan(0);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThan(
    await page.evaluate(() => innerHeight),
  );
});

test.describe("starting", () => {
  test("opens on the Rufi it starts", async ({ desktop }) => {
    const app = await desktop.launch();
    await working(await app.electron.firstWindow());
    expect(await desktop.running()).toBe(true);
    await core(desktop, app);
  });

  test("with no RUFI_HOME, makes Rufi's own data folder, then opens on the same one, and Settings says so", async ({
    desktop,
  }) => {
    desktop.remembered();
    const first = await desktop.launch();
    await working(await first.electron.firstWindow());
    const root = join(desktop.userHome, ".rufi");
    expect(
      JSON.parse(await readFile(join(root, "location.json"), "utf8")),
    ).toEqual({ version: 1, dataFolder: desktop.home });
    expect(await desktop.running()).toBe(true);
    await first.electron.evaluate(({ app }) => {
      app.quit();
    });
    expect(await first.exited).toBe(0);

    const store = openWritable(databasePath(desktop.home));
    store.db.exec(await readFile(FAMILY, "utf8"));
    store.db.exec(FIRST_RUN_DONE);
    store.close();
    const app = await desktop.launch();
    const page = await app.electron.firstWindow();
    await page.getByRole("link", { name: "Settings" }).click();
    const section = page
      .getByRole("heading", { name: "Data folder" })
      .locator("+ div");
    await expect(section).toContainText(desktop.home);
    await expect(section).toContainText(
      "Rufi made this folder for your data on its first start.",
    );
    // One app for the remembered folder.
    expect(await desktop.again()).toBe(0);
    expect(app.electron.windows()).toHaveLength(1);
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
    await commandW(app);
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
    await commandW(app);
    await expect.poll(() => app.electron.windows().length).toBe(0);
    expect(app.process.exitCode).toBeNull();
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
      await page.getByLabel("I understand Rufi is not a doctor").click();

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

  test("a test's end stops whatever can still write in its folder, before the folder goes", async ({
    desktop,
  }) => {
    const app = await desktop.launch();
    await working(await app.electron.firstWindow());
    // Chromium's helpers (GPU, network, the page) name the app's profile.
    expect((await naming(desktop.folder)).length).toBeGreaterThan(1);
    // One that outlives the app, as a helper can for a moment.
    const helper = spawn(
      process.execPath,
      [
        "-e",
        "setInterval(() => undefined, 1000)",
        "--",
        `--user-data-dir=${join(desktop.folder, "tmp", "profile")}`,
      ],
      { stdio: "ignore" },
    );
    const gone = new Promise((resolve) => helper.once("exit", resolve));

    await desktop.close();
    expect(await naming(desktop.folder)).toEqual([]);
    await gone;
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

test.describe("follow-up notices", () => {
  /** Asha, with a follow-up that was due last year. */
  async function overdue(desktop: Desktop): Promise<void> {
    await mkdir(desktop.home, { recursive: true });
    const store = openWritable(databasePath(desktop.home));
    store.db.exec(await readFile(FAMILY, "utf8"));
    store.db.exec(FIRST_RUN_DONE);
    store.db
      .prepare(
        "INSERT INTO follow_ups (id, person_id, title, due) VALUES ('f-hba1c', 'asha', 'Recheck HbA1c', ?)",
      )
      .run(String(new Date().getFullYear() - 1));
    store.close();
    await familyFiles(desktop.home);
  }

  /** Clicks the app's last notice. */
  const click = (app: App) =>
    app.electron.evaluate(() => {
      (globalThis as { notices?: Electron.Notification[] }).notices
        ?.at(-1)
        ?.emit("click");
    });

  test("tells a follow-up due when Rufi starts, by count only; its click brings the window to Follow-ups", async ({
    desktop,
  }) => {
    await overdue(desktop);
    const app = await desktop.launch();
    const page = await app.electron.firstWindow();
    await page.getByRole("link", { name: "Documents" }).click();

    await expect
      .poll(() => app.told)
      .toEqual([
        {
          kind: "notice",
          value: { title: "Rufi", body: "1 follow-up is overdue" },
        },
      ]);
    await click(app);

    await expect(page).toHaveURL(
      /^http:\/\/127\.0\.0\.1:\d+\/people\/asha\/follow-ups$/,
    );
    // In the same session, the page reads Asha's follow-ups.
    await expect(page.getByRole("region", { name: /^Overdue/ })).toContainText(
      "Recheck HbA1c",
    );
  });

  test("a click with no window open opens one on Follow-ups", async ({
    desktop,
  }) => {
    await overdue(desktop);
    const app = await desktop.launch();
    await app.electron.firstWindow();
    await expect.poll(() => app.told.length).toBe(1);
    await commandW(app);
    await expect
      .poll(() =>
        app.electron.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(0);

    const opened = app.electron.waitForEvent("window");
    await click(app);

    const page = await opened;
    await expect(page).toHaveURL(/\/people\/asha\/follow-ups$/);
    // In the same session, the page reads Asha's follow-ups.
    await expect(page.getByRole("region", { name: /^Overdue/ })).toContainText(
      "Recheck HbA1c",
    );
  });
});

test("the window takes the appearance chosen in Rufi, also as it first shows after a restart", async ({
  desktop,
}) => {
  const app = await desktop.launch();
  const page = await app.electron.firstWindow();
  await working(page);
  const source = (opened: App) =>
    opened.electron.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  expect(await source(app)).toBe("system");
  const appearance = page.getByRole("radiogroup", { name: "Appearance" });
  for (const [label, chosen] of [
    ["Light", "light"],
    ["Dark", "dark"],
  ] as const) {
    await appearance.getByRole("radio", { name: label }).check();
    await expect.poll(() => source(app)).toBe(chosen);
  }
  await app.electron.evaluate(({ app }) => {
    app.quit();
  });
  await app.exited;

  const again = await desktop.launch();
  // The Mac's appearance of the window as it first shows.
  await again.electron.evaluate(({ app, nativeTheme }) => {
    app.on("browser-window-created", (_event, window) => {
      // The window shows when it is ready (window.ts).
      window.once("ready-to-show", () => {
        Object.assign(globalThis, { shownIn: nativeTheme.themeSource });
      });
    });
  });
  const reopened = await again.electron.firstWindow();
  await working(reopened);
  expect(
    await again.electron.evaluate(
      () => (globalThis as { shownIn?: string }).shownIn,
    ),
  ).toBe("dark");
  expect(
    await reopened.evaluate(() => document.documentElement.dataset["theme"]),
  ).toBe("dark");

  await reopened
    .getByRole("radiogroup", { name: "Appearance" })
    .getByRole("radio", { name: "System" })
    .check();
  await expect.poll(() => source(again)).toBe("system");
});

test.describe("the page", () => {
  test("has nothing of Node or Electron, and may only write the clipboard", async ({
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
    // Copy works; reading what else is on the clipboard doesn't.
    expect(
      await page.evaluate(async () => {
        await navigator.clipboard.writeText("Fictional brief");
        return navigator.clipboard.readText().then(
          () => "read",
          (error: unknown) => (error as Error).name,
        );
      }),
    ).toBe("NotAllowedError");
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

  test("saves the export where the person chooses", async ({ desktop }) => {
    // Settings is there once the first run is done.
    await mkdir(desktop.home, { recursive: true });
    const store = openWritable(databasePath(desktop.home));
    store.db.exec(
      "INSERT INTO settings (key, value) VALUES ('first_run.done', '2026-10-01T09:00:00Z')",
    );
    store.close();
    const app = await desktop.launch();
    const page = await app.electron.firstWindow();
    // How the save ended: the file shows before it is all written.
    await app.electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.session.on(
        "will-download",
        (_event, item) => {
          item.once("done", (_done, state) => {
            (globalThis as { saved?: string }).saved = state;
          });
        },
      );
    });
    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.getByRole("status")).toContainText("Exported");
    await expect.poll(() => app.told.map((t) => t.kind)).toEqual(["save"]);
    const { name, path } = (app.told[0]?.value ?? {}) as {
      name: string;
      path: string;
    };
    expect(name).toMatch(/^rufi-export-\d{4}-\d{2}-\d{2}\.zip$/);
    await expect
      .poll(() =>
        app.electron.evaluate(() => (globalThis as { saved?: string }).saved),
      )
      .toBe("completed");
    const files = unzipSync(await readFile(path));
    expect(Object.keys(files)).toContain(
      `${name.replace(/\.zip$/, "")}/README.md`,
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
    /** Clicks a link with the mouse, then takes it away. */
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
      // Playwright's locators would wait for the navigation the app refuses.
      await page.mouse.click(324, 124);
      await page.evaluate(() => {
        for (const a of document.querySelectorAll("a")) {
          if (a.textContent === "a test link") a.remove();
        }
      });
    };

    // Rufi has no frames, and its pages can't be framed, but a frame made
    // without a page has a blank one. That page can try to open a link, or
    // to take the window to one: neither opens anything.
    expect(
      await page.evaluate(() => {
        const frame = document.createElement("iframe");
        document.body.append(frame);
        const inside = frame.contentDocument;
        if (!frame.contentWindow || !inside?.body) return false;
        frame.contentWindow.open("https://example.com/opened-by-frame");
        const a = inside.createElement("a");
        a.href = "https://example.com/followed-by-frame";
        a.target = "_top";
        inside.body.append(a);
        a.click();
        return true;
      }),
    ).toBe(true);
    await page.evaluate(() => {
      for (const frame of document.querySelectorAll("iframe")) frame.remove();
    });

    // Web links that the page follows or opens go to the browser, once each,
    // also while a reply shows a diagram in its locked frame.
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.sandbox.add("allow-scripts");
      frame.src = `/diagram.html#${encodeURIComponent(JSON.stringify({ source: "flowchart LR\n A --> B", colours: {}, font: "sans-serif", dark: false }))}`;
      document.body.append(frame);
    });
    await expect
      .poll(() => page.frames().map((frame) => frame.url()))
      .toContainEqual(expect.stringContaining("/diagram.html#"));
    await link("https://example.com/clicked");
    await link("https://example.com/new-tab", "_blank");
    await page.evaluate(() => {
      for (const frame of document.querySelectorAll("iframe")) frame.remove();
    });
    // Another kind of link, a web link with a name and password in it, and a
    // link to Rufi that the network sends away, don't. (No link here ever
    // names a scheme the Mac itself would open.)
    await page.evaluate(() => {
      window.open("data:text/plain,not-for-the-browser");
    });
    await link("https://someone:secret@example.com/with-password");
    await link("/away");

    await expect
      .poll(() => app.told)
      .toEqual([
        { kind: "browser", value: "https://example.com/clicked" },
        { kind: "browser", value: "https://example.com/new-tab" },
      ]);
    // A same-origin page that the network sends without Rufi's CSP, with a
    // frame of a page elsewhere: only the window's own rules meet that frame,
    // and it loads nothing and opens nothing.
    await page.route("**/without-csp", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<iframe src="https://example.com/in-a-frame"></iframe>',
      }),
    );
    await page.goto(new URL("/without-csp", home).href);
    expect(page.frames().map((frame) => frame.url())).not.toContain(
      "https://example.com/in-a-frame",
    );
    expect(app.told).toHaveLength(2);
    await page.goBack();

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

test("shows a document's PDF in the built-in viewer; a link in it leaves the window in Rufi", async ({
  desktop,
}) => {
  await mkdir(desktop.home, { recursive: true });
  const store = openWritable(databasePath(desktop.home));
  store.db.exec(await readFile(FAMILY, "utf8"));
  store.db.exec(FIRST_RUN_DONE);
  store.close();
  await familyFiles(desktop.home);
  const app = await desktop.launch();
  const page = await app.electron.firstWindow();
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByRole("link", { name: "Sunrise Labs August.pdf" }).click();
  await page.getByRole("button", { name: "View original" }).click();
  await expect(page.getByTitle("Sunrise Labs August.pdf")).toBeVisible();
  // The viewer has read the PDF when it shows the PDF's own title.
  const viewer = () =>
    page
      .frames()
      .find((frame) => frame.url().startsWith("chrome-extension://"));
  await expect
    .poll(() => viewer()?.evaluate(() => document.title))
    .toBe("Fictional lab report");
  const documents = page.url();

  // The window's navigations from here on, to know the click below
  // reached the PDF's link.
  await app.electron.evaluate(({ BrowserWindow }) => {
    const tried: string[] = [];
    (globalThis as { tried?: string[] }).tried = tried;
    BrowserWindow.getAllWindows()[0]?.webContents.on(
      "did-start-navigation",
      (event) => {
        tried.push(event.url);
      },
    );
  });
  // The PDF's "Verify at https://example.com/verify" link, where the viewer
  // draws page 1 in the window's first size. The title comes as the PDF
  // loads, which can be before the viewer has page 1 there to take a click
  // (on a busy machine): click until the link is followed.
  const tried = () =>
    app.electron.evaluate(
      () => (globalThis as { tried?: string[] }).tried ?? [],
    );
  await expect(async () => {
    await page.mouse.click(560, 322);
    await expect.poll(tried, { timeout: 1_000 }).not.toEqual([]);
  }).toPass({ timeout: 10_000 });

  // The link tries to take the window away; the window stays in Rufi and
  // the browser isn't asked, as for any link a frame follows.
  expect(new Set(await tried())).toEqual(
    new Set(["https://example.com/verify"]),
  );
  expect(page.url()).toBe(documents);
  expect(app.told).toEqual([]);
  // Esc goes to the PDF viewer while it has the focus; × closes the popup.
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(page).toHaveURL(/\/people\/asha\/chat$/);
});
