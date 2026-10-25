// A document's page: its draft items (Rufi AI's, from the reader's copies,
// or an older reader's), beside the page they came from, each with the
// words it came from and why it is worth a look. A click on a row shows its
// page; "Worth a look only" keeps the items with a reason. A fix changes an
// item's printed fields and keeps the drafted ones; it names the item's
// version, so a fix made on an older one (another tab fixed it first) is
// refused with the value as it is now. A draft whose page was read again
// since is out of date: shown so, and never saved.
// Nothing here saves to the record: "Save in chat" puts the words
// in the chat box, and the person sends them; once nothing waits, the page
// says what was saved and set aside, and has no Save in chat. An item goes
// into the chat as a chip too: Ask Rufi on its row. The page stays, to read
// beside what you write.
import {
  DocumentItems,
  DraftItem,
  type DocumentSummary,
  type Fixable,
} from "@rufi/contracts/documents";
import type { Person } from "@rufi/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Schema } from "effect";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  MessageCircle,
  Pencil,
  ScanText,
  X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useStore } from "zustand";
import { ApiError, fetchFile, read } from "./api.ts";
import { AskRufi, ASKS } from "./ask.tsx";
import { boxFor } from "./boxes.ts";
import { printedDate, printedDay } from "./dates.ts";
import { DeleteDocument } from "./delete-document.tsx";
import { describe, KIND_NAMES, placeWords, Viewer } from "./documents.tsx";
import type { BoxChip } from "./draft.ts";
import { messageOf, retain } from "./live.ts";
import { askRufi } from "./panel.ts";
import { queries, useDocumentItems, useDocuments } from "./reads.ts";
import {
  FIELDS,
  fixesOf,
  openReading,
  ReaderRead,
  RetryButton,
  settledLine,
  Tag,
} from "./reading.tsx";
import { Button, IconButton, Problem } from "./ui.tsx";

const documentPath = (personId: string, documentId: string) =>
  `/api/people/${encodeURIComponent(personId)}/documents/${encodeURIComponent(documentId)}`;

const PAGE_STATE = {
  read: "read",
  nothing_here: "nothing here",
  unreadable: "couldn't be read",
  not_looked_at: "not looked at",
} as const;

type Item = DraftItem;
type Page = DocumentItems["pages"][number];

const plural = (count: number, one: string, many = `${one}s`) =>
  `${String(count)} ${count === 1 ? one : many}`;

export function DocumentPage({
  person,
  documentId,
}: {
  person: Person;
  documentId: string;
}) {
  // The chat's stream: a fix in another tab shows here at once.
  useEffect(() => retain(person.id), [person.id]);
  const documents = useDocuments(person.id);
  const items = useDocumentItems(person.id, documentId);
  const document = documents.data?.find((d) => d.id === documentId);
  // The list says it isn't there: its items' refusal is no problem to try
  // again.
  if (documents.data !== undefined && !document) {
    return <Gone personId={person.id} documentId={documentId} />;
  }
  if (documents.error ?? items.error) {
    return (
      <div className="px-6 py-8">
        <Problem
          error={(documents.error ?? items.error) as Error}
          retry={() => {
            void documents.refetch();
            void items.refetch();
          }}
        />
      </div>
    );
  }
  if (!document || items.data === undefined) return null;
  return <Checking person={person} document={document} items={items.data} />;
}

/** A document not in the list: deleted, or never added. */
function Gone({
  personId,
  documentId,
}: {
  personId: string;
  documentId: string;
}) {
  // Asked again here: a page open when the delete came has its items.
  const asked = useQuery({
    queryKey: ["gone", personId, documentId],
    queryFn: () =>
      read(DocumentItems, "GET", `${documentPath(personId, documentId)}/items`),
    gcTime: 0,
  });
  if (asked.isPending) return null;
  const deleted =
    asked.error instanceof ApiError &&
    (asked.error.body as { deleted?: unknown } | undefined)?.deleted === true;
  return (
    <div className="px-6 py-8 text-muted">
      {deleted
        ? "This document was deleted."
        : "There is no such document. It may have been deleted."}
    </div>
  );
}

