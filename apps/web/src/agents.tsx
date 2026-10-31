// Rufi AI's agents at work, beside the chat: a row of chips above the box,
// one for each agent it started that works now, and the pop-up one opens,
// with the agent's own Activity and Stop. An agent whose turn ended leaves
// the row; its message to Rufi AI shows in the chat (transcript.tsx), and
// its name there opens the same pop-up.
import { Dialog } from "@base-ui/react/dialog";
import { modelOf, type SubAgent } from "@rufi/contracts";
import { LoaderCircle, Square, X } from "lucide-react";
import { useState } from "react";
import {
  openAgent,
  stopAgent,
  useChatAgents,
  useElapsed,
  useOpenAgent,
  working,
} from "./agents-state.ts";
import { messageOf } from "./live.ts";
import { effortName } from "./model-menu.tsx";
import { AgentActivity } from "./transcript.tsx";
import { Button, IconButton } from "./ui.tsx";

const PANEL =
  "fixed top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 rounded-[14px] bg-surface shadow-menu outline-none";
const BACKDROP = "fixed inset-0 z-40 bg-ink/25";

/** The row above the box: Rufi AI's own agents that work now; none, no row. */
export function AgentsAtWork({ personId }: { personId: string }) {
  const agents = (useChatAgents(personId).data?.agents ?? []).filter(
    (agent) => agent.parent === null && working(agent),
  );
  if (agents.length === 0) return null;
  return (
    <ul aria-label="Agents at work" className="flex flex-wrap gap-1.5 pb-2">
      {agents.map((agent) => (
        <li key={agent.id} className="max-w-full">
          <Chip personId={personId} agent={agent} />
        </li>
      ))}
    </ul>
  );
}

/** An agent at work: a spinner, its name and how long its turn has run. */
function Chip({ personId, agent }: { personId: string; agent: SubAgent }) {
  const elapsed = useElapsed(agent.since);
  return (
    <button
      type="button"
      onClick={() => {
        openAgent(personId, agent.id, agent.title);
      }}
      className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs hover:bg-side"
    >
      <LoaderCircle
        size={13}
        className="shrink-0 animate-spin text-muted"
        aria-hidden
      />
      <span className="truncate font-medium">{agent.title}</span>
      {elapsed !== undefined && (
        <span className="shrink-0 text-muted tabular-nums">{elapsed}</span>
      )}
    </button>
  );
}

/** The open agent's pop-up, over any screen. */
export function AgentSheet() {
  const open = useOpenAgent();
  if (!open) return null;
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) useOpenAgent.setState(null, true);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-over-chat className={BACKDROP} />
        <Dialog.Popup
          data-over-chat
          className={`${PANEL} flex h-[80vh] w-[600px] max-w-[94vw] flex-col overflow-hidden`}
        >
          <Sheet {...open} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Sheet({
  personId,
  agent: id,
  title: opened,
}: {
  personId: string;
  agent: string;
  title: string;
}) {
  const agent = useChatAgents(personId).data?.agents.find(
    (one) => one.id === id,
  );
  const model = modelOf(agent?.model ?? "");
  const elapsed = useElapsed(agent?.since ?? null);
  const [stopping, setStopping] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const title = agent?.title ?? opened;
  const busy = agent !== undefined && working(agent);
  return (
    <>
      <div className="flex items-start gap-2.5 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <Dialog.Title className="truncate text-[14px] font-bold">
            {title}
          </Dialog.Title>
          {agent && (
            <p className="truncate text-xs text-muted">
              {[
                agent.status,
                ...(busy && elapsed !== undefined ? [elapsed] : []),
                model?.name ?? agent.model,
                effortName(agent.effort),
              ].join(" · ")}
            </p>
          )}
        </div>
        {busy && (
          <Button
            icon={Square}
            busy={stopping && "Stopping…"}
            onClick={() => {
              setStopping(true);
              setProblem(null);
              stopAgent(personId, id)
                .catch((error: unknown) => {
                  setProblem(messageOf(error));
                })
                .finally(() => {
                  setStopping(false);
                });
            }}
          >
            Stop
          </Button>
        )}
        <Dialog.Close render={<IconButton label="Close" icon={X} />} />
      </div>
      {problem !== null && (
        <p role="alert" className="px-4 pt-2 text-xs text-muted">
          {problem}
        </p>
      )}
      <div
        tabIndex={0}
        role="group"
        aria-label={`${title}'s work`}
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto px-4 py-3 text-[13px]"
      >
        <AgentActivity personId={personId} id={id} title={title} />
      </div>
    </>
  );
}
