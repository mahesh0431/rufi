// Contract tests against the pinned Codex binary itself, offline: the things
// generated types can't promise. No sign-in and no AI request is made: Codex
// runs on a provider of the test's own, with no sign-in, pointed at a local
// stand-in for the model. What Codex does when Rufi goes away also runs on the
// scripted fake, which must do the same.
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateProtocol,
  listFiles,
  PROTOCOL_DIR,
} from "../../../scripts/codex-types.ts";
import { codexArgs, fakeModel } from "../../../tests/fake-model.ts";
import { DEFAULT_ALLOWLIST } from "../../core/chat/models.ts";
import type { AgentRuntime } from "../runtime.ts";
import { DEADLINES } from "./appserver.ts";
import { codexBinary } from "./binary.ts";
import { codexRuntime } from "./codex.ts";
import { isRunning, killTree, trackGroups } from "./processes.ts";
import type { CommandExecResponse } from "./protocol/v2/CommandExecResponse.ts";
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse.ts";
import { connect, type Rpc } from "./rpc.ts";
import { prepareCodexHome } from "./settings.ts";

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

/** The AI's folder in a data folder, and its database kept from it. */
const sandboxOf = (home: string) => ({
  folder: join(home, "ai"),
  unreadable: [join(home, "rufi.sqlite")],
});

/** Rufi's Codex runtime on the real binary, on the test's provider. */
async function real(): Promise<AgentRuntime> {
  runtime = codexRuntime({
    home: join(root, "rufi"),
    sandbox: sandboxOf(join(root, "rufi")),
    skills: [],
    command: { file: await codexBinary(), args: codexArgs() },
    env: env(),
    version: "0.0.0",
    host: { onEvent: () => undefined },
  });
  return runtime;
}

/** A bare app-server connection set up exactly as Rufi sets it up. */
async function bare(): Promise<Rpc> {
  const home = join(root, "bare");
  const { codexHome, processHome } = await prepareCodexHome(home, {
    userHome: fakeHome,
    sandbox: sandboxOf(home),
  });
  const child = spawn(
    await codexBinary(),
    ["app-server", "--listen", "stdio://"],
    {
      env: { ...env(), HOME: processHome, CODEX_HOME: codexHome },
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
  raw = {
    rpc,
    stop: () => {
      child.kill();
    },
  };
  await rpc.request(
    "initialize",
    {
      clientInfo: { name: "Rufi", title: "Rufi", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
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

  it("offers every model Rufi allows by default", async () => {
    const ids = (await (await real()).models()).map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining(DEFAULT_ALLOWLIST));
  }, 60_000);

  it("keeps the user's personal skills out, but runs commands with the real HOME", async () => {
    const skill = join(fakeHome, ".agents/skills/sentinel");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: sentinel\ndescription: Fictional skill for a Rufi test.\n---\nSay SENTINEL.\n",
    );
    const rpc = await bare();
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
        // Only the commands' HOME here; the canary in capture.test.ts
        // checks the sandbox Rufi gives them.
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      DEADLINES.requestMs,
    );
    expect(ran).toEqual({ exitCode: 0, stdout: fakeHome, stderr: "" });
  }, 60_000);
});

const FAKE = join(import.meta.dirname, "../../../tests/fake-codex.ts");

/**
 * The processes in `groups`: pid and command. Only their commands are read:
 * another program's command line can be as long as `ps`'s whole answer may
 * be.
 */
async function members(groups: ReadonlySet<number>) {
  const run = promisify(execFile);
  const { stdout: table } = await run("ps", ["-A", "-o", "pid=,pgid="]);
  const pids = table
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, pgid]) => pgid !== undefined && groups.has(pgid))
    .map(([pid]) => String(pid));
  if (pids.length === 0) return [];
  const { stdout } = await run("ps", [
    "-o",
    "pid=,command=",
    "-p",
    pids.join(","),
  ]).catch((error: unknown) => {
    // 1: none of them runs any more.
    if ((error as { code?: unknown }).code === 1) return { stdout: "" };
    throw error;
  });
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ pid: Number(match[1]), command: match[2] ?? "" }));
}

