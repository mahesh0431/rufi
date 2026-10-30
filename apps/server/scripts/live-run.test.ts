import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Turn } from "@rufi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SignedOut } from "../src/agent/runtime.ts";
import {
  HarnessTimeout,
  onScratch,
  outFolder,
  runAll,
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

describe("a case's scratch data folder", () => {
  /**
   * A case that writes a fictional record in its folder, then ends as `how`;
   * a case that passes writes its transcript to an output folder that's
   * gone.
   */
  const play = (how: "passes" | "fails" | "can't save its transcript") =>
    onScratch(
      "rufi-smoke-",
      async (home) => {
        await writeFile(join(home, "rufi.db"), "a fictional record");
        if (how === "can't save its transcript") {
          await writeFile(join(`${home}-gone`, "case.md"), "AI: …");
        }
        return { home, passed: how !== "fails" };
      },
      (result) => result.passed,
    );
  const record = (home: string) => readFile(join(home, "rufi.db"), "utf8");

  it("goes once its case has passed", async () => {
    const { result, kept } = await play("passes");
    expect(kept).toBeUndefined();
    await expect(access(result.home)).rejects.toThrow(/ENOENT/);
  });

  it("stays, with what the case wrote, when the case didn't pass", async () => {
    const { result, kept } = await play("fails");
    expect(kept).toBe(result.home);
    expect(await record(result.home)).toBe("a fictional record");
  });

  it("stays when the case's transcript couldn't be saved, and the error names it", async () => {
    const error: unknown = await play("can't save its transcript").catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      message: expect.stringMatching(
        /^ENOENT: .* \(data folder: .*rufi-smoke-\w+\)$/,
      ) as unknown,
      cause: { code: "ENOENT" },
    });
    const home = /data folder: (.*)\)$/.exec((error as Error).message)?.[1];
    expect(await record(home ?? "")).toBe("a fictional record");
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
      "Codex isn't signed in",
      { ...clean, error: new SignedOut("Codex isn't signed in to ChatGPT.") },
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
