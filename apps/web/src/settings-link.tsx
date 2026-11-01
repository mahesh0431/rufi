// Settings is a pop-up over the page you are on, open at one of its groups.
// The address says which: `?settings=<group>` on any page, so a link from the
// sidebar, a help page or Rufi AI opens it at its group, and closing it leaves
// the page as it was. Rufi AI and the help pages write such a link as
// rufi:/settings/<group>.
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** Settings' groups, in their order; the first is where Settings opens. */
export const GROUPS = [
  "sign-in",
  "profile",
  "appearance",
  "chat",
  "data",
  "advanced",
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
