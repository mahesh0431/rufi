import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { defineTool, NoInput, toolCaller } from "../core/tools/registry.ts";
import {
  diagnostics,
  effectLogs,
  errorCode,
  safeEvent,
  safeFields,
} from "./logs.ts";

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

  it("keeps only known fields, and only ID- or code-like text in them", () => {
    expect(
      safeFields({
        method: "turn/start",
        turn: "019a3c2e-7f00-7000-8000-000000000001",
        status: HEALTH_TEXT,
        error: FAKE_TOKEN,
        ms: 41,
        note: "fictional",
        token: "rt-fictional-short",
        [HEALTH_TEXT]: 1,
      }),
    ).toEqual({
      method: "turn/start",
      turn: "019a3c2e-7f00-7000-8000-000000000001",
      status: "[redacted]",
      error: "[redacted]",
      ms: 41,
    });
  });

  it("names an event only with a code-shaped name", () => {
    expect(safeEvent("tool.failed")).toBe("tool.failed");
    expect(safeEvent(HEALTH_TEXT)).toBe("unnamed");
    expect(safeEvent("rt-fictional-short")).toBe("unnamed");
  });

  it("turns off, once, when it can't write, instead of failing the caller", async () => {
    await writeFile(join(home, "logs"), "a file where the folder should be");
    const { log } = diagnostics(home);
    const notices: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      notices.push(String(chunk));
      return true;
    };
    try {
      expect(() => {
        log("test.event");
        log("test.event");
      }).not.toThrow();
    } finally {
      process.stderr.write = write;
    }
    expect(notices).toEqual([
      "Rufi couldn't write its log (EEXIST); the log is off until Rufi restarts.\n",
    ]);
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
    log("test.event", { ms: -1 });
    const full = "x".repeat(10 * 1024 * 1024);
    for (let n = 0; n < 7; n++) {
      await writeFile(path, full);
      log("test.event", { ms: n });
    }
    const files = (await readdir(join(home, "logs"))).sort();
    expect(files).toEqual([
      "rufi.log",
      "rufi.log.1",
      "rufi.log.2",
      "rufi.log.3",
      "rufi.log.4",
    ]);
    expect(await lines(path)).toEqual([{ event: "test.event", ms: 6 }]);
  });
});

describe("Effect's logs", () => {
  it("go to the same file with timings and error codes only", async () => {
    const { log, path } = diagnostics(home);
    await Effect.runPromise(
      Effect.logError(HEALTH_TEXT, { token: "rt-fictional-short" }).pipe(
        Effect.andThen(Effect.logError("turn.failed", { turn: "019a3c2e" })),
        Effect.withLogSpan(HEALTH_TEXT),
        Effect.withLogSpan("turn"),
        Effect.andThen(Effect.fail(new Error(HEALTH_TEXT))),
        Effect.tapCause((cause) => Effect.logError("command.failed", cause)),
        Effect.ignore,
        Effect.provide(effectLogs(log)),
      ),
    );
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("HbA1c");
    // Each time is a number; it's set to 0 to compare the rest exactly.
    const events = (await lines(path)).map((event) => {
      if (!("turn_ms" in event)) return event;
      expect(typeof event["turn_ms"]).toBe("number");
      return { ...event, turn_ms: 0 };
    });
    expect(events).toEqual([
      { event: "unnamed", level: "Error", turn_ms: 0 },
      { event: "turn.failed", level: "Error", turn: "019a3c2e", turn_ms: 0 },
      {
        event: "command.failed",
        level: "Error",
        errors: "Error",
      },
    ]);
  });
});
