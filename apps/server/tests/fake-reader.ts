// A scripted stand-in for the reader sub-agent, for tests of what Rufi does
// around a reading: each run plays the next script with the reader's real
// tools (get_page, save_page), through Rufi's MCP server with the run's key
// as the real reader does, and ends as the script says. The real runner on
// the real Codex is proved in agent/codex/subagent.test.ts.
import type {
  RunSubAgent,
  SubAgentOutcome,
  SubAgentTask,
} from "../src/agent/runtime.ts";
import { callTool } from "./mcp-client.ts";

/** A tool's answer as the reader gets it: its text, parsed. */
interface Answer {
  ok: boolean;
  text: string;
  json: unknown;
}

interface ReaderTurn {
  /** Calls a reader tool; its answer, parsed. */
  call: (name: string, input: unknown) => Promise<Answer>;
  look: (page: number) => Promise<unknown>;
  /** Saves the page's copy: its outcome, its Markdown and why. */
  save: (page: number, copy: object) => Promise<Answer>;
  task: SubAgentTask;
  signal: AbortSignal | undefined;
  /** Waits for Rufi to stop the run, also when it already has. */
  stopped: () => Promise<void>;
}

/** One run: what it does, and how it ends (completed when it returns nothing). */
export type Script = (
  turn: ReaderTurn,
) => Promise<Partial<SubAgentOutcome> | undefined>;

/** A reader that plays `scripts` in order, one per run; `runs` records each. */
export function scriptedReader(scripts: Script[]) {
  const runs: SubAgentTask[] = [];
  const run: RunSubAgent = async (task, signal) => {
    runs.push(task);
    const script = scripts.shift();
    if (!script) throw new Error("No script left for this run.");
    const call = async (name: string, input: unknown): Promise<Answer> => {
      const { status, result } = await callTool(
        {
          url: task.tools.url,
          http_headers: { Authorization: `Bearer ${task.tools.key}` },
        },
        {
          name,
          arguments: input,
          callId: `call-${String(Math.random())}`,
          threadId: "fake-reader",
          turnId: "fake-reader-turn",
        },
      );
      // A key that opens nothing any more: as Codex reports it to the model.
      if (status !== 200 || !result) {
        const text = JSON.stringify({
          ok: false,
          error: `HTTP ${String(status)}`,
        });
        return { ok: false, text, json: JSON.parse(text) as unknown };
      }
      const [first] = result["content"] as { text: string }[];
      const text = first?.text ?? "";
      return {
        ok: result["isError"] !== true,
        text,
        json: JSON.parse(text) as unknown,
      };
    };
    const turn: ReaderTurn = {
      call,
      look: async (page) => (await call("get_page", { page })).json,
      save: (page, copy) => call("save_page", { page, ...copy }),
      task,
      signal,
      stopped: () =>
        new Promise((resolve) => {
          if (signal?.aborted) resolve();
          signal?.addEventListener("abort", () => {
            resolve();
          });
        }),
    };
    const ended = await script(turn);
    return {
      end: { status: "completed" },
      compactions: 0,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 120,
      },
      ...ended,
    };
  };
  return { run, runs };
}

/** A page's copy with one fictional result, as the reader saves it. */
export const readPage = (value = "13.2") => ({
  outcome: "read",
  copy: `# Sunrise Labs\n\nCollected: 12 Aug 2026\n\n| Test | Result | Unit | Range |\n| --- | --- | --- | --- |\n| Haemoglobin | ${value} | g/dL | 12.0-15.0 |`,
});
