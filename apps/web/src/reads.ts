// What the screens read from the core, through one query cache. Each read is
// checked against its contract.
import {
  type SaveSettings,
  Backups,
  FirstRun,
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

/** The other open pages of this browser or app, told when a setting changes. */
const settingsChanged = new BroadcastChannel("rufi.settings");
settingsChanged.addEventListener("message", () => {
  void queries.invalidateQueries({ queryKey: ["settings"] });
});

/** Changes settings: this page and every other open one show the change. */
export async function saveSettings(
  changes: typeof SaveSettings.Type,
): Promise<Settings> {
  const saved = await read(Settings, "PUT", "/api/settings", changes);
  queries.setQueryData(["settings"], saved);
  settingsChanged.postMessage("changed");
  return saved;
}

export const useStatus = () =>
  useQuery({
    queryKey: ["status"],
    queryFn: () => read(Status, "GET", "/api/status"),
  });

/** The first step of the first run not done yet, kept by the core. */
export const useFirstRun = () =>
  useQuery({
    queryKey: ["first-run"],
    queryFn: () => read(FirstRun, "GET", "/api/first-run"),
  });

/**
 * The last good backup and the last failed try. Rufi backs up by itself, so
 * an open page asks again: often while one runs, then now and then.
 */
export const useBackups = () =>
  useQuery({
    queryKey: ["backups"],
    queryFn: () => read(Backups, "GET", "/api/backups"),
    refetchInterval: (query) =>
      query.state.data?.running === true ? 1_000 : 60_000,
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

/** The models a chat can use; asks the AI, so it can fail. */
export const useModels = () =>
  useQuery({
    queryKey: ["models"],
    queryFn: () => read(Models, "GET", "/api/models"),
  });
