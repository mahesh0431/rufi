// Settings is a pop-up over the page you are on, open at one of its groups.
// The address says which: `?settings=<group>` on any page, so a link from the
// sidebar, a help page or Rufi AI opens it at its group, and closing it leaves
// the page as it was. Rufi AI and the help pages write such a link as
// rufi:/settings/<group>. What you typed and left unsaved is saved before
// it closes (useSavedOnClose).
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/** Settings' groups, in their order; the first is where Settings opens. */
export const GROUPS = [
  "sign-in",
  "profile",
  "appearance",
  "chat",
  "data",
] as const;
export type Group = (typeof GROUPS)[number];

const isGroup = (value: unknown): value is Group =>
  GROUPS.includes(value as Group);

/** `?settings=<group>`: the Settings group open over the page. */
export const settingsSearch = (
  search: Record<string, unknown>,
): { settings?: Group } =>
  isGroup(search["settings"]) ? { settings: search["settings"] } : {};

/**
 * The group a rufi:/settings link opens: rufi:/settings/data opens Data;
 * rufi:/settings, or a group Settings doesn't have, the first group.
 * Undefined when it isn't a link to Settings.
 */
export function settingsGroupOf(href: string): Group | undefined {
  const match = /^rufi:\/settings(?:\/([^/?#]*))?\/?(?:[?#].*)?$/i.exec(href);
  if (!match) return undefined;
  const named = match[1]?.toLowerCase();
  return isGroup(named) ? named : GROUPS[0];
}

/** Which Settings group is open over the page; undefined when it is shut. */
export const useSettingsGroup = (): Group | undefined =>
  useSearch({ strict: false, select: (search) => search.settings });

/** Opens Settings at a group over the page you are on, as SettingsLink does. */
export function useOpenSettings(): (group: Group) => void {
  const navigate = useNavigate();
  return (group) =>
    void navigate({
      to: ".",
      search: (previous) => ({ ...previous, settings: group }),
    });
}

/**
 * A link that opens Settings at `group` over the page you are on. Over the
 * chat panel too: a click on it doesn't fold the panel.
 */
export function SettingsLink({
  group,
  className,
  children,
}: {
  group: Group;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="."
      search={(previous) => ({ ...previous, settings: group })}
      className={className}
      data-over-chat=""
    >
      {children}
    </Link>
  );
}

/** Makes sure what a part of Settings has is saved; rejects when it isn't. */
export type Save = () => Promise<unknown>;

/** The saves of Settings' open parts, each with the group it is in. */
export const SettingsSaves = createContext<
  { saves: Map<Save, Group>; group: Group } | undefined
>(undefined);

/**
 * Runs `save` as Settings closes, after the field you are in has had its
 * own save on leaving it: by Esc too, while you type. When it fails,
 * Settings stays open at its group, what you typed still there.
 */
export function useSavedOnClose(save: Save): void {
  const open = useContext(SettingsSaves);
  useEffect(() => {
    if (open === undefined) return;
    open.saves.set(save, open.group);
    return () => {
      open.saves.delete(save);
    };
  });
}

/**
 * A box of text in Settings, saved when you leave it and as Settings
 * closes. What you type stays yours until it is saved: a save's answer, or
 * a change from another tab, comes into the box only when you haven't typed
 * since. Leaving it again while its save runs sends nothing more.
 */
export function useSavedText(
  kept: string,
  save: (text: string) => Promise<unknown>,
) {
  // What you typed, until it is the kept text.
  const [draft, setDraft] = useState<string>();
  if (draft !== undefined && draft === kept) setDraft(undefined);
  const sending = useRef<{ text: string; saved: Promise<unknown> }>(undefined);
  const saveText = (): Promise<unknown> => {
    if (draft === undefined) return Promise.resolve();
    if (sending.current?.text !== draft) {
      const saved = save(draft).finally(() => {
        if (sending.current?.saved === saved) sending.current = undefined;
      });
      sending.current = { text: draft, saved };
    }
    return sending.current.saved;
  };
  useSavedOnClose(saveText);
  return {
    text: draft ?? kept,
    type: setDraft,
    /** For the box's onBlur: a failed save says so beside it. */
    leave: () => {
      saveText().catch(() => undefined);
    },
    /** Shows the kept text again, dropping what was typed (a reset). */
    drop: () => {
      setDraft(undefined);
    },
  };
}
