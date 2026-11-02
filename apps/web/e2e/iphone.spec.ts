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