function Checking({
  person,
  document,
  items,
}: {
  person: Person;
  document: DocumentSummary;
  items: DocumentItems;
}) {
  const [lookOnly, setLookOnly] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [fixing, setFixing] = useState<string | undefined>(undefined);
  const [shown, setShown] = useState(items.items[0]?.page ?? 1);
  const [original, setOriginal] = useState(false);
  const { name } = describe(document);
  // A draft whose page was read again since can't be saved: it isn't counted.
  const pending = items.items.filter(
    (i) => i.status === "pending" && !i.outOfDate,
  );
  // Results are current values only, as the Documents page and the chat's
  // line count them; an earlier column's values stay rows of their own.
  const results = pending.filter((i) => i.fields.column !== "earlier");
  const earlier = pending.length - results.length;
  const look = results.filter((i) => i.unsure.length > 0);
  const fixed = pending.filter((i) => fixesOf(i).length > 0);
  /** A page's items, also those the filter hides. */
  const count = (position: number) =>
    items.items.filter((i) => i.page === position).length;
  const marked = items.items.filter((i) => i.unsure.length > 0);
  const listed = lookOnly ? marked : items.items;
  const left = [
    plural(results.length, "result"),
    ...(earlier > 0 ? [`${String(earlier)} earlier`] : []),
  ].join(" · ");
  const settled = settledLine(items);
  const saved = items.items.filter((i) => i.status === "saved").length;
  const setAside = items.items.filter((i) => i.status === "dismissed").length;
  const about = [
    ...(document.kind ? [KIND_NAMES[document.kind]] : []),
    document.place
      ? placeWords(document.place)
      : plural(items.pages.length, "page"),
    ...(document.lab ? [document.lab] : []),
    ...(document.date ? [printedDate(document.date)] : []),
    `added ${printedDay(document.addedAt)}`,
  ].join(" · ");

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div className="flex flex-wrap items-center gap-2.5 px-5 pt-3.5 pb-2.5">
        {/* The name and its lines keep room to read; in a small window the
            actions go below them. */}
        <div className="min-w-0 flex-1 basis-80">
          <h2 className="truncate">
            <b className="text-[14px]">{name}</b>{" "}
            <span className="text-muted">· {about}</span>
          </h2>
          {document.status === "failed" && (
            // Wrapped, its last word doesn't end on a line of its own.
            <p className="text-xs text-pretty">
              Failed · {document.reading?.error ?? "it stopped"}
            </p>
          )}
          {document.notSorted && (
            <p className="text-xs text-pretty">Not sorted yet</p>
          )}
          <p className="text-xs text-muted">
            {settled ??
              "What the reader read, not saved. These become part of your health record only when you save them in the chat."}
          </p>
          {items.savedAs.length > 0 && (
            <p className="text-xs">
              <span className="text-muted">Saved as</span>
              {items.savedAs.map((visit) => (
                <Link
                  key={visit.id}
                  to="/people/$personId/visits/$visitId"
                  params={{ personId: person.id, visitId: visit.id }}
                  className="ml-2 rounded-md text-accent-ink hover:bg-accent-soft"
                >
                  Visit · {visit.label}
                </Link>
              ))}
            </p>
          )}
        </div>
        {(document.status === "not_read" ||
          document.reading?.canRetry === true) && (
          <RetryButton personId={person.id} documentId={document.id} />
        )}
        <Button
          icon={FileText}
          onClick={() => {
            setOriginal(true);
          }}
        >
          View original
        </Button>
        {document.status !== "not_read" && (
          <Button
            icon={ScanText}
            onClick={() => {
              openReading(person.id, document.id);
            }}
          >
            View reading
          </Button>
        )}
        <DeleteDocument
          personId={person.id}
          documentId={document.id}
          name={name}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pb-3.5 md:flex-row">
        <section
          aria-label="Items"
          className="flex min-h-0 min-w-0 flex-[1.15] flex-col overflow-hidden rounded-xl border border-line bg-surface"
        >
          <div className="flex items-center gap-2.5 border-b border-line px-3 py-2">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={lookOnly}
                onChange={(event) => {
                  setLookOnly(event.target.checked);
                }}
                className="accent-accent"
              />
              Worth a look only ({marked.length})
            </label>
            <span className="flex-1" />
            <span className="text-xs text-muted">
              {(settled !== null
                ? [
                    ...(saved > 0 ? [`${String(saved)} saved`] : []),
                    ...(setAside > 0 ? [`${String(setAside)} set aside`] : []),
                  ]
                : [
                    left,
                    `${String(look.length)} worth a look`,
                    ...(fixed.length > 0
                      ? [`${String(fixed.length)} fixed by you`]
                      : []),
                  ]
              ).join(" · ")}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <Items
              personId={person.id}
              documentId={document.id}
              status={document.status}
              pages={items.pages}
              items={listed}
              lookOnly={lookOnly}
              count={count}
              selected={selected}
              fixing={fixing}
              select={(item) => {
                setSelected(item.id);
                setShown(item.page);
              }}
              fix={setFixing}
              add={(item) => {
                askRufi(person.id, [chipOf(item)]);
              }}
            />
          </div>
        </section>
        <PageView
          personId={person.id}
          documentId={document.id}
          position={shown}
          pages={items.pages}
          place={document.place}
          show={setShown}
          count={count}
        />
      </div>

      <div className="flex items-center gap-2.5 border-t border-line bg-surface px-5 py-2.5">
        <span className="text-muted">
          {pending.length === 0
            ? "Nothing here waits to be saved."
            : `Not saved yet: ${left}.`}
        </span>
        <span className="flex-1" />
        {pending.length > 0 && (
          <SaveInChat
            personId={person.id}
            document={document}
            name={name}
            count={results.length}
          />
        )}
      </div>

      {original && (
        <Viewer
          person={person.id}
          document={document}
          close={() => {
            setOriginal(false);
          }}
        />
      )}
    </div>
  );
}

