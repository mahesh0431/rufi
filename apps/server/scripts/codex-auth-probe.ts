// A live probe, not part of `pnpm check`: how the pinned Codex runs its
// provider's auth command, the command that gives it a ChatGPT token. Each
// case starts Codex in its own scratch folder with Rufi's settings, the
// provider's `auth` set to a command that asks this script for a token over
// loopback with a key from a file, and runs fictional turns. It reports when
// Codex ran the command and how often, with what the command saw, and what
// Codex did when the token was refused, or the command failed or hung.
// Only the sign-in comes from RUFI_HOME (the test sign-in). No token is
// printed or kept: the report is checked for every token served before it is
// printed.
//
//   RUFI_HOME=<test sign-in folder> node apps/server/scripts/codex-auth-probe.ts <empty folder>
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect } from "effect";
import type { ChatGptDeps } from "../src/agent/chatgpt/openai.ts";
import { accessToken } from "../src/agent/chatgpt/session.ts";
import { DEADLINES, startAppServer } from "../src/agent/codex/appserver.ts";
import { codexBinary } from "../src/agent/codex/binary.ts";
import { isRunning } from "../src/agent/codex/processes.ts";
import type { ThreadStartResponse } from "../src/agent/codex/protocol/v2/ThreadStartResponse.ts";
import type { TurnCompletedNotification } from "../src/agent/codex/protocol/v2/TurnCompletedNotification.ts";
import { AI_PROFILE, prepareCodexHome } from "../src/agent/codex/settings.ts";
import { childEnvironment, rufiHome } from "../src/platform/config.ts";
import { Secrets, secretsLayer } from "../src/platform/keychain.ts";

const out = resolve(process.argv[2] ?? "");
if (process.argv[2] === undefined || (await readdir(out)).length > 0) {
  throw new Error("Give an empty folder for the scratch Codex homes.");
}

const signIn: ChatGptDeps = {
  home: rufiHome(),
  secrets: await Effect.runPromise(
    Effect.provide(Effect.service(Secrets), secretsLayer),
  ),
  issuer: "https://auth.openai.com",
  sleep: (ms) => sleep(ms),
};
const { version, dependencies } = createRequire(import.meta.url)(
  "../package.json",
) as { version: string; dependencies: Record<string, string> };

/** The same token with its signature broken: OpenAI refuses it. */
const refused = (jwt: string) => {
  const [header, payload, signature = ""] = jwt.split(".");
  const flipped = signature.startsWith("A") ? "B" : "A";
  return `${header ?? ""}.${payload ?? ""}.${flipped}${signature.slice(1)}`;
};

/**
 * The command Codex runs: it reads the door's address and key from the file
 * it is given, asks for a token and prints it. It tells the door its process
 * id and whether it got Codex's environment (CODEX_HOME), never a value.
 */
const COMMAND = `
const { url, key } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
fetch(url, { headers: {
  authorization: "Bearer " + key,
  "x-pid": String(process.pid),
  "x-codex-env": process.env.CODEX_HOME ? "yes" : "no",
  "x-cwd": process.cwd(),
} }).then(async (r) => {
  const text = await r.text();
  if (r.ok) process.stdout.write(text);
  else { process.stderr.write("No token from the door: " + text); process.exitCode = 1; }
});`;

type Answer = "good" | "refused" | "fails" | "hangs";

interface Case {
  name: string;
  /** The door's answer to its nth request, from 1. */
  answer: (n: number) => Answer;
  /** Codex's `refresh_interval_ms` and `timeout_ms` for the command. */
  refreshMs: number;
  timeoutMs: number;
  /** The turns, one after another, and the pause before each after the first. */
  turns: string[];
  pauseMs?: number;
}

