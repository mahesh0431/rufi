import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Turn } from "@rufi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ChatGptError } from "../src/agent/chatgpt/openai.ts";
import {
  HarnessTimeout,
  outFolder,
  runAll,
  sharedToken,
  statusOf,
} from "./live-run.ts";

describe("running the cases", () => {
  const timed = async (names: string[], jobs?: number) => {
    let now = 0;
    let most = 0;
    const results = await runAll(names, jobs, async (name) => {
      most = Math.max(most, ++now);
      await sleep(20);
      now--;
      if (name === "crashes") throw new Error("the case crashed");
      return name.toUpperCase();
    });
    return { results, most };
  };

  it("starts every case at once, and a crash is that case's result only", async () => {
    const { results, most } = await timed(["a", "crashes", "b", "c"]);
    expect(most).toBe(4);
    expect(results.get("a")).toEqual({ status: "fulfilled", value: "A" });
    expect(results.get("crashes")).toMatchObject({
      status: "rejected",
      reason: new Error("the case crashed"),
    });
    expect([...results.keys()].toSorted()).toEqual(["a", "b", "c", "crashes"]);
  });

  it("runs at most --jobs cases at a time", async () => {
    const { results, most } = await timed(["a", "b", "c", "d", "e"], 2);
    expect(most).toBe(2);
    expect(results.size).toBe(5);
  });
});

describe("the shared token", () => {
  const HOUR = 3_600_000;
  /** A sign-in whose token renews to an hour's validity when asked for more than it has. */
  const signIn = (left: number) => {
    let n = 1;
    let expires = Date.now() + left;
    const seen = { calls: 0, renewals: 0, atOnce: 0, most: 0 };
    const get = async (validForMs: number) => {
      seen.calls++;
      seen.most = Math.max(seen.most, ++seen.atOnce);
      await sleep(10);
      if (expires - Date.now() < validForMs) {
        seen.renewals++;
        n++;
        expires = Date.now() + HOUR;
      }
      seen.atOnce--;
      return { token: `token-${String(n)}`, expires };
    };
    const tokens = new Map<string, number>();
    const token = sharedToken(async (validForMs) => {
      const got = await get(validForMs);
      tokens.set(got.token, got.expires);
      return got.token;
    });
    return { token, seen, expiresOf: (t: string) => tokens.get(t) ?? 0 };
  };

  it("renews once for many callers at the same time", async () => {
    const { token, seen } = signIn(30_000);
    const got = await Promise.all(
      Array.from({ length: 36 }, () => token(60_000)),
    );
    expect(new Set(got)).toEqual(new Set(["token-2"]));
    expect(seen).toMatchObject({ calls: 1, renewals: 1, most: 1 });
  });

  it("gives each caller a token valid as long as it asked, one call at a time", async () => {
    const { token, seen, expiresOf } = signIn(10 * 60_000);
    const asked = Date.now();
    const [chat, reader, chatAgain] = await Promise.all([
      token(60_000),
      token(30 * 60_000),
      token(60_000),
    ]);
    expect(chat).toBe("token-1");
    expect(expiresOf(reader)).toBeGreaterThanOrEqual(asked + 30 * 60_000);
    expect(expiresOf(chatAgain)).toBeGreaterThanOrEqual(asked + 60_000);
    expect(seen).toMatchObject({ calls: 2, renewals: 1, most: 1 });
  });

  it("passes a failed renewal to its callers, and the next caller tries again", async () => {
    let fail = true;
    const token = sharedToken(async () => {
      await sleep(5);
      if (fail) throw new ChatGptError("temporary", "Try again shortly.");
      return "token-2";
    });
    const failed = await Promise.allSettled([token(60_000), token(60_000)]);
    expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    fail = false;
    expect(await token(60_000)).toBe("token-2");
  });
});

describe("the output folder", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true });
  });

  it("is a new folder for each run by default", async () => {
    const first = await outFolder("smoke");
    const second = await outFolder("smoke");
    made.push(first, second);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^\/tmp\/rufi-smoke-[0-9a-f]+-/);
    expect(await readdir(first)).toEqual([]);
  });

  it("takes an empty folder and refuses one with something in it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rufi-out-"));
    made.push(dir);
    expect(await outFolder("smoke", dir)).toBe(dir);
    await writeFile(join(dir, "report.md"), "an earlier run\n");
    await expect(outFolder("smoke", dir)).rejects.toThrow(/isn't empty/);
  });
});

describe("a case's status", () => {
  const turn = (endReason: Turn["endReason"]) =>
    ({ status: endReason ? "failed" : "completed", endReason }) as Turn;
  const clean = { failed: [], turns: [turn(null)], person: false };

  it.each([
    ["every check passed", clean, "passed"],
    ["a check failed", { ...clean, failed: ["says_6_8"] }, "FAILED"],
    ["no real check", { ...clean, person: true }, "needs a person's verdict"],
    [
      "no real check, and a check failed",
      { ...clean, failed: ["how_present"], person: true },
      "FAILED",
    ],
    [
      "a usage limit ended a reply",
      { ...clean, failed: ["says_6_8"], turns: [turn("usage_limit")] },
      "INFRA",
    ],
    [
      "the provider failed",
      { ...clean, turns: [turn(null), turn("provider_failed")] },
      "INFRA",
    ],
    [
      "a save failed: Rufi's own fault",
      { ...clean, failed: ["saved_once"], turns: [turn("save_failed")] },
      "FAILED",
    ],
    [
      "the harness timed out",
      { ...clean, error: new HarnessTimeout("a reply took over five minutes") },
      "INFRA",
    ],
    [
      "the sign-in couldn't renew",
      { ...clean, error: new ChatGptError("temporary", "Try again shortly.") },
      "INFRA",
    ],
    [
      "the case itself went wrong",
      { ...clean, error: new Error("no document lotus-jun.pdf") },
      "FAILED",
    ],
    [
      "a failed check while the event loop stalled",
      { ...clean, failed: ["says_6_8"], stalledMs: 2_500 },
      "INFRA",
    ],
    [
      "a pass while the event loop stalled",
      { ...clean, stalledMs: 2_500 },
      "passed",
    ],
  ])("%s", (_, outcome, status) => {
    expect(statusOf(outcome).status).toBe(status);
  });

  it("says why a reply ended in the service's words", () => {
    const ended = {
      ...turn("connection"),
      endText: "exceeded retry limit, last status: 429 Too Many Requests",
    };
    expect(statusOf({ ...clean, turns: [ended] })).toEqual({
      status: "INFRA",
      why: "a reply ended (connection): exceeded retry limit, last status: 429 Too Many Requests",
    });
  });
});
