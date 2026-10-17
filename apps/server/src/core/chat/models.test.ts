import { describe, expect, it } from "vitest";
import { allowedModels } from "./models.ts";

const offered = [
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-6-astra", name: "GPT-6-Astra" },
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
];

describe("Rufi's models", () => {
  it("offers only the listed models the provider has, in the list's order", () => {
    expect(
      allowedModels(offered, ["gpt-6.1-sol", "gpt-7", "gpt-6-astra"]).map(
        (m) => m.id,
      ),
    ).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
  });
});
