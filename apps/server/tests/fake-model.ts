// A local stand-in for the model endpoint, so the real Codex binary runs real
// turns offline. Codex sends it each request; it answers by the user's last
// message, with the same words as the scripted fake Codex (fake-codex.ts):
// "hang" never answers, "slow" answers after 1.5 s, "overview" first reads
// Rufi's get_overview (through Codex's `exec` tool, as a model does),
// "command" runs a long command (as the fake's does, it ignores TERM and
// leaves a program in the background) and Codex waits for it, "background
// command" runs the same command and the reply ends while it runs, and
// anything else answers "ok:<text>". No sign-in and no AI.
// With a `script`, it answers each request with the script's next step
// instead (a call of a direct tool, or text), reporting the step's tokens as
// the usage, so a test can drive a whole sub-agent turn and force a
// compaction. Codex's own compaction request is always answered with a
// summary and takes no step.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelRequest {
  instructions?: string;
  input: {
    type?: string;
    role?: string;
    content?: { type?: string; text?: string; image_url?: string }[];
    output?: string | { type?: string; text?: string; image_url?: string }[];
    tools?: unknown[];
  }[];
  tools?: unknown[];
  reasoning?: { effort?: string };
}

/** One scripted answer: a call of one of the thread's direct tools, or text. */
export type Step = (
  | { call: { namespace?: string; name: string; arguments: unknown } }
  /** JavaScript for Codex's `exec` tool, on a model that has it. */
  | { exec: string }
  | { text: string }
) & {
  /** The usage the answer reports; over Codex's limit, it compacts. */
  tokens?: number;
};

export interface FakeModel {
  /** The base URL for Codex's provider setting. */
  url: string;
  /** Every request body Codex sent, in order. */
  requests: ModelRequest[];
  close: () => Promise<void>;
}

/** The prompt Codex sends to have the thread summarised (0.159.3). */
const COMPACTION = "You are performing a CONTEXT CHECKPOINT COMPACTION";

export async function fakeModel(
  options: { script?: readonly Step[] } = {},
): Promise<FakeModel> {
  const script = [...(options.script ?? [])];
  const requests: FakeModel["requests"] = [];
  const open = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (!request.url?.endsWith("/responses")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as FakeModel["requests"][number];
      requests.push(body);
      const texts = body.input
        .filter((item) => item.role === "user")
        .flatMap((item) => (item.content ?? []).map((part) => part.text ?? ""));
      const last = texts.at(-1) ?? "";
      // The tool's result came back: now the answer.
      const answered = body.input.at(-1)?.type === "custom_tool_call_output";
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (data: { type: string }) => {
        response.write(
          `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      };
      const id = `resp-${String(requests.length)}`;
      event({ type: "response.created", response: { id } } as { type: string });
      const completed = (tokens = 2) => {
        event({
          type: "response.completed",
          response: {
            id,
            usage: {
              input_tokens: tokens - 1,
              input_tokens_details: null,
              output_tokens: 1,
              output_tokens_details: null,
              total_tokens: tokens,
            },
          },
        } as { type: string });
        response.end();
      };
      const say = (text: string, tokens?: number) => {
        const item = {
          type: "message",
          role: "assistant",
          id: `msg-${String(requests.length)}`,
          content: [{ type: "output_text", text }],
        };
        for (const type of [
          "response.output_item.added",
          "response.output_item.done",
        ]) {
          event({ type, item } as { type: string });
        }
        completed(tokens);
      };
      if (options.script) {
        if (last.startsWith(COMPACTION)) {
          say("Summary: the reading so far.");
          return;
        }
        const step = script.shift() ?? { text: "done" };
        if ("text" in step) {
          say(step.text, step.tokens);
          return;
        }
        const call =
          "exec" in step
            ? {
                type: "custom_tool_call",
                id: `ctc-${String(requests.length)}`,
                call_id: `call-${String(requests.length)}`,
                name: "exec",
                input: step.exec,
              }
            : {
                type: "function_call",
                id: `fc-${String(requests.length)}`,
                call_id: `call-${String(requests.length)}`,
                name: step.call.name,
                ...(step.call.namespace !== undefined && {
                  namespace: step.call.namespace,
                }),
                arguments: JSON.stringify(step.call.arguments),
              };
        for (const type of [
          "response.output_item.added",
          "response.output_item.done",
        ]) {
          event({ type, item: call } as { type: string });
        }
        completed(step.tokens);
        return;
      }
      if (last.includes("overview") && !answered) {
        const call = {
          type: "custom_tool_call",
          id: `ctc-${String(requests.length)}`,
          call_id: `call-${String(requests.length)}`,
          name: "exec",
          input: "text(JSON.stringify(await tools.rufi__get_overview({})))",
        };
        for (const type of [
          "response.output_item.added",
          "response.output_item.done",
        ]) {
          event({ type, item: call } as { type: string });
        }
        completed();
        return;
      }
      if (last.includes("hang")) {
        open.add(response);
        return;
      }
      const ran = body.input.some(
        (item) => item.type === "function_call_output",
      );
      if (last.includes("command") && !ran) {
        const call = {
          type: "function_call",
          call_id: "call-command",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: 'trap "" TERM; sleep 300 & sleep 301',
            // How long Codex waits for the command before the reply goes on.
            yield_time_ms: last.includes("background") ? 500 : 60_000,
          }),
        };
        for (const type of [
          "response.output_item.added",
          "response.output_item.done",
        ]) {
          event({ type, item: call } as { type: string });
        }
        completed();
        return;
      }
      // A steer arrives as the last message of a later request in the same turn.
      const delay = last.includes("slow") ? 1_500 : 0;
      setTimeout(() => {
        const item = `msg-${String(requests.length)}`;
        const text = `ok:${last}`;
        event({
          type: "response.output_item.added",
          item: { type: "message", role: "assistant", id: item, content: [] },
        } as { type: string });
        for (const delta of [text.slice(0, 3), text.slice(3)]) {
          event({
            type: "response.output_text.delta",
            delta,
            item_id: item,
          } as { type: string });
        }
        event({
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: item,
            content: [{ type: "output_text", text }],
          },
        } as { type: string });
        completed();
      }, delay);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const response of open) response.destroy();
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
