// What the screens read from the core, through one query cache. Each read is
// checked against its contract.
import {
  type SaveSettings,
  Backups,
  DataFolder,
  FirstRun,
  Models,
  People,
  Settings,
  Status,
} from "@rufi/contracts";
import { BriefPage } from "@rufi/contracts/briefs";
import { DeviceData } from "@rufi/contracts/devices";
import { DocumentItems, Documents } from "@rufi/contracts/documents";
import {
  FollowUps,
  type PageKind,
  Overview,
  RecordDetail,
  RecordPage,
  type ResultCategory,
  Series,
} from "@rufi/contracts/record";
import { Schema } from "effect";
import {
  focusManager,
  QueryClient,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
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
  // A read sent before this save would answer with older settings: dropped.
  await queries.cancelQueries({ queryKey: ["settings"] });
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

/**
 * Each device source and its state. Rufi converts by itself, so an open page
 * asks again: often while batches wait, then now and then.
 */
export const useDevices = () =>
  useQuery({
    queryKey: ["devices"],
    queryFn: () => read(DeviceData, "GET", "/api/devices"),
    refetchInterval: (query) =>
      query.state.data?.sources.some((source) => source.waiting > 0)
        ? 2_000
        : 60_000,
  });

/** Where Rufi keeps its data; it changes only while Rufi isn't running. */
export const useDataFolder = () =>
  useQuery({
    queryKey: ["data-folder"],
    queryFn: () => read(DataFolder, "GET", "/api/data-folder"),
    staleTime: Infinity,
  });

const OverviewAnswer = Schema.Struct({ overview: Overview });

/** The person's path in the local API. */
const personPath = (personId: string) =>
  `/api/people/${encodeURIComponent(personId)}`;

// A window that comes back to the front reads again (the queries that ask
// for it: Overview and Follow-ups). TanStack Query hears only that the page
// became visible; a page can stay visible behind another window, so the
// window's focus counts too.
focusManager.setEventListener((handleFocus) => {
  const listener = () => {
    handleFocus();
  };
  window.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  return () => {
    window.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
  };
});

/**
 * How often a page that depends on the clock (Needs you, Follow-ups) reads
 * again while it shows, so it crosses midnight within a minute.
 */
const CLOCK_MS = 60_000;

/**
 * The person's Overview: what needs them, their record as tiles, the latest
 * saves. Read again each minute while it shows, and when the window shows
 * again, since Needs you depends on the day.
 */
export const useOverview = (personId: string) =>
  useQuery({
    queryKey: ["overview", personId],
    refetchOnWindowFocus: true,
    refetchInterval: CLOCK_MS,
    queryFn: async () =>
      (await read(OverviewAnswer, "GET", `${personPath(personId)}/overview`))
        .overview,
  });

/** The person's follow-ups by when they are due, read again as Overview is. */
export const useFollowUps = (personId: string) =>
  useQuery({
    queryKey: ["follow-ups", personId],
    refetchOnWindowFocus: true,
    refetchInterval: CLOCK_MS,
    queryFn: () => read(FollowUps, "GET", `${personPath(personId)}/follow-ups`),
  });

/** A kind's page of the person's record: groups, newest first, more as asked. */
export const useRecordPages = (personId: string, kind: PageKind) =>
  useInfiniteQuery({
    queryKey: ["record", personId, kind],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: RecordPage) => last.next ?? undefined,
    queryFn: ({ pageParam }) =>
      read(
        RecordPage,
        "GET",
        `${personPath(personId)}/record/${kind}${pageParam === undefined ? "" : `?after=${encodeURIComponent(pageParam)}`}`,
      ),
  });

/** One record opened: its sources, its history and its versions. */
export const useRecordDetail = (personId: string, kind: string, id: string) =>
  useQuery({
    queryKey: ["record", personId, kind, id],
    queryFn: () =>
      read(
        RecordDetail,
        "GET",
        `${personPath(personId)}/record/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
      ),
  });

/**
 * A test's current values in one unit (none: the values without a unit)
 * and one category.
 */
export const useSeries = (
  personId: string,
  test: string,
  unit: string | undefined,
  category: ResultCategory,
) =>
  useQuery({
    queryKey: ["series", personId, test, unit ?? null, category],
    queryFn: () =>
      read(
        Series,
        "GET",
        `${personPath(personId)}/series?${new URLSearchParams({ test, ...(unit !== undefined && { unit }), category }).toString()}`,
      ),
  });

/** The models a chat can use; asks the AI, so it can fail. */
export const useModels = () =>
  useQuery({
    queryKey: ["models"],
    queryFn: () => read(Models, "GET", "/api/models"),
  });

/** A person's documents, newest first; looked at again while one is read. */
export const useDocuments = (personId: string) =>
  useQuery({
    queryKey: ["documents", personId],
    refetchInterval: (query) =>
      query.state.data?.some((d) => d.status === "reading") ? 3_000 : false,
    queryFn: async () =>
      (
        await read(
          Documents,
          "GET",
          `/api/people/${encodeURIComponent(personId)}/documents`,
        )
      ).documents,
  });

/**
 * A document's pages and draft items. Let go once nothing shows them, so
 * opened again they never show an earlier state, such as items since saved.
 */
export const useDocumentItems = (personId: string, documentId: string) =>
  useQuery({
    queryKey: ["items", personId, documentId],
    queryFn: () =>
      read(
        DocumentItems,
        "GET",
        `${personPath(personId)}/documents/${encodeURIComponent(documentId)}/items`,
      ),
    gcTime: 0,
  });

/** A visit brief of the person's, with its Sources as Rufi built them. */
export const useBrief = (personId: string, briefId: string) =>
  useQuery({
    queryKey: ["brief", personId, briefId],
    queryFn: async () =>
      (
        await read(
          BriefPage,
          "GET",
          `/api/people/${encodeURIComponent(personId)}/briefs/${encodeURIComponent(briefId)}`,
        )
      ).brief,
  });
