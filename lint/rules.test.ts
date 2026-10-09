// The lint rules Rufi relies on do fire: each probe below breaks one rule,
// in a temporary file inside the folder whose borders apply to it.
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const PROBES = join(ROOT, "apps/server/src/core/lint-probes");
const WEB_PROBES = join(ROOT, "apps/web/src/lint-probes");
const DESKTOP_PROBES = join(ROOT, "apps/desktop/src/lint-probes");

const probes: Record<string, string> = {
  border: `import { Stopped } from "../../agent/runtime.ts";\nexport const a = Stopped;\n`,
  serverBorder: `import { chat } from "../../server/chat.ts";\nexport const a = chat;\n`,
  effectV3: `import { Schema } from "@effect/schema";\nexport const a = Schema;\n`,
  effectV3Subpath: `import { Schema } from "@effect/schema/Schema";\nexport const a = Schema;\n`,
  silentCatch: `export function f(): unknown {\n  try {\n    return JSON.parse("1");\n  } catch {\n    // ignored\n  }\n  return undefined;\n}\n`,
  lostCause: `export function f(): unknown {\n  try {\n    return JSON.parse("1");\n  } catch {\n    throw new Error("lost");\n  }\n}\n`,
  plusNumber: `export const s = (n: number) => "a" + n;\n`,
  dynamicDelete: `export function f(o: Record<string, number>, k: string): void {\n  delete o[k];\n}\n`,
  floating: `async function f(): Promise<void> {\n  await Promise.resolve();\n}\nexport function g(): void {\n  f();\n}\n`,
  noVar: `export function f(): number {\n  var a = 1;\n  return a;\n}\n`,
  preferConst: `export function f(): number {\n  let a = 1;\n  return a;\n}\n`,
  restParams: `export function f(): unknown {\n  return arguments[0];\n}\n`,
  spread: `export const f = (xs: number[]) => Math.max.apply(Math, xs);\n`,
  // Permitted: the inner catch keeps its own error as the cause.
  nestedCatch: `export function f(): unknown {\n  try {\n    return JSON.parse("1");\n  } catch {\n    try {\n      return JSON.parse("2");\n    } catch (error) {\n      throw new Error("fallback failed", { cause: error });\n    }\n  }\n}\n`,
  switchCase: `export function f(x: "a" | "b"): number {\n  switch (x) {\n    case "a":\n      return 1;\n  }\n  return 0;\n}\n`,
};

/** The screens' borders: the browser, the HTTP API and @rufi/contracts only. */
const webProbes: Record<string, string> = {
  webServer: `import { startCore } from "../../../server/src/server/core.ts";\nexport const a = startCore;\n`,
  webNode: `import { readFile } from "node:fs/promises";\nexport const a = readFile;\n`,
  webColour: `export const a = "rounded-xl bg-white/95 text-white";\n`,
  webShadow: `export const a = \`shadow-[0_8px_28px_rgba(0,0,0,.1)] \${"p-2"}\`;\n`,
  // Permitted: a link's fragment is not a colour.
  webFragment: `export const a = "/help/getting-started#add";\n`,
  webHooks: `import { useState } from "react";\nexport function A({ on }: { on: boolean }) {\n  if (on) useState(0);\n  return null;\n}\n`,
};

/** The app's border: neither the core's code nor the screens'. */
const desktopProbes: Record<string, string> = {
  desktopServer: `import { startCore } from "../../../server/src/server/core.ts";\nexport const a = startCore;\n`,
  desktopColour: `export const a = { backgroundColor: "#f5f7fa" };\n`,
  desktopWeb: `import { router } from "../../../web/src/router.tsx";\nexport const a = router;\n`,
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
  await mkdir(WEB_PROBES, { recursive: true });
  for (const [name, text] of Object.entries(webProbes)) {
    await writeFile(join(WEB_PROBES, `${name}.tsx`), text);
  }
  await mkdir(DESKTOP_PROBES, { recursive: true });
  for (const [name, text] of Object.entries(desktopProbes)) {
    await writeFile(join(DESKTOP_PROBES, `${name}.ts`), text);
  }
  const result = await promisify(execFile)(
    "pnpm",
    [
      "exec",
      "oxlint",
      "--type-aware",
      "-f",
      "json",
      PROBES,
      WEB_PROBES,
      DESKTOP_PROBES,
    ],
    { cwd: ROOT, timeout: 60_000 },
  ).catch((error: unknown) => error as { stdout: string });
  return (JSON.parse(result.stdout) as { diagnostics: Diagnostic[] })
    .diagnostics;
}

afterAll(async () => {
  await rm(PROBES, { recursive: true, force: true });
  await rm(WEB_PROBES, { recursive: true, force: true });
  await rm(DESKTOP_PROBES, { recursive: true, force: true });
});

describe("lint", () => {
  it("refuses each probe with the rule meant for it", async () => {
    const found = await lint();
    const codes = (name: string) =>
      found
        .filter(
          (d) => /lint-probes\/(\w+)\.tsx?$/.exec(d.filename)?.[1] === name,
        )
        .map((d) => d.code);
    expect(codes("border")).toContain("eslint(no-restricted-imports)");
    expect(codes("serverBorder")).toContain("eslint(no-restricted-imports)");
    expect(codes("effectV3")).toContain("eslint(no-restricted-imports)");
    expect(codes("effectV3Subpath")).toContain("eslint(no-restricted-imports)");
    expect(codes("silentCatch")).toContain("rufi(no-silent-catch)");
    expect(codes("lostCause")).toContain("rufi(no-lost-cause)");
    expect(codes("plusNumber")).toContain("typescript(restrict-plus-operands)");
    expect(codes("dynamicDelete")).toContain("typescript(no-dynamic-delete)");
    expect(codes("floating")).toContain("typescript(no-floating-promises)");
    expect(codes("noVar")).toContain("eslint(no-var)");
    expect(codes("preferConst")).toContain("eslint(prefer-const)");
    expect(codes("restParams")).toContain("eslint(prefer-rest-params)");
    expect(codes("spread")).toContain("eslint(prefer-spread)");
    expect(codes("nestedCatch")).toEqual([]);
    expect(codes("webServer")).toContain("eslint(no-restricted-imports)");
    expect(codes("webNode")).toContain("eslint(no-restricted-imports)");
    expect(codes("desktopServer")).toContain("eslint(no-restricted-imports)");
    expect(codes("desktopWeb")).toContain("eslint(no-restricted-imports)");
    expect(codes("webColour")).toContain("rufi(no-raw-colour)");
    expect(codes("webShadow")).toContain("rufi(no-raw-colour)");
    expect(codes("webFragment")).toEqual([]);
    expect(codes("desktopColour")).toContain("rufi(no-raw-colour)");
    expect(codes("webHooks")).toContain("react-hooks(rules-of-hooks)");
    expect(codes("switchCase")).toContain(
      "typescript(switch-exhaustiveness-check)",
    );
  }, 60_000);
});