const READY = "Reply with the single word: ready.";
const CASES: Case[] = [
  {
    name: "renews by age: refresh every 5 s, a turn whose command takes 8 s, then a turn 6 s later",
    answer: () => "good",
    refreshMs: 5_000,
    timeoutMs: 10_000,
    turns: [
      "Run the command `sleep 8` once, then reply with the single word: ready.",
      READY,
    ],
    pauseMs: 6_000,
  },
  {
    name: "only after a 401: no refresh by age, the first token refused",
    answer: (n) => (n === 1 ? "refused" : "good"),
    refreshMs: 0,
    timeoutMs: 10_000,
    turns: [
      "Run the command `echo fictional` once, then reply with the single word: ready.",
      READY,
    ],
  },
  {
    name: "every token refused",
    answer: () => "refused",
    refreshMs: 0,
    timeoutMs: 10_000,
    turns: [READY],
  },
  {
    name: "the command fails (exit 1) every time",
    answer: () => "fails",
    refreshMs: 0,
    timeoutMs: 10_000,
    turns: [READY],
  },
  {
    name: "the command fails once, then works",
    answer: (n) => (n === 1 ? "fails" : "good"),
    refreshMs: 0,
    timeoutMs: 10_000,
    turns: [READY, READY],
  },
  {
    name: "the command hangs, with a 3 s timeout",
    answer: () => "hangs",
    refreshMs: 0,
    timeoutMs: 3_000,
    turns: [READY],
  },
];

/** How long a turn may take before the probe gives up on it. */
const TURN_MS = 3 * 60_000;

const served = new Set<string>();

