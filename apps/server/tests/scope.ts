// A turn's scope as the door places it (server/door.ts), for a test that
// calls Rufi's tools without an agent.
import type { ChatRow } from "../src/core/chat/transcript.ts";
import { TOOLS, type TurnScope } from "../src/core/tools/tools.ts";

export const turnScope = (chat: ChatRow, ref: string): TurnScope => ({
  chat,
  agent: "agent-1",
  thread: chat.threadId ?? "thread-1",
  conversation: 1,
  turn: `turn-${ref}`,
  ref,
  tools: TOOLS.map((tool) => tool.name),
});
