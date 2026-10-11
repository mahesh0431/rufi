import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SaveInput } from "../record/save.ts";
import { jsonSchemaOf } from "./registry.ts";
import { typescriptOf } from "./typescript.ts";

describe("a tool's input as TypeScript", () => {
  it("gives every key, optional or not, its type, null and literals, named types after, and each note once", () => {
    const Said = Schema.Struct({
      date: Schema.String.annotate({ description: "YYYY-MM-DD." }),
    })
      .annotate({ identifier: "Said" })
      .annotate({ description: "A date the user gave." });
    const source = Schema.String.annotate({ description: "Their words." });
    const input = Schema.Struct({
      changes: Schema.Array(
        Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("symptom"),
            source,
            onset: Schema.optionalKey(Schema.NullOr(Said)),
          }),
          Schema.Struct({
            kind: Schema.Literal("result"),
            source,
            number: Schema.optionalKey(Schema.Int),
            flags: Schema.Array(Schema.Literals(["H", "L"])),
          }),
        ]),
      ),
      done: Schema.optionalKey(Schema.Boolean),
    });

    expect(typescriptOf(jsonSchemaOf(input))).toBe(
      `type Input = {
  changes: Array<{
    kind: "symptom";
    // Their words.
    source: string;
    onset?: Said | null;
  } | {
    kind: "result";
    source: string;
    number?: number;
    flags: Array<"H" | "L">;
  }>;
  done?: boolean;
};
// A date the user gave.
type Said = {
  // YYYY-MM-DD.
  date: string;
};`,
    );
  });

  it("leaves no part of save_changes' input untyped", () => {
    expect(typescriptOf(jsonSchemaOf(SaveInput))).not.toMatch(
      /(?<!")\bunknown\b(?!")/,
    );
  });
});