/** A draft item as a chip: what its row shows. */
const chipOf = (item: Item): BoxChip => ({
  pointer: { type: "draft_item", id: item.id },
  label: [item.fields.test_name, item.fields.value_text, item.fields.unit]
    .filter(Boolean)
    .join(" "),
  detail: "",
});

function Items({
  personId,
  documentId,
  status,
  pages,
  items,
  lookOnly,
  count,
  selected,
  fixing,
  select,
  fix,
  add,
}: {
  personId: string;
  documentId: string;
  status: DocumentSummary["status"];
  pages: readonly Page[];
  items: readonly Item[];
  lookOnly: boolean;
  /** A page's items, also those the filter hides. */
  count: (position: number) => number;
  selected: string | undefined;
  fixing: string | undefined;
  select: (item: Item) => void;
  fix: (id: string | undefined) => void;
  add: (item: Item) => void;
}) {
  if (status === "not_read" || status === "reading") {
    return (
      <p className="px-3 py-4 text-muted">
        {status === "reading"
          ? "The reader is reading this document. Its items show here when it's done."
          : "This document isn't read yet."}
      </p>
    );
  }
  const shownPages = pages.filter(
    (page) => !lookOnly || items.some((i) => i.page === page.position),
  );
  if (shownPages.length === 0) {
    return (
      <p className="px-3 py-4 text-muted">
        {lookOnly ? "Nothing is worth a look." : "No items were read."}
      </p>
    );
  }
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="text-left text-xs text-muted">
          <th className="sticky top-0 bg-surface px-2.5 py-1.5 font-normal">
            Test
          </th>
          <th className="sticky top-0 bg-surface px-2.5 py-1.5 font-normal">
            Value
          </th>
          <th className="sticky top-0 bg-surface px-2.5 py-1.5 font-normal">
            Range
          </th>
          <th className="sticky top-0 bg-surface px-2.5 py-1.5 font-normal">
            <span className="sr-only">Marks</span>
          </th>
        </tr>
      </thead>
      {shownPages.map((page) => {
        const mine = items.filter((i) => i.page === page.position);
        return (
          <tbody key={page.position}>
            <tr>
              <td
                colSpan={4}
                className="border-t border-line bg-side px-2.5 py-1 text-xs text-muted"
              >
                <b className="font-semibold text-ink">Page {page.position}</b>
                {" · "}
                {pageWords(page, count(page.position))}
                {page.state === "not_looked_at" ||
                page.state === "unreadable" ? (
                  <>
                    {" "}
                    <RetryButton personId={personId} documentId={documentId} />
                  </>
                ) : null}
              </td>
            </tr>
            {mine.map((item) => (
              <Row
                key={item.id}
                personId={personId}
                documentId={documentId}
                item={item}
                selected={item.id === selected}
                fixing={item.id === fixing}
                select={() => {
                  select(item);
                }}
                fix={fix}
                add={() => {
                  add(item);
                }}
              />
            ))}
          </tbody>
        );
      })}
    </table>
  );
}

