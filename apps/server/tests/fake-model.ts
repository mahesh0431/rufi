// A local stand-in for the model endpoint, so the real Codex binary runs real
// turns offline. Codex sends it each request; it answers by the user's last
// message, with the same words as the scripted fake Codex (fake-codex.ts):
// "hang" never answers, "slow" answers after 1.5 s, "command" runs a long
// command (as the fake's does, it ignores TERM and leaves a program in the
// background) and Codex waits for it, "background command" runs the same
// command and the reply ends while it runs, anything else answers
// "ok:<text>". No sign-in and no AI.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeModel {
  /** The base URL for Codex's provider setting. */
  url: string;
  /** Every request body Codex sent, in order. */
  requests: {
    input: { type?: string; role?: string; content?: { text?: string }[] }[];
  }[];
  close: () => Promise<void>;
}

const USAGE = {
  input_tokens: 1,
  input_tokens_details: null,
  output_tokens: 1,
  output_tokens_details: null,
  total_tokens: 2,
};

export async function fakeModel(): Promise<FakeModel> {
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
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (data: { type: string }) => {
        response.write(
          `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      };
      const id = `resp-${String(requests.length)}`;
      event({ type: "response.created", response: { id } } as { type: string });
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
        event({ type: "response.output_item.added", item: call } as {
          type: string;
        });
        event({ type: "response.output_item.done", item: call } as {
          type: string;
        });
        event({
          type: "response.completed",
          response: { id, usage: USAGE },
        } as { type: string });
        response.end();
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
        event({
          type: "response.completed",
          response: {
            id,
            usage: USAGE,
          },
        } as { type: string });
        response.end();
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
