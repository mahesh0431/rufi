// The icon of the Rufi app's bundle (`pnpm desktop` on the Mac): the dog's
// Mac icon from the brand package, as the bundle's electron.icns. The bundle
// keeps a hash of the picture its icon was made from, so a cached bundle gets
// the new icon at the next start after the dog changes. When the Mac's
// converter fails or takes too long, the bundle keeps the icon it had.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How long the Mac's converter may take for one icon. */
const CONVERT_MS = 30_000;

/** The dog on the Mac's icon grid, made by the brand package. */
export const ICON = fileURLToPath(
  import.meta.resolve("@rufi/brand/mark/assets/png/mac-icon-512.png"),
);

/** Gives `bundle` the icon made from `picture`, unless it has it already. */
export async function bundleIcon(
  bundle: string,
  picture = ICON,
): Promise<void> {
  const resources = join(bundle, "Contents/Resources");
  const stamp = join(resources, "rufi-icon.sha256");
  const hash = createHash("sha256")
    .update(await readFile(picture))
    .digest("hex");
  // No stamp, or one that can't be read: the icon is made again.
  const had = await readFile(stamp, "utf8").catch(() => undefined);
  if (had === hash) return;
  // Made beside it, then moved in place: a half-made icon is never used.
  const making = join(resources, `electron.${String(process.pid)}.icns`);
  try {
    await run("sips", ["-s", "format", "icns", picture, "--out", making], {
      timeout: CONVERT_MS,
    });
  } catch (cause) {
    await rm(making, { force: true });
    throw new Error(
      "The Mac's icon converter failed or took too long; the bundle keeps the icon it had.",
      { cause },
    );
  }
  await rename(making, join(resources, "electron.icns"));
  await writeFile(stamp, hash);
  // The Mac reads a bundle's icon again when the bundle changes.
  const now = new Date();
  await utimes(bundle, now, now);
}
