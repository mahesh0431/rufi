// Reading documents on the screens: Retry through the chat, and View reading: a reading's work as the reader saved it (each
// page's copy, or an older reader's items), read
// only. Rufi's live stream says when readings change; the Documents page
// also looks again while one reads.
import { Dialog } from "@base-ui/react/dialog";
import {
  type DocumentItems,
  type DraftItem,
  type Fixable,
  ReadingView,
} from "@rufi/contracts/documents";
import { useQuery } from "@tanstack/react-query";
import { RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand/react";
import { read } from "./api.ts";
import { useNavigate } from "@tanstack/react-router";
import { showChat } from "./attach.tsx";
import { askRufi } from "./panel.ts";
import { useDocuments, useDocumentItems } from "./reads.ts";
import { Button, IconButton, Problem } from "./ui.tsx";

const documentsPath = (personId: string) =>
  `/api/people/${encodeURIComponent(personId)}/documents`;

/**
 * What a document's page and its reading say once nothing waits, from its
 * items' states: whether any was saved, or every one set aside. Null while
 * an item waits, or before the reading found any. In the past tense, so an
 * undo later keeps it true.
 */
export function settledLine(items: DocumentItems): string | null {
  const states = items.items.map((i) => i.status);
  if (states.length === 0 || states.includes("pending")) return null;
  return states.includes("saved")
    ? "These results were saved to your health record."
    : "Nothing from this document was saved to your health record.";
}

/** The fields a fix can change, in the form's order. */
export const FIELDS: readonly { id: Fixable; name: string; wide?: boolean }[] =
  [
    { id: "test_name", name: "Test", wide: true },
    { id: "value_text", name: "Value" },
    { id: "unit", name: "Unit" },
    { id: "reference_range", name: "Range", wide: true },
    { id: "flag_text", name: "Flag" },
    { id: "context_text", name: "Context" },
  ];

/** The item's fields the person changed: each with the reader's value. */
export const fixesOf = (item: DraftItem) =>
  FIELDS.filter(({ id }) => item.fields[id] !== item.original[id]);

/** Under a fixed item's name: what the reader read in each field fixed. */
export function ReaderRead({ item }: { item: DraftItem }) {
  const fixes = fixesOf(item);
  if (fixes.length === 0) return null;
  return (
    <span className="block text-xs text-muted">
      {item.quote === null ? "The reader read" : "Drafted"}:{" "}
      {fixes
        .map(
          ({ id, name }) =>
            `${name.toLowerCase()} ${item.original[id] ?? "(empty)"}`,
        )
        .join(" · ")}
    </span>
  );
}

/** Which reading View reading shows, over any screen. */
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

const PANEL =
  "fixed top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 rounded-[14px] bg-surface shadow-menu outline-none";
const BACKDROP = "fixed inset-0 z-40 bg-ink/25";

/** Retry for a document whose reading failed, or has pages that did. */
export function RetryButton({
  personId,
  documentId,
}: {
  personId: string;
  documentId: string;
}) {
  const navigate = useNavigate();
  return (
    <>
      <Button
        look="quiet"
        icon={RotateCw}
        onClick={() => {
          if (
            askRufi(personId, [
              {
                pointer: { type: "document", id: documentId, readAgain: true },
                label: "",
                detail: "",
              },
            ])
          ) {
            useOpen.setState(null, true);
            showChat(personId, navigate);
          }
        }}
      >
        Retry
      </Button>
    </>
  );
}

const OUTCOME = {
  read: "read",
  nothing_here: "nothing here",
  unreadable: "couldn't be read",
  not_looked_at: "not looked at",
} as const;

/** View reading: one reading's work, read only, as it goes and after it ended. */
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
    // Closed, its work is let go: opened again, it never shows an earlier run.
    gcTime: 0,
  });
  const reading = view.data;
  const items = useDocumentItems(personId, documentId);
  const document = useDocuments(personId).data?.find(
    (d) => d.id === documentId,
  );
  const elapsed = useElapsed(reading?.runAt ?? null);
  const status =
    // Its reader at work: it saves its pages at once.
    document?.status === "reading" && document.reader !== null
      ? "reading"
      : reading === undefined
        ? document?.status === "reading" &&
          document.reading &&
          `reading · read ${String(document.reading.saved)} of ${String(document.reading.of)}`
        : reading.status === "reading"
          ? [
              "reading",
              `read ${String(reading.saved)} of ${String(reading.of)}`,
              ...(elapsed ? [elapsed] : []),
            ].join(" · ")
          : reading.status === "failed"
            ? `failed · read ${String(reading.saved)} of ${String(reading.of)}`
            : reading.status === "done"
              ? "read"
              : "not read yet";
  const canRetry =
    reading !== undefined &&
    document?.status !== "reading" &&
    (reading.status === "failed" ||
      (reading.status === "done" &&
        reading.pages.some(
          (p) => p.state === "unreadable" || p.state === "not_looked_at",
        )));
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
        <Dialog.Title className="min-w-0 flex-1 truncate">
          <b className="text-[14px]">
            {reading?.name ?? document?.files[0]?.name ?? "Reading"}
          </b>
          {status && <span className="text-muted"> · {status}</span>}
        </Dialog.Title>
        {canRetry && (
          <RetryButton personId={personId} documentId={documentId} />
        )}
        <Dialog.Close render={<IconButton label="Close" icon={X} />} />
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
        {/* Why it failed, in full: it can be long (a sign-in to renew). */}
        {reading?.status === "failed" && <p>{reading.error ?? "it stopped"}</p>}
        {items.error && (
          <Problem error={items.error} retry={() => void items.refetch()} />
        )}
        {reading && (
          <>
            {items.data && !items.error && (
              <p className="text-xs text-muted">
                {settledLine(items.data) ??
                  "What the reader read, not saved: these become part of your health record only when you save them in the chat."}
              </p>
            )}
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
                    personId={personId}
                    documentId={documentId}
                    reading={document?.status === "reading"}
                    drafts={
                      items.isSuccess
                        ? items.data.items.filter(
                            (i) => i.page === page.position,
                          )
                        : undefined
                    }
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
  personId,
  documentId,
  page,
  drafts,
  reading,
}: {
  personId: string;
  documentId: string;
  page: ReadingView["pages"][number];
  /** The page's draft items, once the reading made them. */
  drafts: readonly DraftItem[] | undefined;
  /** A reader is at work on the document: no Retry meanwhile. */
  reading: boolean;
}) {
  const { entry, checks } = page;
  const outcome = page.state
    ? OUTCOME[page.state]
    : entry
      ? `${OUTCOME[entry.outcome]} so far`
      : "not read yet";
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
  // A copied page shows the reader's copy as it wrote it, marks and all
  // (Rufi AI's drafts from it are on the document's page). An older
  // reader's page shows its own items, with the person's fix, once they
  // came; a page still being read shows what the reader saved.
  const rows: readonly Row[] =
    page.copy !== null
      ? []
      : page.state === "read"
        ? (drafts ?? []).map((draft) => ({
            key: draft.id,
            item: draft.fields,
            why: draft.unsure.join("; "),
            ...(fixesOf(draft).length > 0 && { fixed: draft }),
          }))
        : (entry?.items.map((read, index) => ({
            key: String(index),
            item: read,
            why: [
              read.unsure,
              checks?.items.find((c) => c.item === index + 1)?.why,
            ]
              .filter(Boolean)
              .join("; "),
          })) ?? []);
  return (
    <section className="rounded-[10px] border border-line">
      <h4 className="flex items-center gap-2 px-2.5 py-1.5 font-normal">
        <b>Page {page.position}</b>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {summary}
        </span>
        {checks?.incomplete && <Tag>may be incomplete</Tag>}
        {!reading &&
          (page.state === "unreadable" || page.state === "not_looked_at") && (
            <RetryButton personId={personId} documentId={documentId} />
          )}
      </h4>
      {rows.length > 0 && <ItemTable rows={rows} />}
      {page.copy !== null && (
        <pre className="border-t border-line px-2.5 py-1.5 font-sans text-[12.5px] wrap-anywhere whitespace-pre-wrap">
          {page.copy}
        </pre>
      )}
      {checks?.incomplete && (
        <p className="border-t border-line px-2.5 py-1 text-xs text-muted">
          The reader counted {checks.incomplete.rows_seen} rows and read{" "}
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
    </section>
  );
}

/** A row of a page: the item's fields now, why it may be wrong, and the item fixed. */
type Row = {
  key: string;
  item: DraftItem["fields"];
  why: string;
  fixed?: DraftItem;
};

/**
 * A page's items; an item the person fixed shows their fix, with the
 * reader's value under its name, as the document's page does.
 */
function ItemTable({ rows }: { rows: readonly Row[] }) {
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
        {rows.map(({ key, item, why, fixed }) => (
          <tr key={key} className="align-top">
            <td className="border-t border-line px-2.5 py-1">
              {item.test_name}
              {item.column === "earlier" && (
                <span className="text-muted"> (earlier)</span>
              )}
              {why && <span className="block text-xs text-muted">{why}</span>}
              {fixed && <ReaderRead item={fixed} />}
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
              {fixed && <Tag strong>fixed by you</Tag>}
              {why && <Tag>unsure</Tag>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Tag({
  children,
  strong,
}: {
  children: string;
  strong?: boolean;
}) {
  return (
    <span
      className={`ml-1 rounded-full border px-1.5 text-[11px] whitespace-nowrap ${strong ? "border-transparent bg-accent-soft text-accent-ink" : "border-line text-muted"}`}
    >
      {children}
    </span>
  );
}
