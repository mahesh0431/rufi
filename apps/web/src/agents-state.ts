// The chat's sub-agents for the screens: the list the row above the box and
// their lines read (read again as they act, live.ts), and which agent's
// pop-up is open (agents.tsx), from a chip, a step or a message.
import { type SubAgent, SubAgents } from "@rufi/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { create } from "zustand/react";
import { read, request } from "./api.ts";
import { chatPath } from "./live.ts";

/** The chat's sub-agents, oldest first. */
export const useChatAgents = (personId: string) =>
  useQuery({
    queryKey: ["agents", personId],
    queryFn: () => read(SubAgents, "GET", `${chatPath(personId)}/agents`),
  });

/** At work: before its first turn, running, or going on after a restart. */
export const working = (agent: Pick<SubAgent, "status">) =>
  agent.status === "idle" ||
  agent.status === "running" ||
  agent.status === "continuing";

/** The agent whose pop-up is open, with the name it was opened by. */
export const useOpenAgent = create<{
  personId: string;
  agent: string;
  title: string;
} | null>(() => null);

export const openAgent = (personId: string, agent: string, title: string) => {
  useOpenAgent.setState({ personId, agent, title }, true);
};

/** Stops the agent and the agents it started. */
export const stopAgent = (personId: string, agent: string) =>
  request(
    "POST",
    `${chatPath(personId)}/agents/stop?agent=${encodeURIComponent(agent)}`,
  );

/** "1:05": minutes and seconds since `since`, counting up each second. */
export function useElapsed(since: string | null): string | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [since]);
  if (since === null) return undefined;
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}
