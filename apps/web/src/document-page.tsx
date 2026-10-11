// A document's page: the items the reader read, beside the page they came
// from. A click on a row shows its page; "Unsure only" keeps the items the
// reader or Rufi's checks marked. A fix changes an item's printed fields and
// keeps the reader's; it names the item's version, so a fix made on an older
// one (another tab fixed it first) is refused with the value as it is now.
// Nothing here saves to the record: "Save these in the chat" puts the words
// in the chat box, and the person sends them. An item goes
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
import { Schema } from "effect";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { ApiError, fetchFile, read } from "./api.ts";
import { AskRufi, ASKS } from "./ask.tsx";
import { boxFor } from "./boxes.ts";
import { printedDate, printedDay } from "./dates.ts";
import { DeleteDocument } from "./delete-document.tsx";
import { describe, KIND_NAMES, Viewer } from "./documents.tsx";
import type { BoxChip } from "./draft.ts";
import { messageOf, retain } from "./live.ts";
import { askRufi } from "./panel.ts";
import { queries, useDocuments } from "./reads.ts";
import { openReading, RetryButton, TextButton } from "./reading.tsx";
import { Button, Problem } from "./ui.tsx";

const documentPath = (personId: string, documentId: string) =>
  `/api/people/${encodeURIComponent(personId)}/documents/${encodeURIComponent(documentId)}`;

/** The fields a fix can change, in the form's order. */
const FIELDS: readonly { id: Fixable; name: string; wide?: boolean }[] = [
  { id: "test_name", name: "Test", wide: true },
  { id: "value_text", name: "Value" },
  { id: "unit", name: "Unit" },
  { id: "reference_range", name: "Range", wide: true },
  { id: "flag_text", name: "Flag" },
  { id: "context_text", name: "Context" },
];

const PAGE_STATE = {
  read: "read",
  nothing_here: "nothing here",
  unreadable: "couldn't be read",
  not_looked_at: "not looked at",
} as const;

type Item = DraftItem;
type Page = DocumentItems["pages"][number];

