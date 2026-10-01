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
import { DEADLINES } from "./appserver.ts";
import { codexBinary } from "./binary.ts";
import { codexRuntime } from "./codex.ts";
import type { CommandExecResponse } from "./protocol/v2/CommandExecResponse.ts";
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse.ts";
import { connect, type Rpc } from "./rpc.ts";
import { checkSettings, prepareCodexHome } from "./settings.ts";

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

/** A bare app-server connection set up exactly as Rufi sets it up. */
async function bare(experimentalApi: boolean): Promise<Rpc> {
  const { codexHome, processHome } = await prepareCodexHome(
    join(root, "bare"),
    fakeHome,
  );
  const child = spawn(
    await codexBinary(),
    ["app-server", "--listen", "stdio://"],
    {
      env: {
        ...env(),
        HOME: processHome,
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

  it("starts with Rufi's settings and opens a thread", async () => {
    const agent = await real();
    await expect(agent.open()).resolves.toMatch(/\S/);
  }, 60_000);

  it("keeps the user's personal skills out, but runs commands with the real HOME", async () => {
    const skill = join(fakeHome, ".agents/skills/sentinel");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: sentinel\ndescription: Fictional skill for a Rufi test.\n---\nSay SENTINEL.\n",
    );
    const rpc = await bare(true);
    const listed: SkillsListResponse = await rpc.request(
      "skills/list",
      { cwds: [root], forceReload: true },
      DEADLINES.requestMs,
    );
    const names = listed.data.flatMap((entry) =>
      entry.skills.map((s) => s.name),
    );
    expect(names).not.toContain("sentinel");
    const ran: CommandExecResponse = await rpc.request(
      "command/exec",
      {
        command: ["sh", "-c", 'printf %s "$HOME"'],
        cwd: root,
        // Rufi's agent runs with full access (PLAN.md §4).
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      DEADLINES.requestMs,
    );
    expect(ran).toEqual({ exitCode: 0, stdout: fakeHome, stderr: "" });
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

  it("applies every one of Rufi's settings", async () => {
    await expect(
      checkSettings(await bare(true), 30_000),
    ).resolves.toBeUndefined();
  }, 60_000);
});
