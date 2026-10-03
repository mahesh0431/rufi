// The lint rules Rufi relies on do fire: each probe below breaks one rule,
// in a temporary file inside the folder whose borders apply to it.
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const PROBES = join(ROOT, "apps/server/src/core/lint-probes");

const probes: Record<string, string> = {
  border: `import { Agent } from "../../agent/runtime.ts";\nexport const a = Agent;\n`,
  effectV3: `import { Schema } from "@effect/schema";\nexport const a = Schema;\n`,
  effectV3Subpath: `import { Schema } from "@effect/schema/Schema";\nexport const a = Schema;\n`,
  silentCatch: `export function f(): unknown {\n  try {\n    return JSON.parse("1");\n  } catch {\n    // ignored\n  }\n  return undefined;\n}\n`,
  lostCause: `export function f(): unknown {\n  try {\n    return JSON.parse("1");\n  } catch {\n    throw new Error("lost");\n  }\n}\n`,
  plusNumber: `export const s = (n: number) => "a" + n;\n`,
  dynamicDelete: `export function f(o: Record<string, number>, k: string): void {\n  delete o[k];\n}\n`,
  floating: `async function f(): Promise<void> {\n  await Promise.resolve();\n}\nexport function g(): void {\n  f();\n}\n`,
  switchCase: `export function f(x: "a" | "b"): number {\n  switch (x) {\n    case "a":\n      return 1;\n  }\n  return 0;\n}\n`,
};

interface Diagnostic {
  code: string;
  filename: string;
}

async function lint(): Promise<Diagnostic[]> {
  await mkdir(PROBES, { recursive: true });
  for (const [name, text] of Object.entries(probes)) {
    await writeFile(join(PROBES, `${name}.ts`), text);
  }
  const result = await promisify(execFile)(
    "pnpm",
    ["exec", "oxlint", "--type-aware", "-f", "json", PROBES],
    { cwd: ROOT, timeout: 60_000 },
  ).catch((error: unknown) => error as { stdout: string });
  return (JSON.parse(result.stdout) as { diagnostics: Diagnostic[] })
    .diagnostics;
}

afterAll(() => rm(PROBES, { recursive: true, force: true }));

describe("lint", () => {
  it("refuses each probe with the rule meant for it", async () => {
    const found = await lint();
    const codes = (name: string) =>
      found
        .filter((d) => d.filename.endsWith(`lint-probes/${name}.ts`))
        .map((d) => d.code);
    expect(codes("border")).toContain("eslint(no-restricted-imports)");
    expect(codes("effectV3")).toContain("eslint(no-restricted-imports)");
    expect(codes("effectV3Subpath")).toContain("eslint(no-restricted-imports)");
    expect(codes("silentCatch")).toContain("rufi(no-silent-catch)");
    expect(codes("lostCause")).toContain("rufi(no-lost-cause)");
    expect(codes("plusNumber")).toContain("typescript(restrict-plus-operands)");
    expect(codes("dynamicDelete")).toContain("typescript(no-dynamic-delete)");
    expect(codes("floating")).toContain("typescript(no-floating-promises)");
    expect(codes("switchCase")).toContain(
      "typescript(switch-exhaustiveness-check)",
    );
  }, 60_000);
});
