// The screens on a paired phone read only what the remote door answers: its
// person's routes, who it is, the settings and the sign-ins. Never a
// Mac-wide read, which the door refuses. Here the page is told it runs on a
// phone; the door itself is tested in apps/server (remote.test.ts).
import { expect, test } from "./rufi.ts";

/** What the door answers a paired app: anything else is 404 there. */
const DOOR = [
  /^\/api\/session$/,
  /^\/api\/me$/,
  /^\/api\/settings$/,
  /^\/api\/status$/,
  /^\/api\/people\/asha\//,
];

test("a phone's pages read only what the door answers", async ({
  page,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        place: "phone",
        person: { id: "asha", name: "Asha Fictional" },
        mac: "asha-mbp",
        folder: "folder-1",
        api: 1,
      },
    }),
  );
  const read: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/")) read.push(pathname);
  });

  await page.goto(rufi.link());
  const sidebar = page.getByRole("complementary");
  for (const name of [
    "Chat with Rufi",
    "Lab results",
    "Medicines",
    "Follow-ups",
    "Documents",
  ]) {
    await sidebar.getByRole("link", { name }).click();
    await expect(page.getByRole("main")).toBeVisible();
  }
  // Back to Overview: its read is the last one the pages make.
  const overview = page.waitForResponse((answer) =>
    answer.url().endsWith("/api/people/asha/overview"),
  );
  await sidebar.getByRole("link", { name: "Overview" }).click();
  await overview;

  expect(read.filter((path) => !DOOR.some((ok) => ok.test(path)))).toEqual([]);
  expect(read).toContain("/api/people/asha/overview");
});
