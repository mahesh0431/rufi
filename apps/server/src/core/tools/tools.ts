// Every Rufi tool, and what the agent is told about them.
import { getOverview } from "./overview.ts";
import {
  inputSchema,
  toolCaller,
  type Tool,
  type ToolContext,
} from "./registry.ts";

export const TOOLS: readonly Tool[] = [getOverview];

/** The namespace the agent sees them in: rufi.get_overview. */
const NAMESPACE = "rufi";

/** PLAN.md §3.5: tools are the only way in to the record. */
const TOOL_INSTRUCTIONS =
  "The user's health record lives in Rufi. Read it only through the rufi tools. Never open, copy or query Rufi's database or files directly, by code, SQL or shell.";

/** The model's tools, in the shape an agent adapter takes (AgentTools). */
export function forAgent(
  context: () => ToolContext,
  log: (line: string) => void,
) {
  const tools = TOOLS.filter((tool) => tool.callers !== "ui");
  return {
    namespace: NAMESPACE,
    specs: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: inputSchema(tool),
    })),
    instructions: TOOL_INSTRUCTIONS,
    forTurn: () => toolCaller(tools, context, log),
  };
}

/** tools.json: every tool as documentation, generated (pnpm tools:json). */
export function toolsJson(): string {
  const tools = TOOLS.map((tool) => ({
    name: `${NAMESPACE}.${tool.name}`,
    description: tool.description,
    callers: tool.callers,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    inputSchema: inputSchema(tool),
    examples: tool.examples,
  }));
  return `${JSON.stringify({ tools }, null, 2)}\n`;
}
