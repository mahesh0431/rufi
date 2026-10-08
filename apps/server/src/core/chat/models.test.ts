import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedModels, allowlistFile, DEFAULT_ALLOWLIST } from "./models.ts";

const offered = [
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-6-astra", name: "GPT-6-Astra" },
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
];

describe("the model allowlist", () => {
  it("starts with the strongest models, in a file the user can edit", async () => {
    const home = await mkdtemp(join(tmpdir(), "rufi-models-"));
    const file = allowlistFile(home);
    await expect(file.read()).resolves.toEqual({ models: DEFAULT_ALLOWLIST });
    expect(
      JSON.parse(await readFile(join(home, "models.json"), "utf8")),
    ).toEqual({
      models: ["gpt-6-astra", "gpt-6.1-sol"],
    });
  });

  it("takes an edit, and keeps the last good list when an edit is broken", async () => {
    const home = await mkdtemp(join(tmpdir(), "rufi-models-"));
    const file = allowlistFile(home);
    await writeFile(join(home, "models.json"), '{"models": ["gpt-6-astra"]}');
    await expect(file.read()).resolves.toEqual({ models: ["gpt-6-astra"] });
    await writeFile(join(home, "models.json"), '{"models": ["gpt-6-astra",');
    const broken = await file.read();
    expect(broken.models).toEqual(["gpt-6-astra"]);
    expect(broken.error).toMatch(/models\.json isn't valid JSON/);
    await writeFile(join(home, "models.json"), '{"models": []}');
    const empty = await file.read();
    expect(empty.models).toEqual(["gpt-6-astra"]);
    expect(empty.error).toMatch(/needs a list of model names/);
  });

  it("offers only allowed models the provider has, in the allowlist's order", () => {
    expect(
      allowedModels(offered, ["gpt-6.1-sol", "gpt-7", "gpt-6-astra"]).map(
        (m) => m.id,
      ),
    ).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
  });
});
