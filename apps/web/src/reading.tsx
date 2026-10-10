// Reading documents on the screens: the one-time yes, the reader strip above
// the chat box, and Open: a reading's work as the reader saved it, read
// only. Rufi's live stream says when readings change; the Documents page
// also looks again while one reads.
import { Dialog } from "@base-ui/react/dialog";
import type { Person } from "@rufi/contracts";
import {
  type DocumentSummary,
  type ReadEntry,
  ReadingView,
  Readings,
  type ReadingNow,
} from "@rufi/contracts/documents";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand/react";
import { ApiError, read, request } from "./api.ts";
import { printedTime } from "./dates.ts";
import { messageOf } from "./live.ts";
import { queries, saveSettings, useDocuments, useSettings } from "./reads.ts";
import { Button } from "./ui.tsx";

const documentsPath = (personId: string) =>
  `/api/people/${encodeURIComponent(personId)}/documents`;

/** The person's readings that wait or run, for the strip. */
const useReadings = (personId: string) =>
  useQuery({
    queryKey: ["readings", personId],
    queryFn: async () =>
      (
        await read(
          Readings,
          "GET",
          `/api/people/${encodeURIComponent(personId)}/readings`,
        )
      ).readings,
  });

/** Everything the screens show about a person's readings, read again. */
function readingsChanged(personId: string) {
  for (const key of ["readings", "documents", "reading"]) {
    void queries.invalidateQueries({ queryKey: [key, personId] });
  }
}

/**
 * Reads the person's documents not read yet: all of them (the card), or
 * one. `yes`: the person said yes just now.
 */
async function readIt(
  personId: string,
  documentId: string | undefined,
  yes: boolean,
) {
  await request(
    "POST",
    documentId === undefined
      ? `${documentsPath(personId)}/read`
      : `${documentsPath(personId)}/${encodeURIComponent(documentId)}/read`,
    { yes },
  );
  if (yes) void queries.invalidateQueries({ queryKey: ["settings"] });
  readingsChanged(personId);
}

/** Reads again what failed in a document's reading. */
async function retry(personId: string, documentId: string) {
  await request(
    "POST",
    `${documentsPath(personId)}/${encodeURIComponent(documentId)}/retry`,
  );
  readingsChanged(personId);
}

/** Which reading Open shows, over any screen. */
const useOpen = create<{ personId: string; documentId: string } | null>(
  () => null,
);

export const openReading = (personId: string, documentId: string) => {
  useOpen.setState({ personId, documentId }, true);
};

/** "1 min", counting up from `since`. */
function useElapsed(since: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      clearInterval(timer);
    };
  }, [since]);
  if (since === null) return "";
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  return minutes < 1 ? "under a minute" : `${String(minutes)} min`;
}

/** A reading that waits or runs, in words. */
function stateOf(reading: ReadingNow, elapsed: string): string {
  if (reading.state === "running") {
    return [
      ...(reading.again ? ["reading again"] : []),
      `saved ${String(reading.saved)} of ${String(reading.of)}`,
      elapsed,
    ].join(" · ");
  }
  switch (reading.waiting) {
    case "sign_in":
      return "waiting for sign-in";
    case "usage_limit":
      return reading.waitUntil
        ? `waiting until ${printedTime(reading.waitUntil)} (usage limit)`
        : "waiting for the usage limit";
    case "turned_off":
      return "waiting · reading is off in Settings";
    case null:
      return reading.again
        ? `waiting to read again · saved ${String(reading.saved)} of ${String(reading.of)}`
        : "waiting";
  }
}

/** Above the chat box: each reading that runs or waits, with Open. */
export function ReaderStrip({ personId }: { personId: string }) {
  const readings = useReadings(personId);
  const list = readings.data ?? [];
  if (list.length === 0) return null;
  return (
    <section
      aria-label="Reading documents"
      className="mx-3 border-b border-line pt-1.5 pb-2"
    >
      <ol className="flex flex-col gap-0.5">
        {list.map((reading) => (
          <StripRow
            key={reading.documentId}
            personId={personId}
            reading={reading}
          />
        ))}
      </ol>
    </section>
  );
}

