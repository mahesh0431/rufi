// A value row stores only its type's key, so a key that has shipped must
// stay in the type list for good (docs/adr/0023).
import { expect, it } from "vitest";
import { DEVICE_TYPES } from "./types.ts";

/** Every key that has shipped. This list only grows. */
const SHIPPED = ["resting_heart_rate", "heart_rate"];

it("still has every key that has shipped", () => {
  expect(DEVICE_TYPES.map((type) => type.key)).toEqual(
    expect.arrayContaining(SHIPPED),
  );
});
