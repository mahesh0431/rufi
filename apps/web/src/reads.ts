// What the screens read from the core, through one query cache. Each read is
// checked against its contract.
import {
  Conversations,
  Models,
  Overview,
  People,
  Settings,
  Status,
} from "@rufi/contracts";
import { Schema } from "effect";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { read } from "./api.ts";

export const queries = new QueryClient({
  defaultOptions: {
    // The API answers from this Mac; a failure is shown, not hidden by retries.
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

export const usePeople = () =>
  useQuery({
    queryKey: ["people"],
    queryFn: async () => (await read(People, "GET", "/api/people")).people,
  });

export const useSettings = () =>
  useQuery({
    queryKey: ["settings"],
    queryFn: () => read(Settings, "GET", "/api/settings"),
  });

export const useStatus = () =>
  useQuery({
    queryKey: ["status"],
    queryFn: () => read(Status, "GET", "/api/status"),
  });

const OverviewAnswer = Schema.Struct({ overview: Overview });

export const useOverview = (personId: string) =>
  useQuery({
    queryKey: ["overview", personId],
    queryFn: async () =>
      (
        await read(
          OverviewAnswer,
          "GET",
          `/api/people/${encodeURIComponent(personId)}/overview`,
        )
      ).overview,
  });

export const conversationsKey = (personId: string) => [
  "conversations",
  personId,
];

/** Each person's latest choice of conversation here, numbered. */
const choices = new Map<string, { n: number; chosen: string | null }>();

/**
 * The person chose the conversation the chat continues (null: a new one). A
 * list read that started before it shows this choice, not the core's older
 * one.
 */
export function chose(personId: string, chosen: string | null): void {
  choices.set(personId, { n: (choices.get(personId)?.n ?? 0) + 1, chosen });
}

/** A person's conversations and the one the chat continues. */
export const useConversations = (personId: string) =>
  useQuery({
    queryKey: conversationsKey(personId),
    queryFn: async () => {
      const before = choices.get(personId)?.n;
      const list = await read(
        Conversations,
        "GET",
        `/api/people/${encodeURIComponent(personId)}/conversations`,
      );
      const latest = choices.get(personId);
      return latest && latest.n !== before
        ? { ...list, chosen: latest.chosen }
        : list;
    },
    // A title another tab gave shows when you come back to this one.
    refetchOnWindowFocus: true,
  });

/** The models a conversation can use; asks the AI, so it can fail. */
export const useModels = () =>
  useQuery({
    queryKey: ["models"],
    queryFn: () => read(Models, "GET", "/api/models"),
  });