function StripRow({
  personId,
  reading,
}: {
  personId: string;
  reading: ReadingNow;
}) {
  const elapsed = useElapsed(reading.runAt);
  const running = reading.state === "running";
  return (
    <li className="flex items-center gap-2 rounded-lg px-1.5 py-0.5 hover:bg-side">
      <span
        aria-hidden
        className={`size-3 shrink-0 rounded-full border-2 ${running ? "animate-spin border-line border-t-muted" : "border-dotted border-line"}`}
      />
      <span className="min-w-0 flex-1 truncate">{reading.name}</span>
      <span className="text-xs whitespace-nowrap text-muted">
        {stateOf(reading, elapsed)}
      </span>
      {(running || reading.saved > 0) && (
        <button
          type="button"
          className="rounded-md px-1 text-xs whitespace-nowrap text-accent-ink hover:bg-accent-soft"
          onClick={() => {
            openReading(personId, reading.documentId);
          }}
        >
          Open ▸
        </button>
      )}
    </li>
  );
}

/** The documents a yes would read: added and never read. */
const unread = (documents: readonly DocumentSummary[] | undefined) =>
  (documents ?? []).filter((d) => d.status === "not_read");

/** The words of the one-time question, for `count` documents named `name`. */
const QUESTION = {
  title: (count: number, name: string) =>
    count === 1
      ? `Read ${name} with the AI?`
      : `Read these ${String(count)} documents with the AI?`,
  body: "To read a document, Rufi sends its pages to the AI you signed in with (your ChatGPT plan). It asks once; you can change it in Settings.",
};

const nameOf = (document: DocumentSummary | undefined) =>
  document?.files[0]?.name ?? "this document";

/**
 * The one-time question, shown while documents wait for the person's
 * first answer. Read it says yes and reads them; Not now says no.
 */