/** The item's fields the person changed: each with the reader's value. */
const fixesOf = (item: Item) =>
  FIELDS.filter(({ id }) => item.fields[id] !== item.original[id]);

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
  const items = useQuery({
    queryKey: ["items", person.id, documentId],
    queryFn: () =>
      read(
        DocumentItems,
        "GET",
        `${documentPath(person.id, documentId)}/items`,
      ),
  });
  const document = documents.data?.find((d) => d.id === documentId);
  // The list says it isn't there (deleted, or never added): its items'
  // refusal is no problem to try again.
  if (documents.data !== undefined && !document) {
    return (
      <div className="px-6 py-8 text-muted">
        There is no such document. It may have been deleted.
      </div>
    );
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

function Checking({
  person,
  document,
  items,
}: {
  person: Person;
  document: DocumentSummary;
  items: DocumentItems;
}) {
  const [unsureOnly, setUnsureOnly] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [fixing, setFixing] = useState<string | undefined>(undefined);
  const [shown, setShown] = useState(items.items[0]?.page ?? 1);
  const [original, setOriginal] = useState(false);
  const { name } = describe(document);
  const pending = items.items.filter((i) => i.status === "pending");
  // Results are current values only, as the Documents page and the chat's
  // line count them; an earlier column's values stay rows of their own.
  const results = pending.filter((i) => i.fields.column !== "earlier");
  const earlier = pending.length - results.length;
  const unsure = results.filter((i) => i.unsure.length > 0);
  const fixed = pending.filter((i) => fixesOf(i).length > 0);
  /** A page's items, also those the filter hides. */
  const count = (position: number) =>
    items.items.filter((i) => i.page === position).length;
  const marked = items.items.filter((i) => i.unsure.length > 0);
  const listed = unsureOnly ? marked : items.items;
  const left = [
    plural(results.length, "result"),
    ...(earlier > 0 ? [`${String(earlier)} earlier`] : []),
  ].join(" · ");
  const about = [
    ...(document.kind ? [KIND_NAMES[document.kind]] : []),
    ...(document.date ? [printedDate(document.date)] : []),
    plural(items.pages.length, "page"),
    `added ${printedDay(document.addedAt)}`,
  ].join(" · ");

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div className="flex flex-wrap items-center gap-2.5 px-5 pt-3.5 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate">
            <b className="text-[14px]">{name}</b>{" "}
            <span className="text-muted">· {about}</span>
          </h2>
          <p className="text-xs text-muted">
            What the reader read, not saved. These become part of your health
            record only when you save them in the chat.
          </p>
        </div>
        {(document.status === "not_read" ||
          document.reading?.canRetry === true) && (
          <RetryButton personId={person.id} documentId={document.id} />
        )}
        <Button
          onClick={() => {
            setOriginal(true);
          }}
        >
          View original
        </Button>
        {document.status !== "not_read" && (
          <Button
            onClick={() => {
              openReading(person.id, document.id);
            }}
          >
            The reader's work
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
                checked={unsureOnly}
                onChange={(event) => {
                  setUnsureOnly(event.target.checked);
                }}
                className="accent-accent"
              />
              Unsure only ({marked.length})
            </label>
            <span className="flex-1" />
            <span className="text-xs text-muted">
              {[
                left,
                `${String(unsure.length)} unsure`,
                ...(fixed.length > 0
                  ? [`${String(fixed.length)} fixed by you`]
                  : []),
              ].join(" · ")}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <Items
              personId={person.id}
              documentId={document.id}
              status={document.status}
              pages={items.pages}
              items={listed}
              unsureOnly={unsureOnly}
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
        <SaveInChat
          personId={person.id}
          document={document}
          name={name}
          count={results.length}
        />
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
  unsureOnly,
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
  unsureOnly: boolean;
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
    (page) => !unsureOnly || items.some((i) => i.page === page.position),
  );
  if (shownPages.length === 0) {
    return (
      <p className="px-3 py-4 text-muted">
        {unsureOnly ? "Nothing is marked unsure." : "No items were read."}
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
          {item.unsure.map((why) => (
            <span key={why} className="block text-xs text-muted">
              {why}
            </span>
          ))}
          {fixes.length > 0 && (
            <span className="block text-xs text-muted">
              The reader read:{" "}
              {fixes
                .map(
                  ({ id, name }) =>
                    `${name.toLowerCase()} ${item.original[id] ?? "(empty)"}`,
                )
                .join(" · ")}
            </span>
          )}
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
          {item.unsure.length > 0 && <Tag>unsure</Tag>}
          {done && <Tag>{item.status}</Tag>}
          {selected && !done && !fixing && (
            <TextButton
              onClick={() => {
                fix(item.id);
              }}
            >
              Fix
            </TextButton>
          )}
          {!done && (
            <AskRufi
              className="ml-1"
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
          The reader read <b>{item.original.value_text}</b>
          {item.original.unit ? ` ${item.original.unit}` : ""}. Rufi keeps it
          beside your fix.
        </span>
        <Button className="px-2.5 py-0.5" onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          look="main"
          className="px-2.5 py-0.5"
          disabled={changed.length === 0 || save.isPending}
        >
          {refused ? "Save my fix over it" : "Save fix"}
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
  show,
  count,
}: {
  personId: string;
  documentId: string;
  position: number;
  pages: readonly Page[];
  show: (position: number) => void;
  count: (position: number) => number;
}) {
  const page = pages.find((p) => p.position === position);
  const of = pages.length;
  return (
    <section
      aria-label="Page"
      className="flex min-h-[320px] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <Button
          look="quiet"
          className="px-1.5"
          aria-label="Previous page"
          disabled={position <= 1}
          onClick={() => {
            show(position - 1);
          }}
        >
          <ChevronLeft size={15} aria-hidden />
        </Button>
        <b>
          Page {position} of {of}
        </b>
        <Button
          look="quiet"
          className="px-1.5"
          aria-label="Next page"
          disabled={position >= of}
          onClick={() => {
            show(position + 1);
          }}
        >
          <ChevronRight size={15} aria-hidden />
        </Button>
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
          alt={`Page ${String(position)} of ${String(of)}`}
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
  return (
    <Button
      look="main"
      {...ASKS}
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
      {sending
        ? "Wait: a message is being sent"
        : unresolved
          ? "Retry the message in the chat first"
          : "Save these in the chat"}
    </Button>
  );
}

function Tag({ children, strong }: { children: string; strong?: boolean }) {
  return (
    <span
      className={`ml-1 rounded-full border px-1.5 text-[11px] whitespace-nowrap ${strong ? "border-transparent bg-accent-soft text-accent-ink" : "border-line text-muted"}`}
    >
      {children}
    </span>
  );
}
