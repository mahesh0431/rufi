// The Rufi app bundle's icon on the Mac: made from the dog on a first start,
// left as it is while the dog is the same, and made again in a cached bundle
// when the dog changes. Runs the Mac's own converter (sips), so Mac only.
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { bundleIcon, ICON } from "./bundle-icon.ts";

it.runIf(process.platform === "darwin")(
  "a bundle gets the dog's icon, and a new one only when the dog changes",
  async () => {
    const bundle = join(
      await mkdtemp(join(tmpdir(), "rufi-icon-")),
      "Rufi.app",
    );
    await mkdir(join(bundle, "Contents/Resources"), { recursive: true });
    const icns = join(bundle, "Contents/Resources/electron.icns");

    await bundleIcon(bundle);
    const first = await readFile(icns);
    expect(first.subarray(0, 4).toString("latin1")).toBe("icns");
    const made = (await stat(icns)).mtimeMs;

    // The same dog: the icon stays as it is.
    await bundleIcon(bundle);
    expect((await stat(icns)).mtimeMs).toBe(made);

    // Another picture of the dog stands in for a changed one.
    const changed = fileURLToPath(
      import.meta.resolve("@rufi/brand/mark/assets/png/app-icon-512.png"),
    );
    expect(changed).not.toBe(ICON);
    await bundleIcon(bundle, changed);
    expect(await readFile(icns)).not.toEqual(first);
  },
);