export function ReadCard({ person }: { person: Person }) {
  const settings = useSettings();
  const documents = useDocuments(person.id);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = unread(documents.data);
  if (settings.data?.readDocuments !== null || waiting.length === 0) {
    return null;
  }
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Read documents with the AI"
      className="mx-3 mb-1.5 rounded-xl border border-line bg-side px-3 py-2.5"
    >
      <p className="font-semibold">
        {QUESTION.title(waiting.length, nameOf(waiting[0]))}
      </p>
      <p className="mt-1 text-xs text-muted">{QUESTION.body}</p>
      {problem && (
        <p role="alert" className="mt-1 text-muted">
          {problem}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          disabled={busy}
          onClick={() => void act(() => saveSettings({ readDocuments: "no" }))}
        >
          Not now
        </Button>
        <Button
          look="main"
          disabled={busy}
          onClick={() => void act(() => readIt(person.id, undefined, true))}
        >
          Read it
        </Button>
      </div>
    </section>
  );
}

const PANEL =
  "fixed top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 rounded-[14px] bg-surface shadow-menu outline-none";
const BACKDROP = "fixed inset-0 z-40 bg-ink/25";

/**
 * "Read it" for one document on the Documents page: at once after the yes,
 * otherwise the question first.
 */
export function ReadItButton({
  personId,
  document,
}: {
  personId: string;
  document: DocumentSummary;
}) {
  const settings = useSettings();
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async (yes: boolean) => {
    setProblem(null);
    try {
      await readIt(personId, document.id, yes);
      setAsking(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const body = error.body as { needsYes?: unknown } | undefined;
        if (body?.needsYes === true) {
          setAsking(true);
          return;
        }
      }
      setProblem(messageOf(error));
    }
  };
  return (
    <>
      <TextButton
        onClick={() => {
          if (settings.data?.readDocuments === "yes") void go(false);
          else setAsking(true);
        }}
      >
        Read it
      </TextButton>
      {problem && (
        <span role="alert" className="block text-xs text-muted">
          {problem}
        </span>
      )}
      {asking && (
        <Dialog.Root
          open
          onOpenChange={(next) => {
            if (!next) setAsking(false);
          }}
        >
          <Dialog.Portal>
            <Dialog.Backdrop className={BACKDROP} />
            <Dialog.Popup
              className={`${PANEL} w-[420px] max-w-[92vw] p-[18px]`}
            >
              <Dialog.Title className="text-[15px] font-semibold">
                {QUESTION.title(1, nameOf(document))}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-muted">
                {QUESTION.body}
              </Dialog.Description>
              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close render={<Button />}>Not now</Dialog.Close>
                <Button look="main" onClick={() => void go(true)}>
                  Read it
                </Button>
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}

/** Retry for a document whose reading failed, or has pages that did. */
export function RetryButton({
  personId,
  documentId,
}: {
  personId: string;
  documentId: string;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <TextButton
        onClick={() => {
          setProblem(null);
          retry(personId, documentId).catch((error: unknown) => {
            setProblem(messageOf(error));
          });
        }}
      >
        Retry
      </TextButton>
      {problem && (
        <span role="alert" className="block text-xs text-muted">
          {problem}
        </span>
      )}
    </>
  );
}

export function TextButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-1 text-accent-ink hover:bg-accent-soft"
    >
      {children}
    </button>
  );
}

const OUTCOME = {
  read: "read",
  nothing_here: "nothing here",
  unreadable: "couldn't be read",
  not_looked_at: "not looked at",
} as const;

/** Open: one reading's work, read only, as it goes and after it ended. */
export function ReadingSheet() {
  const open = useOpen();
  if (!open) return null;
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) useOpen.setState(null, true);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP} />
        <Dialog.Popup
          className={`${PANEL} flex h-[80vh] w-[560px] max-w-[94vw] flex-col overflow-hidden`}
        >
          <Sheet personId={open.personId} documentId={open.documentId} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Sheet({
  personId,
  documentId,
}: {
  personId: string;
  documentId: string;
}) {
  const view = useQuery({
    queryKey: ["reading", personId, documentId],
    queryFn: () =>
      read(
        ReadingView,
        "GET",
        `${documentsPath(personId)}/${encodeURIComponent(documentId)}/reading`,
      ),
  });
  const reading = view.data;
  const elapsed = useElapsed(reading?.runAt ?? null);
  const status =
    reading === undefined
      ? ""
      : reading.status === "reading"
        ? [
            "reading",
            `saved ${String(reading.saved)} of ${String(reading.of)}`,
            ...(elapsed ? [elapsed] : []),
          ].join(" · ")
        : reading.status === "failed"
          ? `failed · ${reading.error ?? "it stopped"} · saved ${String(reading.saved)} of ${String(reading.of)}`
          : reading.status === "done"
            ? "read"
            : "not read yet";
  const canRetry =
    reading !== undefined &&
    (reading.status === "failed" ||
      (reading.status === "done" &&
        reading.pages.some(
          (p) => p.state === "unreadable" || p.state === "not_looked_at",
        )));
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
        <Dialog.Title className="min-w-0 flex-1 truncate">
          <b className="text-[14px]">{reading?.name ?? "Reading"}</b>{" "}
          <span className="text-muted">· {status}</span>
        </Dialog.Title>
        {canRetry && (
          <RetryButton personId={personId} documentId={documentId} />
        )}
        <Dialog.Close render={<Button look="quiet" aria-label="Close" />}>
          <X size={15} aria-hidden />
        </Dialog.Close>
      </div>
      <div
        tabIndex={0}
        role="group"
        aria-label="The reader's work"
        className="flex flex-1 flex-col gap-4 overflow-auto px-4 py-3"
      >
        {view.error && (
          <p role="alert" className="text-muted">
            {view.error.message}
          </p>
        )}
        {reading && (
          <>
            <p className="text-xs text-muted">
              What the reader read, not saved: these become your record only
              when you save them in the chat.
            </p>
            {reading.note && (
              <div>
                <h3 className="mb-1 text-xs font-semibold text-muted">
                  The reader's note
                </h3>
                <p className="rounded-lg bg-side px-2.5 py-1.5">
                  {reading.note}
                </p>
              </div>
            )}
            <div>
              <h3 className="mb-1 text-xs font-semibold text-muted">Pages</h3>
              <div className="flex flex-col gap-2">
                {reading.pages.map((page) => (
                  <PageWork
                    key={page.position}
                    page={page}
                    first={page.position === reading.pages[0]?.position}
                  />
                ))}
              </div>
            </div>
            {reading.usage && (
              <div>
                <h3 className="mb-1 text-xs font-semibold text-muted">
                  AI usage
                </h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px]">
                  <dt className="text-muted">Model</dt>
                  <dd>
                    {reading.model ?? "—"}
                    {reading.effort ? ` · ${reading.effort} effort` : ""}
                  </dd>
                  <dt className="text-muted">Pages looked at</dt>
                  <dd>{reading.usage.looks}</dd>
                  <dt className="text-muted">Tokens</dt>
                  <dd>
                    {reading.usage.totalTokens.toLocaleString("en")} (
                    {reading.usage.cachedInputTokens.toLocaleString("en")}{" "}
                    cached)
                  </dd>
                </dl>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function PageWork({
  page,
  first,
}: {
  page: ReadingView["pages"][number];
  first: boolean;
}) {
  const { entry, checks } = page;
  const outcome = page.state
    ? OUTCOME[page.state]
    : entry
      ? `${OUTCOME[entry.outcome]} so far`
      : "not saved yet";
  const facts = entry?.facts;
  const summary = [
    outcome,
    ...(entry?.outcome === "read"
      ? [
          entry.items.length === 1
            ? "1 item"
            : `${String(entry.items.length)} items`,
        ]
      : []),
    ...(facts?.issuer ? [facts.issuer] : []),
    ...(facts?.dates?.[0]
      ? [`${facts.dates[0].label} ${facts.dates[0].date}`]
      : []),
  ].join(" · ");
  const flagged = (index: number) =>
    checks?.items.find((c) => c.item === index + 1)?.why;
  return (
    <details
      open={first && entry !== null}
      className="rounded-[10px] border border-line"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5">
        <b>Page {page.position}</b>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {summary}
        </span>
        {checks?.incomplete && <Tag>may be incomplete</Tag>}
      </summary>
      {entry && <EntryTable entry={entry} flagged={flagged} />}
      {checks?.incomplete && (
        <p className="border-t border-line px-2.5 py-1 text-xs text-muted">
          The reader counted {checks.incomplete.rows_seen} rows and saved{" "}
          {checks.incomplete.items}.
        </p>
      )}
      {(page.why ?? entry?.why) && (
        <p className="border-t border-line px-2.5 py-1 text-xs text-muted">
          {page.why ?? entry?.why}
        </p>
      )}
      {entry?.issues?.map((issue) => (
        <p
          key={issue}
          className="border-t border-line px-2.5 py-1 text-xs text-muted"
        >
          The reader noted: {issue}
        </p>
      ))}
    </details>
  );
}

function EntryTable({
  entry,
  flagged,
}: {
  entry: ReadEntry;
  flagged: (index: number) => string | undefined;
}) {
  if (entry.items.length === 0) return null;
  return (
    <table className="w-full border-collapse text-[12.5px]">
      <thead>
        <tr className="text-left text-muted">
          <th className="border-t border-line px-2.5 py-1 font-medium">Test</th>
          <th className="border-t border-line px-2.5 py-1 font-medium">
            Value
          </th>
          <th className="border-t border-line px-2.5 py-1 font-medium">
            Range
          </th>
          <th className="border-t border-line px-2.5 py-1 font-medium">
            <span className="sr-only">Marks</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {entry.items.map((item, index) => {
          const why = [item.unsure, flagged(index)].filter(Boolean).join("; ");
          return (
            <tr
              key={`${item.test_name}-${String(index)}`}
              className="align-top"
            >
              <td className="border-t border-line px-2.5 py-1">
                {item.test_name}
                {item.column === "earlier" && (
                  <span className="text-muted"> (earlier)</span>
                )}
                {why && <span className="block text-xs text-muted">{why}</span>}
              </td>
              <td className="border-t border-line px-2.5 py-1">
                {item.value_text}
                {item.unit ? ` ${item.unit}` : ""}
              </td>
              <td className="border-t border-line px-2.5 py-1">
                {item.reference_range ?? ""}
              </td>
              <td className="border-t border-line px-2.5 py-1 text-right whitespace-nowrap">
                {item.flag_text && <Tag>{item.flag_text}</Tag>}
                {why && <Tag>unsure</Tag>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Tag({ children }: { children: string }) {
  return (
    <span className="ml-1 rounded-full border border-line px-1.5 text-[11px] whitespace-nowrap text-muted">
      {children}
    </span>
  );
}
