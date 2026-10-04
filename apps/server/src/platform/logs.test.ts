import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineTool, NoInput, toolCaller } from "../core/tools/registry.ts";
import { diagnostics, errorCode, type LogEvent, noEffectLogs } from "./logs.ts";

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
      shown: "Did something",
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

  it("keeps only known fields, and only values that fit each field", async () => {
    const { log, path } = diagnostics(home);
    log("codex.request", {
      method: "item/tool/call",
      status: "completed",
      error: "ENOENT",
      ms: 41,
    });
    log("codex.request", {
      method: "HbA1c:7.9",
      tool: HEALTH_TEXT,
      what: "metformin",
      status: HEALTH_TEXT,
      error: "rt-fictional-short",
      code: FAKE_TOKEN,
      ms: Number.NaN,
      note: "fictional",
      [HEALTH_TEXT]: 1,
      constructor: "HbA1c:7.9",
      toString: "rt-fictional-short",
    });
    // As parsed JSON can have it: an own "__proto__" key.
    const parsed = JSON.parse('{"__proto__": "metformin"}') as Record<
      string,
      string
    >;
    log("codex.request", parsed);
    log(HEALTH_TEXT as LogEvent);
    expect(await lines(path)).toEqual([
      {
        event: "codex.request",
        method: "item/tool/call",
        status: "completed",
        error: "ENOENT",
        ms: 41,
      },
      {
        event: "codex.request",
        method: "other",
        tool: "other",
        what: "other",
        status: "other",
        error: "other",
        code: "other",
        ms: "other",
      },
      { event: "codex.request" },
      { event: "unnamed" },
    ]);
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
        log("turn.ended");
        log("turn.ended");
      }).not.toThrow();
    } finally {
      process.stderr.write = write;
    }
    expect(notices).toEqual([
      "Rufi couldn't write its log (EEXIST); the log is off until Rufi restarts.\n",
    ]);
  });

  it("gives an error's code or kind, never its message", () => {
    const busy = Object.assign(new Error(HEALTH_TEXT), { code: "ELOCKED" });
    expect(errorCode(busy)).toBe("ELOCKED");
    expect(errorCode(Object.assign(new Error(), { code: -32601 }))).toBe(
      "-32601",
    );
    expect(errorCode(new TypeError(HEALTH_TEXT))).toBe("TypeError");
    const odd = Object.assign(new Error(), { code: "rt-fictional-short" });
    expect(errorCode(odd)).toBe("Error");
    const named = Object.assign(new Error(), { name: "Metformin" });
    expect(errorCode(named)).toBe("other");
    expect(errorCode(HEALTH_TEXT)).toBe("other");
  });

  it("is readable only by this user", async () => {
    const { log, path } = diagnostics(home);
    log("turn.ended");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "logs"))).mode & 0o777).toBe(0o700);
  });

  it("moves on at 10 MB and keeps five files", async () => {
    const { log, path } = diagnostics(home);
    log("turn.ended", { ms: -1 });
    const full = "x".repeat(10 * 1024 * 1024);
    for (let n = 0; n < 7; n++) {
      await writeFile(path, full);
      log("turn.ended", { ms: n });
    }
    const files = (await readdir(join(home, "logs"))).sort();
    expect(files).toEqual([
      "rufi.log",
      "rufi.log.1",
      "rufi.log.2",
      "rufi.log.3",
      "rufi.log.4",
    ]);
    expect(await lines(path)).toEqual([{ event: "turn.ended", ms: 6 }]);
  });
});

describe("Effect's logs", () => {
  it("are off: they print nothing", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const writeErr = vi.spyOn(process.stderr, "write");
    const consoleCalls = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      await Effect.runPromise(
        Effect.logError(HEALTH_TEXT, { token: "rt-fictional-short" }).pipe(
          Effect.withLogSpan("diabetes"),
          Effect.provide(noEffectLogs),
        ),
      );
      for (const spy of [write, writeErr, ...consoleCalls]) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