async function run(probe: Case, folder: string) {
  const started = Date.now();
  const at = () => Date.now() - started;
  const timeline: string[] = [];
  const mark = (what: string) => timeline.push(`${String(at())} ms ${what}`);

  const key = randomBytes(32).toString("base64url");
  const pids: number[] = [];
  const hung = new Set<ServerResponse>();
  let asked = 0;
  const door = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${key}`) {
      mark(
        `door: refused a request without the key (${String(request.method)} ${String(request.url)}, ${String(request.headers["user-agent"])})`,
      );
      response.writeHead(401).end("Wrong key.");
      return;
    }
    asked += 1;
    const n = asked;
    const answer = probe.answer(n);
    pids.push(Number(request.headers["x-pid"]));
    mark(
      `command run ${String(n)}: ${answer}; Codex's environment: ${String(request.headers["x-codex-env"])}; cwd: ${String(request.headers["x-cwd"])}`,
    );
    if (answer === "hangs") {
      hung.add(response);
      return;
    }
    if (answer === "fails") {
      response.writeHead(503).end("Rufi is signed out of ChatGPT.");
      return;
    }
    // A token valid for two minutes at least: a longer ask can fall
    // between the token's end and the earliest renewal ChatGPT allows.
    void accessToken(signIn, 2 * 60_000).then(
      (token) => {
        const given = answer === "refused" ? refused(token) : token;
        served.add(token);
        served.add(given);
        response.end(given);
      },
      (error: unknown) => {
        mark(
          `door: no sign-in (${String((error as { code?: unknown }).code)})`,
        );
        response.writeHead(500).end("No sign-in.");
      },
    );
  });
  await new Promise<void>((done) => door.listen(0, "127.0.0.1", done));
  const { port } = door.address() as AddressInfo;
  const doorFile = join(folder, "door.json");
  await writeFile(
    doorFile,
    JSON.stringify({ url: `http://127.0.0.1:${String(port)}/`, key }),
    { mode: 0o600 },
  );

  const paths = await prepareCodexHome(join(folder, "rufi"), {
    userHome: join(folder, "user"),
    sandbox: { folder: join(folder, "rufi", "ai"), unreadable: [doorFile] },
  });
  const config = join(paths.codexHome, "config.toml");
  const auth = `auth = { command = ${JSON.stringify(process.execPath)}, args = ${JSON.stringify(["-e", COMMAND, doorFile])}, timeout_ms = ${String(probe.timeoutMs)}, refresh_interval_ms = ${String(probe.refreshMs)} }\n`;
  const before = await readFile(config, "utf8");
  if (!before.includes('env_key = "ACCESS_TOKEN"\n')) {
    throw new Error("Rufi's provider settings changed: update the probe.");
  }
  await writeFile(config, before.replace('env_key = "ACCESS_TOKEN"\n', auth));

  let completed = Promise.withResolvers<TurnCompletedNotification>();
  const app = await startAppServer({
    command: { file: await codexBinary(), args: [] },
    env: { ...childEnvironment(), HOME: paths.processHome },
    codexHome: paths.codexHome,
    token: "",
    version,
    deadlines: DEADLINES,
    handlers: {
      request: (method) => {
        mark(`Codex asked Rufi: ${method}`);
        return method.endsWith("/requestApproval")
          ? Promise.resolve({ decision: "decline" })
          : Promise.reject(new Error(`The probe doesn't answer ${method}.`));
      },
      notification: (method, params) => {
        if (method === "turn/completed") {
          completed.resolve(params as TurnCompletedNotification);
        } else if (method === "turn/started" || method === "item/started") {
          const item = (params as { item?: { type?: string } }).item;
          mark(`${method}${item?.type === undefined ? "" : ` ${item.type}`}`);
        } else if (method === "error") {
          const { error, willRetry } = params as {
            error?: { message?: string; codexErrorInfo?: unknown };
            willRetry?: boolean;
          };
          mark(
            `error (will retry: ${String(willRetry)}): ${JSON.stringify(error?.codexErrorInfo)} ${String(error?.message).slice(0, 300)}`,
          );
        } else if (method.startsWith("account/")) {
          mark(`${method} ${JSON.stringify(params).slice(0, 200)}`);
        }
      },
      ignored: (what) => {
        mark(`ignored: ${what}`);
      },
    },
    onExit: (why) => {
      mark(`app-server exited: ${why.message}`);
    },
  });
  mark("app-server started");

  const ends: unknown[] = [];
  try {
    const { thread } = await app.rpc.request<ThreadStartResponse>(
      "thread/start",
      {
        cwd: join(folder, "rufi", "ai"),
        approvalPolicy: "never",
        permissions: AI_PROFILE,
        developerInstructions: "Do exactly what the user asks, briefly.",
      },
      DEADLINES.requestMs,
    );
    mark("thread started");
    for (const [index, text] of probe.turns.entries()) {
      if (index > 0 && probe.pauseMs !== undefined) {
        await sleep(probe.pauseMs);
        mark(`paused ${String(probe.pauseMs)} ms`);
      }
      completed = Promise.withResolvers();
      await app.rpc.request(
        "turn/start",
        {
          threadId: thread.id,
          input: [{ type: "text", text, text_elements: [] }],
        },
        DEADLINES.requestMs,
      );
      mark(`turn ${String(index + 1)} sent`);
      const end = await Promise.race([
        completed.promise,
        sleep(TURN_MS).then(() => undefined),
      ]);
      if (end === undefined) {
        mark(`turn ${String(index + 1)} didn't end in ${String(TURN_MS)} ms`);
        ends.push("didn't end");
        break;
      }
      mark(`turn ${String(index + 1)} ${end.turn.status}`);
      ends.push({
        status: end.turn.status,
        ...(end.turn.error && {
          error: {
            codexErrorInfo: end.turn.error.codexErrorInfo,
            message: end.turn.error.message.slice(0, 400),
          },
        }),
      });
    }
  } finally {
    await app.stop();
    for (const response of hung) response.destroy();
    door.close();
  }
  return {
    case: probe.name,
    commandRuns: asked,
    commandsStillRunning: pids.filter((pid) => pid > 0 && isRunning(pid))
      .length,
    turns: ends,
    timeline,
  };
}

const report: unknown[] = [];
for (const [index, probe] of CASES.entries()) {
  const folder = join(out, String(index + 1));
  await mkdir(folder);
  report.push(await run(probe, folder));
}
const text = JSON.stringify(
  {
    codex: dependencies["@openai/codex"],
    at: new Date().toISOString(),
    cases: report,
  },
  null,
  2,
);
if ([...served].some((token) => text.includes(token)) || /eyJ/.test(text)) {
  throw new Error("The report holds a token: not printed.");
}
console.log(text);
