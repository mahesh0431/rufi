// The frame around every page: the sidebar (with the person's record by
// kind), the toolbar, the chat bar at the bottom right of the pages where
// you read your health, and what the connection to Rufi is doing. It holds
// the person's live stream on every page, so a save shows wherever you are.
// It stays when a page fails. Until first run is known to be done, it shows
// first run only, over the whole window, whatever the address.
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  Activity,
  CalendarClock,
  CircleHelp,
  FileText,
  FlaskConical,
  HeartPulse,
  House,
  MessageCircle,
  Pill,
  Ruler,
  Settings,
  ShieldAlert,
  Stethoscope,
  Syringe,
} from "lucide-react";
import type { Person } from "@rufi/contracts";
import { type ReactNode, useEffect } from "react";
import { useConnection } from "./api.ts";
import { Dog } from "./dog.tsx";
import { useAppearance } from "./appearance.tsx";
import { CHAT_TITLE, ChatDock } from "./chat.tsx";
import { ReadingSheet } from "./reading.tsx";
import { AgentSheet } from "./agents.tsx";
import { FirstRun } from "./first-run.tsx";
import { retain } from "./live.ts";
import { resetPanel } from "./panel.ts";
import { SidebarDog } from "./sidebar-dog.tsx";
import { isPageKind, KIND_TITLES } from "./record.tsx";
import { useFirstRun, useOverview, usePeople, useStatus } from "./reads.ts";
import { ICON, type Icon } from "./ui.tsx";

const TITLES: Record<string, string> = {
  settings: "Settings",
  help: "Help",
  "sign-in": "Sign in",
};

/** Whether the address is a person's chat page. */
const isChatPage = (pathname: string) =>
  /^\/people\/[^/]+\/chat$/.test(pathname);

/** Whether the address is one of a person's visit briefs. */
const isBriefPage = (pathname: string) =>
  /^\/people\/[^/]+\/briefs\/[^/]+$/.test(pathname);

/** Whether the address is one of a person's visits. */
const isVisitPage = (pathname: string) =>
  /^\/people\/[^/]+\/visits\/[^/]+$/.test(pathname);

/** Whether the address is one of a person's tests. */
const isTestPage = (pathname: string) =>
  /^\/people\/[^/]+\/tests\/[^/]+$/.test(pathname);

/** The kind of a person's record page at the address, if it is one. */
const recordKind = (pathname: string) => {
  const kind = /^\/people\/[^/]+\/record\/([^/]+)$/.exec(pathname)?.[1];
  return kind !== undefined && isPageKind(kind) ? kind : undefined;
};

/** The person whose page the address is, if it is one. */
const personAt = (pathname: string) => {
  const id = /^\/people\/([^/]+)/.exec(pathname)?.[1];
  return id === undefined ? undefined : decodeURIComponent(id);
};

/** Whether the address is a person's profile. */
const isProfilePage = (pathname: string) =>
  /^\/people\/[^/]+\/profile$/.test(pathname);

/** Whether the address is a person's Follow-ups. */
const isFollowUpsPage = (pathname: string) =>
  /^\/people\/[^/]+\/follow-ups$/.test(pathname);

/** Whether the address is a person's Documents page, or one document's. */
const isDocumentsPage = (pathname: string) =>
  /^\/people\/[^/]+\/documents(\/[^/]+)?$/.test(pathname);

/**
 * Whether the page has the chat bar: the pages where you read your health.
 * Not the chat's page (it has its own box), Help, Settings or Sign in.
 */
const hasBar = (pathname: string) =>
  pathname === "/" ||
  recordKind(pathname) !== undefined ||
  isFollowUpsPage(pathname) ||
  isDocumentsPage(pathname) ||
  isBriefPage(pathname) ||
  isVisitPage(pathname) ||
  isTestPage(pathname);

