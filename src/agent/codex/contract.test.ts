// Contract tests against the pinned Codex binary itself, offline: the things
// generated types can't promise. No sign-in and no AI request is made.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateProtocol,
  listFiles,
  PROTOCOL_DIR,
} from "../../../scripts/codex-types.ts";
import type { AgentRuntime } from "../runtime.ts";
import { checkFeatures, DEADLINES } from "./appserver.ts";
import { codexBinary } from "./binary.ts";
import { codexRuntime } from "./codex.ts";
import { prepareCodexHome } from "./config.ts";
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse.ts";
import { connect, type Rpc } from "./rpc.ts";

let root: string;
let fakeHome: string;
let runtime: AgentRuntime | undefined;
let raw: { rpc: Rpc; stop: () => void } | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rufi-contract-"));
  fakeHome = join(root, "user-home");
  await mkdir(fakeHome);
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  raw?.stop();
  raw = undefined;
});

const env = () => ({ PATH: process.env["PATH"] ?? "", HOME: fakeHome });

/** Rufi's Codex runtime on the real binary, with a fake token. */
async function real(): Promise<AgentRuntime> {
  runtime = codexRuntime({
    home: join(root, "rufi"),
    command: { file: await codexBinary(), args: [] },
    env: env(),
    token: () => Promise.resolve("not-a-real-token"),
    version: "0.0.0",
  });
  return runtime;
}

/** A bare app-server connection, to test protocol admission directly. */
async function bare(experimentalApi: boolean): Promise<Rpc> {
  const { codexHome } = await prepareCodexHome(join(root, "bare"));
  const child = spawn(
    await codexBinary(),
    ["app-server", "--listen", "stdio://"],
    {
      env: {
        ...env(),
        CODEX_HOME: codexHome,
        ACCESS_TOKEN: "not-a-real-token",
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const rpc = connect(
    child.stdout,
    child.stdin,
    {
      request: () => Promise.reject(new Error("no requests expected")),
      notification: () => undefined,
      ignored: () => undefined,
    },
    DEADLINES.answerMs,
  );
  raw = { rpc, stop: () => child.kill() };
  await rpc.request(
    "initialize",
    {
      clientInfo: { name: "Rufi", title: "Rufi", version: "0.0.0" },
      capabilities: { experimentalApi, requestAttestation: false },
    },
    DEADLINES.requestMs,
  );
  rpc.notify("initialized");
  return rpc;
}

describe("the pinned Codex", () => {
  it("matches the committed protocol types", async () => {
    const fresh = join(root, "protocol");
    await generateProtocol(fresh);
    const committed = await listFiles(PROTOCOL_DIR);
    const generated = await listFiles(fresh);
    expect(generated.map((file) => relative(fresh, file))).toEqual(
      committed.map((file) => relative(PROTOCOL_DIR, file)),
    );
    for (const file of generated) {
      const twin = join(PROTOCOL_DIR, relative(fresh, file));
      expect(await readFile(file, "utf8"), twin).toBe(
        await readFile(twin, "utf8"),
      );
    }
  }, 60_000);

  it("starts with Rufi's config, with exactly Rufi's feature flags, and opens a thread", async () => {
    const agent = await real();
    await expect(agent.open()).resolves.toMatch(/\S/);
  }, 60_000);

  it("turns off a skill found in the user's home", async () => {
    const skill = join(fakeHome, ".agents/skills/sentinel");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: sentinel\ndescription: Fictional skill for a Rufi test.\n---\nSay SENTINEL.\n",
    );
    await (await real()).open();
    const rpc = await bare(true);
    // The bare connection uses its own CODEX_HOME, so it still sees the skill:
    // that's the default Rufi has to undo.
    const listed: SkillsListResponse = await rpc.request(
      "skills/list",
      { cwds: [root], forceReload: true },
      DEADLINES.requestMs,
    );
    expect(listed.data[0]?.skills.map((s) => [s.name, s.enabled])).toEqual([
      ["sentinel", true],
    ]);
    const rufiConfig = await readFile(
      join(root, "rufi/codex/config.toml"),
      "utf8",
    );
    expect(rufiConfig).toContain(join(skill, "SKILL.md"));
  }, 60_000);

  it("accepts experimental fields only after the client opts in", async () => {
    const without = await bare(false);
    await expect(
      without.request(
        "thread/start",
        { mockExperimentalField: "x" },
        DEADLINES.requestMs,
      ),
    ).rejects.toThrow(/experimental/i);
    raw?.stop();
    const opted = await bare(true);
    await expect(
      opted.request(
        "thread/start",
        { mockExperimentalField: "x", ephemeral: true },
        DEADLINES.requestMs,
      ),
    ).resolves.toMatchObject({ thread: { id: expect.any(String) as string } });
  }, 60_000);

  it("reports exactly Rufi's feature flags with Rufi's config", async () => {
    await expect(
      checkFeatures(await bare(true), undefined, 30_000),
    ).resolves.toBeUndefined();
  }, 60_000);
});
