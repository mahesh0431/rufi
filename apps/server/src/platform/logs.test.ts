import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { defineTool, NoInput, toolCaller } from "../core/tools/registry.ts";
import { diagnostics, effectLogs, errorCode, safeFields } from "./logs.ts";

// Fictional, and shaped like what must never reach a log.
const HEALTH_TEXT = "Asha Fictional HbA1c 7.9% on metformin";
// Built from parts, so the source holds nothing that looks like a secret.
const FAKE_TOKEN = ["fictional", "token", "0123456789".repeat(6)].join(".");

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-logs-"));
});

/** The file's events; each must have a time, which is then left out. */
const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const { time, ...event } = JSON.parse(line) as Record<string, unknown>;
      expect(Number.isNaN(Date.parse(String(time)))).toBe(false);
      return event;
    });

describe("the log file", () => {
  it("never gets the health text or token in a failing tool's error", async () => {
    const { log, path } = diagnostics(home);
    const leaky = defineTool({
      name: "leaky",
      description: "Fails with private details in its error.",
      input: NoInput,
      callers: "model",
      readOnly: true,
      destructive: false,
      examples: [{}],
      run: () => {
        throw new Error(`${HEALTH_TEXT} ${FAKE_TOKEN}`);
      },
    });
    await toolCaller(
      [leaky],
      () => ({ store: undefined, personId: undefined }),
      log,
    )("leaky", {});
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("HbA1c");
    expect(text).not.toContain(FAKE_TOKEN.slice(0, 20));
    expect(await lines(path)).toEqual([
      {
        event: "tool.failed",
        tool: "leaky",
        error: "Error",
      },
    ]);
  });

  it("replaces any text that isn't an ID or a code", () => {
    expect(
      safeFields({
        method: "turn/start",
        id: "019a3c2e-7f00-7000-8000-000000000001",
        note: HEALTH_TEXT,
        token: FAKE_TOKEN,
        ms: 41,
        ok: true,
      }),
    ).toEqual({
      method: "turn/start",
      id: "019a3c2e-7f00-7000-8000-000000000001",
      note: "[redacted]",
      token: "[redacted]",
      ms: 41,
      ok: true,
    });
  });

  it("gives an error's code, never its message", () => {
    const busy = Object.assign(new Error(HEALTH_TEXT), { code: "ELOCKED" });
    expect(errorCode(busy)).toBe("ELOCKED");
    expect(errorCode(new TypeError(HEALTH_TEXT))).toBe("TypeError");
    expect(errorCode(HEALTH_TEXT)).toBe("string");
  });

  it("is readable only by this user", async () => {
    const { log, path } = diagnostics(home);
    log("test.event");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "logs"))).mode & 0o777).toBe(0o700);
  });

  it("moves on at 10 MB and keeps five files", async () => {
    const { log, path } = diagnostics(home);
    log("test.event", { n: -1 });
    const full = "x".repeat(10 * 1024 * 1024);
    for (let n = 0; n < 7; n++) {
      await writeFile(path, full);
      log("test.event", { n });
    }
    const files = (await readdir(join(home, "logs"))).sort();
    expect(files).toEqual([
      "rufi.log",
      "rufi.log.1",
      "rufi.log.2",
      "rufi.log.3",
      "rufi.log.4",
    ]);
    expect(await lines(path)).toEqual([{ event: "test.event", n: 6 }]);
  });
});

describe("Effect's logs", () => {
  it("go to the same file with timings and error codes only", async () => {
    const { log, path } = diagnostics(home);
    await Effect.runPromise(
      Effect.logError("turn.failed", { turn: "019a3c2e" }).pipe(
        Effect.withLogSpan("turn"),
        Effect.andThen(Effect.fail(new Error(HEALTH_TEXT))),
        Effect.tapCause((cause) => Effect.logError("command.failed", cause)),
        Effect.ignore,
        Effect.provide(effectLogs(log)),
      ),
    );
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("HbA1c");
    const [failed, ...rest] = await lines(path);
    expect(typeof failed?.["turn_ms"]).toBe("number");
    expect({ ...failed, turn_ms: 0 }).toEqual({
      event: "turn.failed",
      level: "Error",
      turn: "019a3c2e",
      turn_ms: 0,
    });
    expect(rest).toEqual([
      {
        event: "command.failed",
        level: "Error",
        errors: "Error",
      },
    ]);
  });
});