/** Polls `done` until it holds; fails, saying `what`, after `ms`. */
async function until(what: string, done: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}.`);
    await sleep(50);
  }
}

describe.each(["fake", "real"] as const)(
  "the %s Codex, when Rufi goes away",
  (name) => {
    // Rufi relies on this when its core is killed or crashes: nothing it
    // started keeps running, whether the reply that started it still runs or
    // has ended.
    it.each([
      { when: "while its reply runs", message: "command", ended: false },
      {
        when: "after its reply has ended",
        message: "background command",
        ended: true,
      },
    ])(
      "ends the command it runs $when, with what it left in the background, and itself",
      async ({ message, ended }) => {
        const model = await fakeModel();
        const home = join(root, "gone");
        const { codexHome, processHome } = await prepareCodexHome(home, {
          userHome: fakeHome,
          sandbox: sandboxOf(home),
        });
        // Started as Rufi starts it (appserver.ts): its own process group, pipes.
        const codex = spawn(
          name === "real" ? await codexBinary() : process.execPath,
          [
            ...(name === "real" ? codexArgs(model.url) : [FAKE]),
            "app-server",
            "--listen",
            "stdio://",
          ],
          {
            env: { ...env(), HOME: processHome, CODEX_HOME: codexHome },
            stdio: ["pipe", "pipe", "ignore"],
            detached: true,
          },
        );
        const pid = codex.pid ?? 0;
        const groups = new Set<number>();
        const completed: unknown[] = [];
        try {
          const rpc = connect(
            codex.stdout,
            codex.stdin,
            {
              request: () => Promise.reject(new Error("no requests expected")),
              notification: (method, params) => {
                if (method === "turn/completed") completed.push(params);
              },
              ignored: () => undefined,
            },
            DEADLINES.answerMs,
          );
          await rpc.request(
            "initialize",
            {
              clientInfo: { name: "Rufi", title: "Rufi", version: "0.0.0" },
              capabilities: {
                experimentalApi: true,
                requestAttestation: false,
              },
            },
            DEADLINES.requestMs,
          );
          rpc.notify("initialized");
          const { thread } = await rpc.request<{ thread: { id: string } }>(
            "thread/start",
            {
              model: "gpt-6.1-sol",
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              cwd: root,
            },
            DEADLINES.requestMs,
          );
          await rpc.request(
            "turn/start",
            {
              threadId: thread.id,
              input: [{ type: "text", text: message, text_elements: [] }],
              clientUserMessageId: "m-1",
            },
            DEADLINES.requestMs,
          );
          const running = async () => {
            await trackGroups(pid, groups);
            return (await members(groups)).map((p) => p.command);
          };
          await until(
            "the command and its background program to start",
            async () => {
              const now = await running();
              return ["sleep 300", "sleep 301"].every((c) => now.includes(c));
            },
            30_000,
          );
          if (ended) {
            await until(
              "the reply to end",
              () => Promise.resolve(completed.length > 0),
              30_000,
            );
          }
          // Both programs run now, and the reply has ended or still runs.
          expect(await running()).toEqual(
            expect.arrayContaining(["sleep 300", "sleep 301"]),
          );
          expect(completed).toHaveLength(ended ? 1 : 0);
          const programs = (await members(groups)).map((p) => p.pid);

          // When Rufi's process ends, the system closes its ends of the pipes.
          codex.stdin.destroy();
          codex.stdout.destroy();
          await until(
            "Codex and its programs to end",
            () => Promise.resolve(![pid, ...programs].some(isRunning)),
            5_000,
          );
        } finally {
          await killTree(pid, groups);
          await model.close();
        }
      },
      60_000,
    );
  },
);