/** A page's state in words, as its heading says it. */
function pageWords(page: Page, items: number): string {
  const words =
    page.state === null
      ? "not read yet"
      : page.state === "read"
        ? `read · ${plural(items, "item")}`
        : page.state === "unreadable" && page.why
          ? `couldn't be read: ${page.why}`
          : PAGE_STATE[page.state];
  return page.incomplete
    ? `${words} · may be incomplete: the reader counted ${plural(page.incomplete.rows_seen, "row")} and read ${String(page.incomplete.items)}`
    : words;
}

function Row({
  personId,
  documentId,
  item,
  selected,
  fixing,
  select,
  fix,
  add,
}: {
  personId: string;
  documentId: string;
  item: Item;
  selected: boolean;
  fixing: boolean;
  select: () => void;
  fix: (id: string | undefined) => void;
  add: () => void;
}) {
  const { fields } = item;
  const fixes = fixesOf(item);
  const done = item.status !== "pending";
  const cell = "border-t border-line px-2.5 py-1.5 align-top";
  return (
    <>
      <tr
        onClick={select}
        className={`group cursor-pointer ${selected ? "bg-accent-soft" : "hover:bg-page"} ${done ? "text-muted" : ""}`}
      >
        <td className={cell}>
          <button
            type="button"
            aria-pressed={selected}
            className="text-left"
            onClick={(event) => {
              event.stopPropagation();
              select();
            }}
          >
            {fields.test_name}
          </button>
          {fields.context_text && (
            <span className="text-muted"> · {fields.context_text}</span>
          )}
          {item.outOfDate && (
            <span className="block text-xs text-ink">
              Out of date: this page was read again
            </span>
          )}
          {!item.outOfDate &&
            item.unsure.map((why) => (
              <span key={why} className="block text-xs text-muted">
                Worth a look: {why}
              </span>
            ))}
          {!item.outOfDate && item.quote !== null && (
            <span className="block text-xs text-muted">
              From the page: “{item.quote}”
            </span>
          )}
          <ReaderRead item={item} />
        </td>
        <td className={`${cell} whitespace-nowrap`}>
          {fields.value_text}
          {fields.unit ? ` ${fields.unit}` : ""}
        </td>
        <td className={`${cell} whitespace-nowrap`}>
          {fields.reference_range ?? ""}
        </td>
        <td className={`${cell} text-right whitespace-nowrap`}>
          {fields.flag_text && <Tag>{fields.flag_text}</Tag>}
          {fields.column === "earlier" && <Tag>earlier</Tag>}
          {fixes.length > 0 && <Tag strong>fixed by you</Tag>}
          {done && <Tag>{item.status === "saved" ? "saved" : "set aside"}</Tag>}
          {selected && !done && !fixing && !item.outOfDate && (
            <Button
              look="quiet"
              icon={Pencil}
              onClick={() => {
                fix(item.id);
              }}
            >
              Fix
            </Button>
          )}
          {!done && (
            <AskRufi
              onClick={(event) => {
                event.stopPropagation();
                add();
              }}
            />
          )}
        </td>
      </tr>
      {fixing && (
        <tr>
          <td colSpan={4} className="bg-accent-soft px-2.5 pt-1 pb-2.5">
            <FixForm
              personId={personId}
              documentId={documentId}
              item={item}
              close={() => {
                fix(undefined);
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The fix of one item, made on the version it opened with. Refused because
 * another tab fixed it first: the form says so with the value now, keeps
 * the person's edits, and takes untouched fields from the new version.
 * A second Save sends only those edits on that version.
 */
function FixForm({
  personId,
  documentId,
  item,
  close,
}: {
  personId: string;
  documentId: string;
  item: Item;
  close: () => void;
}) {
  /** The item as this fix was made on: as opened, or as a refusal showed it. */
  const [base, setBase] = useState(item);
  const [values, setValues] = useState<Record<Fixable, string>>(
    () =>
      Object.fromEntries(
        FIELDS.map(({ id }) => [id, item.fields[id] ?? ""]),
      ) as Record<Fixable, string>,
  );
  const [refused, setRefused] = useState<Item | undefined>(undefined);
  const changed = FIELDS.filter(
    ({ id }) => values[id].trim() !== (base.fields[id] ?? ""),
  );
  const save = useMutation({
    mutationFn: () =>
      read(
        DraftItem,
        "POST",
        `${documentPath(personId, documentId)}/items/${encodeURIComponent(item.id)}/fix`,
        {
          version: base.version,
          fields: Object.fromEntries(changed.map(({ id }) => [id, values[id]])),
        },
      ),
    onSuccess: () => {
      close();
    },
    onError: (error) => {
      const current =
        error instanceof ApiError && error.status === 409
          ? Schema.decodeUnknownOption(Schema.Struct({ current: DraftItem }))(
              error.body,
            )
          : undefined;
      if (current?._tag === "Some") {
        const latest = current.value.current;
        setValues((previous) => {
          const next = { ...previous };
          for (const { id } of FIELDS) {
            if (previous[id].trim() === (base.fields[id] ?? "")) {
              next[id] = latest.fields[id] ?? "";
            }
          }
          return next;
        });
        setRefused(latest);
        setBase(latest);
      } else {
        setRefused(undefined);
      }
    },
    onSettled: () =>
      queries.invalidateQueries({ queryKey: ["items", personId, documentId] }),
  });
  const problem = save.error && !refused ? messageOf(save.error) : undefined;
  return (
    <form
      aria-label={`Fix ${item.fields.test_name}`}
      className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 rounded-[10px] border border-line bg-surface p-2.5 sm:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed.length > 0) save.mutate();
      }}
    >
      {FIELDS.map(({ id, name, wide }) => (
        <label
          key={id}
          className={`flex flex-col gap-0.5 text-xs text-muted ${wide ? "col-span-2" : ""}`}
        >
          {name}
          <input
            value={values[id]}
            onChange={(event) => {
              setValues({ ...values, [id]: event.target.value });
            }}
            className={`rounded-md border bg-surface px-1.5 py-1 text-[13px] text-ink ${changed.some((c) => c.id === id) ? "border-accent" : "border-line"}`}
          />
        </label>
      ))}
      {refused && (
        <p
          role="alert"
          className="col-span-full rounded-lg bg-side px-2.5 py-1.5 text-ink"
        >
          <b>This result changed in another tab.</b> Its value is now{" "}
          <b>
            {refused.fields.value_text}
            {refused.fields.unit ? ` ${refused.fields.unit}` : ""}
          </b>
          . Your fix wasn't saved. Look at the page, then save your fix again or
          cancel.
        </p>
      )}
      {problem && (
        <p role="alert" className="col-span-full text-muted">
          {problem}
        </p>
      )}
      <div className="col-span-full flex items-center gap-2">
        <span className="flex-1 text-xs text-muted">
          {item.quote === null ? "The reader read" : "Drafted as"}{" "}
          <b>{item.original.value_text}</b>
          {item.original.unit ? ` ${item.original.unit}` : ""}. Rufi keeps it
          beside your fix.
        </span>
        <Button icon={X} onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          look="main"
          icon={Check}
          disabled={changed.length === 0}
          busy={save.isPending && "Saving…"}
        >
          {refused ? "Replace fix" : "Save fix"}
        </Button>
      </div>
    </form>
  );
}

/** A page as the reader saw it, with a way to the pages before and after. */
function PageView({
  personId,
  documentId,
  position,
  pages,
  place,
  show,
  count,
}: {
  personId: string;
  documentId: string;
  position: number;
  pages: readonly Page[];
  /** Its pages in what the person added, when it is split from it. */
  place: DocumentSummary["place"];
  show: (position: number) => void;
  count: (position: number) => number;
}) {
  // A document split from an add keeps the add's page numbers: pages 3–4.
  const index = Math.max(
    0,
    pages.findIndex((p) => p.position === position),
  );
  const page = pages[index];
  const of = pages.length;
  const before = pages[index - 1];
  const after = pages[index + 1];
  return (
    <section
      aria-label="Page"
      className="flex min-h-[320px] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <IconButton
          label="Previous page"
          icon={ChevronLeft}
          disabled={before === undefined}
          onClick={() => {
            if (before) show(before.position);
          }}
        />
        <b>
          Page {index + 1} of {of}
        </b>
        {place && (
          <span className="text-xs text-muted">
            (page {position} of {place.of} in the file)
          </span>
        )}
        <IconButton
          label="Next page"
          icon={ChevronRight}
          disabled={after === undefined}
          onClick={() => {
            if (after) show(after.position);
          }}
        />
        <span className="flex-1" />
        {page && (
          <span className="text-xs text-muted">
            {pageWords(page, count(position))}
          </span>
        )}
      </div>
      <div
        tabIndex={0}
        role="group"
        aria-label={`Page ${String(position)}`}
        className="flex flex-1 justify-center overflow-auto bg-side p-3.5"
      >
        <PageImage
          key={position}
          path={`${documentPath(personId, documentId)}/pages/${String(position)}`}
          alt={`Page ${String(index + 1)} of ${String(of)}`}
        />
      </div>
    </section>
  );
}

/** A page's image, fetched with the tab's proof and shown from a blob. */
function PageImage({ path, alt }: { path: string; alt: string }) {
  const [shown, setShown] = useState<{ url?: string; error?: Error }>({});
  useEffect(() => {
    let url: string | undefined;
    let gone = false;
    fetchFile(path).then(
      (blob) => {
        url = URL.createObjectURL(blob);
        if (gone) URL.revokeObjectURL(url);
        else setShown({ url });
      },
      (error: unknown) => {
        if (!gone) setShown({ error: error as Error });
      },
    );
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  if (shown.error) return <Problem error={shown.error} />;
  if (!shown.url) {
    return (
      <p role="status" className="m-auto text-muted">
        Preparing the page…
      </p>
    );
  }
  return (
    <img
      src={shown.url}
      alt={alt}
      className="h-fit max-w-full rounded-md shadow-sm"
    />
  );
}

/**
 * Puts the words to save this document's results in the chat bar, after
 * what is there, with the document's chip; the page stays, and the person
 * sends them.
 */
function SaveInChat({
  personId,
  document,
  name,
  count,
}: {
  personId: string;
  document: DocumentSummary;
  name: string;
  count: number;
}) {
  const box = boxFor(personId);
  const loaded = useStore(box.store, (state) => state.loaded);
  const sending = useStore(box.store, (state) => state.sending);
  const unresolved = useStore(box.store, (state) => state.unresolved);
  const reason = useId();
  const why = sending
    ? "Wait: a message is being sent."
    : unresolved
      ? "Retry the message in the chat first."
      : null;
  return (
    <>
      {why !== null && (
        <span id={reason} className="text-muted">
          {why}
        </span>
      )}
      <Button
        look="main"
        icon={MessageCircle}
        {...ASKS}
        {...(why !== null && { "aria-describedby": reason })}
        disabled={count === 0 || !loaded || sending || unresolved}
        onClick={() => {
          // The document's chip: the core names it and stamps its version
          // when the message is sent.
          askRufi(
            personId,
            [
              {
                pointer: { type: "document", id: document.id },
                label: name,
                detail: "",
              },
            ],
            `${count === 1 ? "Save this result" : `Save these ${String(count)} results`}.`,
          );
        }}
      >
        Save in chat
      </Button>
    </>
  );
}
