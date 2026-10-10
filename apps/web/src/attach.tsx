// Adding files in the chat: the box's paperclip, and dropping files on the
// chat. Each file is added as a document when it is chosen or dropped (its
// reading starts then, not when the message is sent), and its chip goes in
// the box. Two or more photos first ask whether they are one document, as
// on the Documents page. A file already added gives the chip of the document
// the person has, and a line saying so.
import { Added } from "@rufi/contracts/documents";
import { Paperclip } from "lucide-react";
import {
  type DragEvent,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { upload } from "./api.ts";
import { boxFor } from "./boxes.ts";
import type { BoxChip } from "./draft.ts";
import { ACCEPT, AddDialog, type Chosen, isPhoto, look } from "./documents.tsx";
import { messageOf } from "./live.ts";
import { Menus } from "./model-menu.tsx";
import { queries } from "./reads.ts";

interface Attaching {
  /** Files on their way, by name. */
  adding: string[];
  /** Two or more photos, waiting for the person to say how they go. */
  picked: Chosen[] | undefined;
  /** What the person should know about the last add. */
  notice: string | null;
}

const stores = new Map<string, StoreApi<Attaching>>();

function attaching(personId: string): StoreApi<Attaching> {
  let store = stores.get(personId);
  if (!store) {
    store = createStore<Attaching>(() => ({
      adding: [],
      picked: undefined,
      notice: null,
    }));
    stores.set(personId, store);
  }
  return store;
}

/** Adds the files as documents, from the chat, and puts their chips in the box. */
async function add(personId: string, files: File[], together: boolean) {
  const state = attaching(personId);
  const names = files.map((file) => file.name);
  state.setState({
    adding: [...state.getState().adding, ...names],
    notice: null,
  });
  try {
    const form = new FormData();
    for (const file of files) form.append("file", file);
    form.append("together", together ? "yes" : "no");
    form.append("from", "chat");
    const added = await upload(
      Added,
      `/api/people/${encodeURIComponent(personId)}/documents`,
      form,
    );
    // The core names each chip when the box saves.
    const chips: BoxChip[] = [
      ...added.added,
      ...added.already.map((a) => a.documentId),
    ].map((id) => ({
      pointer: { type: "document", id },
      label: "",
      detail: "",
    }));
    if (!boxFor(personId).append("", chips)) {
      state.setState({
        notice:
          "Added. A message was being sent, so the chip isn't in the box: add it from the Documents page.",
      });
    } else if (added.already.length > 0) {
      state.setState({
        notice: `${added.already.map((a) => a.name).join(", ")} ${added.already.length === 1 ? "was" : "were"} already added: the chip is the document you have.`,
      });
    }
  } catch (error) {
    state.setState({ notice: messageOf(error) });
  } finally {
    const left = [...state.getState().adding];
    for (const name of names) left.splice(left.indexOf(name), 1);
    state.setState({ adding: left });
    void queries.invalidateQueries({ queryKey: ["documents", personId] });
  }
}

/** Files chosen or dropped in the chat: added now, or first grouped when 2+ are photos. */
async function choose(personId: string, files: File[]) {
  if (files.length === 0) return;
  const chosen = await Promise.all(files.map(look));
  if (chosen.filter(isPhoto).length >= 2) {
    attaching(personId).setState({ picked: chosen, notice: null });
  } else void add(personId, files, true);
}

/** The box's paperclip: choose files to add as documents. */
export function AttachButton({ personId }: { personId: string }) {
  const picker = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-label="Add documents"
        title="Add documents (PDF, JPG, PNG or HEIC)"
        onClick={() => picker.current?.click()}
        className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-side hover:text-ink"
      >
        <Paperclip size={16} aria-hidden />
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPT}
        aria-label="Choose documents to add"
        className="hidden"
        onChange={(event) => {
          void choose(personId, [...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </>
  );
}

/** Under the box: files on their way, an add's outcome, and the photos' question. */
export function AttachStatus({ personId }: { personId: string }) {
  const state = attaching(personId);
  const { adding, picked, notice } = useStore(state);
  const menus = useContext(Menus);
  return (
    <>
      {adding.length > 0 && (
        <p role="status" className="px-3.5 pb-1 text-xs text-muted">
          Adding {adding.join(", ")}…
        </p>
      )}
      {notice !== null && (
        <p role="alert" className="px-3.5 pb-1 text-muted">
          {notice}
        </p>
      )}
      {picked && (
        <AddDialog
          chosen={picked}
          container={menus}
          close={() => {
            state.setState({ picked: undefined });
          }}
          add={(files, together) => {
            state.setState({ picked: undefined });
            void add(personId, files, together);
          }}
        />
      )}
    </>
  );
}

/** The chat as a place to drop files: they are added as documents, with their chips in the box. */
export function FileDrop({
  personId,
  off = false,
  className,
  children,
}: {
  personId: string;
  /** Takes no files now (the chat is only its bar). */
  off?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`relative ${className ?? ""}`}
      onDragOver={(event: DragEvent) => {
        if (off || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event: DragEvent) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setDragging(false);
        }
      }}
      onDrop={(event: DragEvent) => {
        if (off || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void choose(personId, [...event.dataTransfer.files]);
      }}
    >
      {children}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-accent bg-accent-soft/90 text-[15px] font-semibold text-accent-ink">
          Drop to add to the chat
          <span className="text-[12.5px] font-normal">
            PDF, JPG, PNG or HEIC · each becomes a document
          </span>
        </div>
      )}
    </div>
  );
}
