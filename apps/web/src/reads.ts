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
    // It is there with or without the internet, so nothing waits for that.
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      networkMode: "always",
    },
    mutations: { networkMode: "always" },
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

/** A person's conversations, and the one the core opens the chat on (choice.ts). */
export const useConversations = (personId: string) =>
  useQuery({
    queryKey: conversationsKey(personId),
    queryFn: async () => {
      return read(
        Conversations,
        "GET",
        `/api/people/${encodeURIComponent(personId)}/conversations`,
      );
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