export function Frame() {
  useAppearance();
  const connection = useConnection();
  const step = useFirstRun().data?.step;
  /** First run is done: known only once the core says so. */
  const welcomed = step === "done";
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // The person whose page this is; elsewhere, the first person.
  const people = usePeople().data;
  const person =
    people?.find((p) => p.id === personAt(pathname)) ?? people?.[0];
  const onChat = isChatPage(pathname);
  const bar =
    person !== undefined && connection !== "ended" && hasBar(pathname);
  const kind = recordKind(pathname);
  // Their stream on every page: a save, an undo or a reading shows at once.
  const streaming = welcomed && connection !== "ended" ? person?.id : undefined;
  useEffect(
    () => (streaming === undefined ? undefined : retain(streaming)),
    [streaming],
  );
  // Another page, or another person's: the panel closes, and forgets where
  // focus was.
  useEffect(() => {
    resetPanel();
  }, [pathname]);
  // During first run, another page's address leads home, where Rufi opens
  // once first run is done.
  const navigate = useNavigate();
  const elsewhere = step !== undefined && !welcomed && pathname !== "/";
  useEffect(() => {
    if (elsewhere) void navigate({ to: "/", replace: true });
  }, [elsewhere, navigate]);

  if (!welcomed) {
    return (
      <div className="flex h-full flex-col bg-page">
        <Offline shown={connection === "offline"} />
        <main className="flex-1 overflow-auto">
          {connection === "ended" ? <Ended alone /> : <FirstRun />}
        </main>
      </div>
    );
  }
  return (
    <div data-frame="" className="flex h-full">
      <aside
        data-sidebar=""
        className="flex w-60 shrink-0 flex-col gap-0.5 border-r border-line bg-side p-2.5"
      >
        <div className="flex items-center gap-2 px-2 py-1.5">
          {person ? (
            // Keyed by person: what it remembers (a job just done) is theirs.
            <SidebarDog key={person.id} person={person} />
          ) : (
            <Dog size={36} />
          )}
          {person ? (
            // Your name opens your profile.
            <Link
              to="/people/$personId/profile"
              params={{ personId: person.id }}
              title="Profile"
              className="min-w-0 truncate rounded-md px-1 font-semibold hover:bg-surface/60"
              activeProps={{ className: "bg-accent-soft text-accent-ink" }}
            >
              {person.displayName}
            </Link>
          ) : (
            <p className="truncate font-semibold">Rufi</p>
          )}
        </div>
        <nav
          aria-label="Pages"
          className="mt-2 flex min-h-0 flex-1 flex-col gap-0.5"
        >
          {person && (
            <Link
              to="/people/$personId/chat"
              params={{ personId: person.id }}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface/60"
              activeProps={{ className: "bg-accent-soft text-accent-ink" }}
            >
              <MessageCircle size={ICON} aria-hidden />
              {CHAT_TITLE}
            </Link>
          )}
          <Place to="/" icon={<House size={ICON} aria-hidden />}>
            Overview
          </Place>
          {person && <RecordNav person={person} />}
          {person && <FollowUpsNav person={person} />}
          {person && (
            <Link
              to="/people/$personId/documents"
              params={{ personId: person.id }}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface/60"
              activeProps={{ className: "bg-accent-soft text-accent-ink" }}
            >
              <FileText size={ICON} aria-hidden />
              Documents
            </Link>
          )}
          <div className="flex-1" />
          <Place to="/help" icon={<CircleHelp size={ICON} aria-hidden />}>
            Help
          </Place>
          <Place to="/settings" icon={<Settings size={ICON} aria-hidden />}>
            Settings
          </Place>
        </nav>
        <Account />
      </aside>
      <div data-pane="" className="flex min-w-0 flex-1 flex-col bg-page">
        <header
          data-toolbar=""
          className="flex h-[52px] shrink-0 items-center border-b border-line bg-page/80 px-5 backdrop-blur"
        >
          <h1 className="truncate text-[15px] font-semibold">
            {onChat
              ? CHAT_TITLE
              : kind !== undefined
                ? KIND_TITLES[kind]
                : isFollowUpsPage(pathname)
                  ? "Follow-ups"
                  : isDocumentsPage(pathname)
                    ? "Documents"
                    : isBriefPage(pathname)
                      ? "Visit brief"
                      : isVisitPage(pathname)
                        ? "Visit"
                        : isTestPage(pathname)
                          ? "Test"
                          : isProfilePage(pathname)
                            ? "Profile"
                            : (TITLES[pathname.split("/")[1] ?? ""] ??
                              "Overview")}
          </h1>
        </header>
        <Offline shown={connection === "offline"} />
        {/* With the bar, the page ends above the room it floats in, so it
            never covers a row or a button. */}
        <main
          className={`min-h-0 flex-1 overflow-auto ${bar ? "pb-[76px]" : ""}`}
        >
          {connection === "ended" ? <Ended alone={false} /> : <Outlet />}
        </main>
      </div>
      {bar && <ChatDock person={person} />}
      <ReadingSheet />
      <AgentSheet />
    </div>
  );
}

