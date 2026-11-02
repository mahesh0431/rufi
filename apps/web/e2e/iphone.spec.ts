// Settings → iPhone: pairing a phone for one person's record, as the phone
// uses the code, and unpairing it, which asks first. Tailscale is stood in
// for (rufi.ts); the phone is a request to the door, as Serve passes it on.
import { request } from "node:http";
import { expect, openSettings, TAILNET_NAME, test } from "./rufi.ts";

/** The phone posting the code from the link, by the Mac's tailnet name. */
function phonePairs(link: string): Promise<number> {
  const url = new URL(link);
  const code = new URLSearchParams(url.hash.slice(1)).get("code");
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        method: "POST",
        path: "/api/pair",
        headers: {
          host: `${TAILNET_NAME}:${url.port}`,
          "content-type": "application/json",
        },
      },
      (answer) => {
        answer.resume();
        answer.on("end", () => {
          resolve(answer.statusCode ?? 0);
        });
      },
    );
    sent.on("error", reject);
    sent.end(JSON.stringify({ code, name: "Asha's iPhone" }));
  });
}

test("pairs an iPhone for the person chosen, and unpairs it after asking", async ({
  page,
  context,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(rufi.link());
  const section = (await openSettings(page, "iPhone")).getByRole("region", {
    name: "Paired iPhones",
  });

  await section.getByRole("button", { name: "Pair an iPhone" }).click();
  const whose = section.getByRole("radiogroup", {
    name: "Whose record does this iPhone open?",
  });
  await expect(section).toContainText(
    "Pair a phone for your own record only for now",
  );
  await expect(section.getByRole("button", { name: "Pair" })).toBeDisabled();
  await whose.getByRole("radio", { name: "Asha Fictional" }).check();
  await section.getByRole("button", { name: "Pair" }).click();

  const pairing = page.getByRole("dialog", {
    name: "Pair an iPhone for Asha Fictional",
  });
  await expect(
    pairing.getByRole("img", { name: /The pairing code/ }),
  ).toBeVisible();
  await pairing.getByRole("button", { name: "Copy link" }).click();
  await expect(pairing).toContainText("Copied");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(
    new RegExp(
      `^https://${TAILNET_NAME.replaceAll(".", "\\.")}:\\d+/pair#code=`,
    ),
  );

  expect(await phonePairs(link)).toBe(200);
  await expect(pairing).toContainText(
    "Paired: Asha's iPhone, for Asha Fictional",
  );
  await pairing.getByRole("button", { name: "Done" }).click();
  await expect(section).toContainText("Asha's iPhone · for Asha Fictional");

  await section.getByRole("button", { name: "Unpair" }).click();
  const asked = page.getByRole("dialog", { name: "Unpair Asha's iPhone?" });
  await expect(asked).toContainText("It can't open Rufi any more, from now.");
  await asked.getByRole("button", { name: "Unpair" }).click();
  await expect(section).not.toContainText("Asha's iPhone");
  // Nothing paired and no code: Serve stops for the door's port.
  expect(rufi.tailscale.at(-1)).toMatch(/^off \d+$/);
});

test("waits for a slow Tailscale check, and never shows a code another window replaced", async ({
  page,
  context,
  rufi,
}) => {
  await rufi.family();
  await rufi.start();
  const slow = Promise.withResolvers<undefined>();
  rufi.holdCheck = slow.promise;
  await page.clock.install();
  await page.goto(rufi.link());
  const section = (await openSettings(page, "iPhone")).getByRole("region", {
    name: "Paired iPhones",
  });
  await section.getByRole("button", { name: "Pair an iPhone" }).click();
  await section.getByRole("radio", { name: "Asha Fictional" }).check();
  const asked = page.waitForRequest("**/api/paired-apps/pairing");
  await section.getByRole("button", { name: "Pair" }).click();
  await asked;

  // The first certificate takes a while: past the 15 s other requests get.
  await page.clock.runFor(20_000);
  await expect(
    section.getByRole("button", { name: "Setting up Tailscale…" }),
  ).toBeVisible();
  await expect(page.getByText("Rufi can't be reached.")).toHaveCount(0);
  slow.resolve(undefined);
  const first = page.getByRole("dialog", {
    name: "Pair an iPhone for Asha Fictional",
  });
  await expect(
    first.getByRole("img", { name: /The pairing code/ }),
  ).toBeVisible();

  // Another window makes a code for Ravi: the only live code now.
  const other = await context.newPage();
  await other.goto(rufi.link());
  const elsewhere = (await openSettings(other, "iPhone")).getByRole("region", {
    name: "Paired iPhones",
  });
  await elsewhere.getByRole("button", { name: "Pair an iPhone" }).click();
  await elsewhere.getByRole("radio", { name: "Ravi Fictional" }).check();
  await elsewhere.getByRole("button", { name: "Pair" }).click();
  const second = other.getByRole("dialog", {
    name: "Pair an iPhone for Ravi Fictional",
  });
  await expect(
    second.getByRole("img", { name: /The pairing code/ }),
  ).toBeVisible();

  // The first window looks again, and shows no code under Asha's name.
  await page.clock.runFor(2_500);
  await expect(first).toContainText(
    "This code has expired or was replaced by a newer one.",
  );
  await expect(first.getByRole("img")).toHaveCount(0);
  await expect(first.getByRole("button", { name: "Copy link" })).toHaveCount(0);
  // Closing it leaves Ravi's code alone.
  let cancelled = false;
  page.on("request", (sent) => {
    if (sent.url().endsWith("/api/paired-apps/pairing/cancel"))
      cancelled = true;
  });
  await first.getByRole("button", { name: "Close" }).click();
  await expect(first).toHaveCount(0);
  expect(cancelled).toBe(false);
  await expect(
    second.getByRole("img", { name: /The pairing code/ }),
  ).toBeVisible();
});
