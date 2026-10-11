// Contract tests against the pinned Codex binary itself, offline: the things
// generated types can't promise. No sign-in and no AI request is made. What
// Codex does when Rufi goes away also runs on the scripted fake, which must do
// the same.
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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeModel } from "../../../tests/fake-model.ts";
import { DEFAULT_ALLOWLIST } from "../../core/chat/models.ts";
import { forAgent } from "../../core/tools/tools.ts";
import { FIELDS } from "../../core/tools/save.ts";
import type { AgentEvent, AgentRuntime, AgentTools } from "../runtime.ts";
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

/** Rufi's Codex runtime on the real binary, with a fake token. */
async function real(
  options: {
    args?: string[];
    tools?: AgentTools;
    onEvent?: (event: AgentEvent) => void;
  } = {},
): Promise<AgentRuntime> {
  runtime = codexRuntime({
    home: join(root, "rufi"),
    command: { file: await codexBinary(), args: options.args ?? [] },
    ...(options.tools && { tools: options.tools }),
    env: env(),
    token: () => Promise.resolve("not-a-real-token"),
    version: "0.0.0",
    host: {
      onEvent: options.onEvent ?? (() => undefined),
      callTool: () => Promise.resolve({ ok: false, text: "{}" }),
    },
  });
  return runtime;
}

/** A bare app-server connection set up exactly as Rufi sets it up. */
async function bare(): Promise<Rpc> {
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
        // Rufi's agent runs with full access (PLAN.md §4).
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      DEADLINES.requestMs,
    );
    expect(ran).toEqual({ exitCode: 0, stdout: fakeHome, stderr: "" });
  }, 60_000);

  it("sends Rufi's tools to the model as the rufi namespace", async () => {
    const { tools, body } = await firstRequest("gpt-6.1-sol");
    // On this route the model gets one JavaScript tool, `exec`, and Rufi's
    // tools as functions inside it, declared in its description.
    const sent = JSON.stringify(body);
    const spec = tools.specs[0];
    expect(sent).toContain("\\n## rufi\\nRufi: the user's health record.");
    expect(sent).toContain("### `rufi__get_overview`");
    expect(sent).toContain(JSON.stringify(spec?.description).slice(1, -1));
    expect(sent).toContain(
      "declare const tools: { rufi__get_overview(args: {}): Promise<unknown>; };",
    );
    expect(sent).toContain(JSON.stringify(tools.instructions).slice(1, -1));
  });

  // Codex cuts a tool's input schema over its size limit down to `unknown`
  // before the model sees it, so the model would guess the shape.
  it.each(DEFAULT_ALLOWLIST)(
    "gives the model every tool's input on %s: Codex cuts only save_changes', whose description names its fields",
    async (model) => {
      const { tools, body } = await firstRequest(model);
      const exec = textsIn(body).find((text) =>
        text.includes("declare const tools"),
      );
      const cut = tools.specs.filter((spec) => {
        const start = exec?.indexOf(`rufi__${spec.name}(args:`) ?? -1;
        const declared = exec?.slice(
          start,
          exec.indexOf("): Promise<unknown>", start),
        );
        return start === -1 || /(?<!")\bunknown\b(?!")/.test(declared ?? "");
      });
      expect(cut.map((spec) => spec.name)).toEqual(["save_changes"]);
      // Its fields reach the model in its description.
      expect(cut[0]?.description).toContain(FIELDS);
      expect(exec).toContain(cut[0]?.description);
    },
  );
});

/**
 * The first request Codex sends the model on a new thread with Rufi's tools,
 * to a local stand-in for the model endpoint: it records what Codex sends
 * and refuses, so the turn ends without any AI. A protocol check only.
 */
async function firstRequest(model: string) {
  const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url?.endsWith("/responses")) {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":{"message":"offline test"}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const tools = forAgent(
      () => ({ store: undefined, personId: undefined }),
      () => undefined,
    );
    const ended = Promise.withResolvers<undefined>();
    const agent = await real({
      args: [
        "-c",
        `model_providers.openai_chatgpt_plan.base_url="http://127.0.0.1:${String(port)}/v1"`,
      ],
      tools: { namespace: tools.namespace, specs: tools.specs },
      onEvent: (event) => {
        if (event.type === "turnEnded") ended.resolve(undefined);
      },
    });
    const { threadId } = await agent.startThread({
      model,
      instructions: tools.instructions,
    });
    await agent.send(threadId, {
      id: "m-1",
      input: ["What are my latest results?"],
    });
    await ended.promise;
    return { tools, body: bodies[0] };
  } finally {
    server.close();
  }
}

/** Every string in a JSON value. */
const textsIn = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : typeof value === "object" && value !== null
      ? Object.values(value).flatMap(textsIn)
      : [];

const FAKE = join(import.meta.dirname, "../../../tests/fake-codex.ts");

/** The processes in `groups`: pid and command. */
async function members(groups: ReadonlySet<number>) {
  const { stdout } = await promisify(execFile)("ps", [
    "-A",
    "-o",
    "pid=,pgid=,command=",
  ]);
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null && groups.has(Number(match[2])))
    .map((match) => ({ pid: Number(match?.[1]), command: match?.[3] ?? "" }));
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
        const { codexHome, processHome } = await prepareCodexHome(
          join(root, "gone"),
          fakeHome,
        );
        // Started as Rufi starts it (appserver.ts): its own process group, pipes.
        const codex = spawn(
          name === "real" ? await codexBinary() : process.execPath,
          [
            ...(name === "real"
              ? [
                  "-c",
                  `model_providers.openai_chatgpt_plan.base_url="${model.url}"`,
                ]
              : [FAKE]),
            "app-server",
            "--listen",
            "stdio://",
          ],
          {
            env: {
              ...env(),
              HOME: processHome,
              CODEX_HOME: codexHome,
              ACCESS_TOKEN: "not-a-real-token",
            },
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