/** Follow-ups, with how many are open; apart from the record, as things to do. */
function FollowUpsNav({ person }: { person: Person }) {
  const open = useOverview(person.id).data?.openFollowUps ?? 0;
  return (
    <Link
      to="/people/$personId/follow-ups"
      params={{ personId: person.id }}
      className="mt-3 flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface/60"
      activeProps={{ className: "bg-accent-soft text-accent-ink" }}
    >
      <CalendarClock size={ICON} aria-hidden />
      Follow-ups
      {open > 0 && (
        <span className="ml-auto text-muted tabular-nums">{open}</span>
      )}
    </Link>
  );
}

/** Each record page's icon in the sidebar. */
const KIND_ICONS: Record<keyof typeof KIND_TITLES, Icon> = {
  lab_result: FlaskConical,
  measurement: Ruler,
  medicine_use: Pill,
  visit: Stethoscope,
  condition: HeartPulse,
  allergy: ShieldAlert,
  symptom: Activity,
  care_event: Syringe,
};

/** The person's record by kind, each with its count, as Overview's tiles. */
function RecordNav({ person }: { person: Person }) {
  const tiles = useOverview(person.id).data?.tiles;
  return (
    <>
      <p className="px-2 pt-3 pb-0.5 text-[11px] text-muted">Health record</p>
      {(Object.keys(KIND_TITLES) as (keyof typeof KIND_TITLES)[]).map(
        (kind) => {
          const count = tiles?.find((tile) => tile.kind === kind)?.count ?? 0;
          const KindIcon = KIND_ICONS[kind];
          return (
            <Link
              key={kind}
              to="/people/$personId/record/$kind"
              params={{ personId: person.id, kind }}
              className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface/60 ${count === 0 ? "text-muted" : ""}`}
              activeProps={{ className: "bg-accent-soft text-accent-ink" }}
            >
              <KindIcon size={ICON} aria-hidden />
              {KIND_TITLES[kind]}
              {count > 0 && (
                <span className="ml-auto text-muted tabular-nums">{count}</span>
              )}
            </Link>
          );
        },
      )}
      <div className="h-3" />
    </>
  );
}

function Offline({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return (
    <p role="status" className="bg-accent-soft px-5 py-2 text-accent-ink">
      Rufi can't be reached. If you stopped it, run{" "}
      <code className="font-mono">pnpm start</code> and use its new link.
    </p>
  );
}

/** The session is over; `alone`: no toolbar above it, so its title leads. */
function Ended({ alone }: { alone: boolean }) {
  const Title = alone ? "h1" : "h2";
  return (
    <div role="alert" className="mx-auto mt-24 max-w-sm">
      <Title className="text-xl font-semibold">This session has ended</Title>
      <p className="mt-2 text-muted">
        Open Rufi again from the terminal: run{" "}
        <code className="font-mono">pnpm start</code>.
      </p>
    </div>
  );
}

function Place({
  to,
  icon,
  children,
}: {
  to: "/" | "/help" | "/settings";
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/" }}
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface/60"
      activeProps={{ className: "bg-accent-soft text-accent-ink" }}
    >
      {icon}
      {children}
    </Link>
  );
}

/** Codex's sign-in, at the bottom of the sidebar only when it needs you. */
function Account() {
  const account = useStatus().data?.codex.state;
  if (account === undefined || account === "signed_in") return null;
  return (
    <Link
      to="/sign-in"
      className="px-2 pt-2 text-xs text-accent-ink hover:underline"
    >
      {account === "signed_out" ? "Not signed in" : "Codex can't start"}
    </Link>
  );
}
