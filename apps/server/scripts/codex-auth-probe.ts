// A live probe, not part of `pnpm check`: how the pinned Codex runs its
// provider's auth command, the command that gives it a ChatGPT token from
// Rufi's token door (agent/codex/token-door.ts). Each case starts Codex in
// its own scratch folder with Rufi's settings, sandbox and door, Codex's refresh
// interval and command timeout set for the case, and runs fictional turns;
// the door's sign-in answers as the case says. It reports when Codex asked
// the door and how often, and what Codex did when the token was refused, or
// the door had none or never answered. Only the sign-in comes from RUFI_HOME
// (the test sign-in). No token is printed or kept: the report is checked for
// every token served before it is printed. Rerun it when the Codex pin moves.
//
//   RUFI_HOME=<test sign-in folder> node apps/server/scripts/codex-auth-probe.ts <empty folder>
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Effect } from "effect";
import { ChatGptError, type ChatGptDeps } from "../src/agent/chatgpt/openai.ts";
import { accessToken } from "../src/agent/chatgpt/session.ts";
import { DEADLINES, startAppServer } from "../src/agent/codex/appserver.ts";
import { codexBinary } from "../src/agent/codex/binary.ts";
import type { ThreadStartResponse } from "../src/agent/codex/protocol/v2/ThreadStartResponse.ts";
import type { TurnCompletedNotification } from "../src/agent/codex/protocol/v2/TurnCompletedNotification.ts";
import { AI_PROFILE, prepareCodexHome } from "../src/agent/codex/settings.ts";
import { doorFile } from "../src/agent/codex/token-door.ts";
import { childEnvironment, rufiHome } from "../src/platform/config.ts";
import { aiSandbox } from "../src/server/core.ts";
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
    name: "the door has no token (signed out) every time",
    answer: () => "fails",
    refreshMs: 0,
    timeoutMs: 10_000,
    turns: [READY],
  },
  {
    name: "the door has no token once, then gives one",
    answer: (n) => (n === 1 ? "fails" : "good"),
    refreshMs: 0,
    timeoutMs: 10_000,
    turns: [READY, READY],
  },
  {
    name: "the door never answers, with a 3 s timeout",
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

  // The door's sign-in, answering as the case says.
  let asked = 0;
  const token = async (validForMs: number) => {
    asked += 1;
    const answer = probe.answer(asked);
    mark(`door asked (${String(asked)}): ${answer}`);
    if (answer === "hangs") return new Promise<string>(() => undefined);
    if (answer === "fails") {
      throw new ChatGptError("sign_in_again", "Fictional: the sign-in ended.");
    }
    const real = await accessToken(signIn, validForMs);
    const given = answer === "refused" ? refused(real) : real;
    served.add(real);
    served.add(given);
    return given;
  };

  const home = join(folder, "rufi");
  const door = doorFile(home, "chat");
  // Rufi's own sandbox: its commands can't read the door's file, which
  // opens the test sign-in's real token.
  const paths = await prepareCodexHome(home, {
    door,
    userHome: join(folder, "user"),
    sandbox: aiSandbox(home),
  });
  const config = join(paths.codexHome, "config.toml");
  const before = await readFile(config, "utf8");
  const timing = /^timeout_ms = \d+\nrefresh_interval_ms = \d+$/m;
  if (!timing.test(before)) {
    throw new Error("Rufi's provider settings changed: update the probe.");
  }
  await writeFile(
    config,
    before.replace(
      timing,
      `timeout_ms = ${String(probe.timeoutMs)}\nrefresh_interval_ms = ${String(probe.refreshMs)}`,
    ),
  );

  let completed = Promise.withResolvers<TurnCompletedNotification>();
  const app = await startAppServer({
    command: { file: await codexBinary(), args: [] },
    env: { ...childEnvironment(), HOME: paths.processHome },
    codexHome: paths.codexHome,
    door,
    token,
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
        sleep(TURN_MS, undefined, { ref: false }),
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
  }
  // The command's arguments name the door's file.
  const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "command="]);
  return {
    case: probe.name,
    doorAsked: asked,
    signedOutAt: app.signedOutAt() === undefined ? null : "during the case",
    commandsStillRunning: stdout
      .split("\n")
      .filter((line) => line.includes(door)).length,
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
