// The frame around every page: the sidebar (with the person's record by
// kind), the toolbar, the chat bar at the bottom right of the pages where
// you read your health, and what the connection to Rufi is doing. It holds
// the person's live stream on every page, so a save shows wherever you are.
// It stays when a page fails. In Rufi's iPhone app it is the page and the
// chat bar, under the app's own bars and sidebar (phone.ts). Until first run is known to be done, it shows
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
import { RemindersMenu } from "./reminders.tsx";
import { type ReactNode, useEffect } from "react";
import { type Connection, useConnection } from "./api.ts";
import { Dog } from "./dog.tsx";
import { useAppearance } from "./appearance.tsx";
import { CHAT_TITLE, ChatDock } from "./chat.tsx";
import { ReadingSheet } from "./reading.tsx";
import { AgentSheet } from "./agents.tsx";
import { FirstRun } from "./first-run.tsx";
import { retain } from "./live.ts";
import { resetPanel } from "./panel.ts";
import { onPhone, tell, tellTheme, useNamed } from "./phone.ts";
import { SidebarDog } from "./sidebar-dog.tsx";
import { isPageKind, KIND_TITLES } from "./record.tsx";
import { SettingsDialog } from "./settings.tsx";
import { SettingsLink, useSettingsGroup } from "./settings-link.tsx";
import { useFirstRun, useOverview, usePeople, useStatus } from "./reads.ts";
import { ICON, type Icon } from "./ui.tsx";

const TITLES: Record<string, string> = {
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

/** Whether the address is a person's Follow-ups. */
const isFollowUpsPage = (pathname: string) =>
  /^\/people\/[^/]+\/follow-ups$/.test(pathname);

/** Whether the address is a person's Documents page, or one document's. */
const isDocumentsPage = (pathname: string) =>
  /^\/people\/[^/]+\/documents(\/[^/]+)?$/.test(pathname);

/**
 * Whether the page has the chat bar: the pages where you read your health.
 * Not the chat's page (it has its own box), Help or Sign in.
 */
const hasBar = (pathname: string) =>
  pathname === "/" ||
  recordKind(pathname) !== undefined ||
  isFollowUpsPage(pathname) ||
  isDocumentsPage(pathname) ||
  isBriefPage(pathname) ||
  isVisitPage(pathname) ||
  isTestPage(pathname);

/** The title of the page at the address, as its bar shows it. */
function titleOf(pathname: string): string {
  const kind = recordKind(pathname);
  if (isChatPage(pathname)) return CHAT_TITLE;
  if (kind !== undefined) return KIND_TITLES[kind];
  if (isFollowUpsPage(pathname)) return "Follow-ups";
  if (isDocumentsPage(pathname)) return "Documents";
  if (isBriefPage(pathname)) return "Visit brief";
  if (isVisitPage(pathname)) return "Visit";
  if (isTestPage(pathname)) return "Test";
  return TITLES[pathname.split("/")[1] ?? ""] ?? "Overview";
}

export function Frame() {
  useAppearance();
  const connection = useConnection();
  const step = useFirstRun().data?.step;
  /** First run is done: known only once the core says so. */
  const welcomed = step === "done";
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // The person whose page this is; elsewhere, the first person, for
  // navigation only: what acts on a person needs the page's own.
  const people = usePeople().data;
  const pagePerson = people?.find((p) => p.id === personAt(pathname));
  const person = pagePerson ?? people?.[0];
  const kind = recordKind(pathname);
  const settingsGroup = useSettingsGroup();
  const settingsOpen = settingsGroup !== undefined;
  const bar =
    person !== undefined && connection !== "ended" && hasBar(pathname);
  // Their stream on every page: a save, an undo or a reading shows at once.
  const streaming = welcomed && connection !== "ended" ? person?.id : undefined;
  useEffect(
    () => (streaming === undefined ? undefined : retain(streaming)),
    [streaming],
  );
  // Another page, or another person's: the panel closes, and forgets where
  // focus was. On a phone the app says, as it opens the page (phone.ts).
  useEffect(() => {
    if (!onPhone) resetPanel();
  }, [pathname]);
  // During first run, another page's address leads home, where Rufi opens
  // once first run is done.
  const navigate = useNavigate();
  const elsewhere = step !== undefined && !welcomed && pathname !== "/";
  useEffect(() => {
    if (elsewhere) void navigate({ to: "/", replace: true });
  }, [elsewhere, navigate]);

  if (onPhone) {
    return (
      <PhoneFrame connection={connection} bar={bar ? person : undefined} />
    );
  }
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
            // Your name opens your profile: Settings › Profile.
            <SettingsLink
              group="profile"
              className={`min-w-0 truncate rounded-md px-1 font-semibold hover:bg-surface/60 ${settingsGroup === "profile" ? "bg-accent-soft text-accent-ink" : ""}`}
            >
              <span title="Profile">{person.displayName}</span>
            </SettingsLink>
          ) : (
            <p className="truncate font-semibold">Rufi</p>
          )}
        </div>
        <nav
          aria-label="Pages"
          // Scrolls within its height when the text is large.
          className="-mx-1 mt-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-1"
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
          <SettingsLink
            group="sign-in"
            className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface/60 ${settingsOpen ? "bg-accent-soft text-accent-ink" : ""}`}
          >
            <Settings size={ICON} aria-hidden />
            Settings
          </SettingsLink>
        </nav>
        <Account />
      </aside>
      <div data-pane="" className="flex min-w-0 flex-1 flex-col bg-page">
        <header
          data-toolbar=""
          className="flex h-[52px] shrink-0 items-center border-b border-line bg-page/80 px-5 backdrop-blur"
        >
          <h1 className="truncate text-[0.9375rem] font-semibold">
            {titleOf(pathname)}
          </h1>
          {kind === "medicine_use" && pagePerson && connection !== "ended" && (
            <div className="ml-auto">
              <RemindersMenu personId={pagePerson.id} />
            </div>
          )}
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
      <SettingsDialog />
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
      <p className="px-2 pt-3 pb-0.5 text-[0.6875rem] text-muted">
        Health record
      </p>
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

/**
 * The frame in the iPhone app (phone.ts): the page under the app's bars,
 * padded by how much they cover, and the chat bar at the bottom of the
 * pages that have it on the Mac (`bar`: whose chat it is). The app's title
 * bar takes each page's own name, or its kind. The chat scrolls inside its
 * own page, with its box at the bottom.
 */
function PhoneFrame({
  connection,
  bar,
}: {
  connection: Connection;
  bar: Person | undefined;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const path = useRouterState({
    select: (state) => state.location.pathname + state.location.searchStr,
  });
  const named = useNamed((state) => state.named);
  const title = named?.path === pathname ? named.title : titleOf(pathname);
  useEffect(() => {
    tell({ type: "page", path, title });
  }, [path, title]);
  const ended = connection === "ended";
  useEffect(() => {
    if (ended) tell({ type: "ended" });
  }, [ended]);
  // The app's own parts match the page's theme.
  useEffect(tellTheme, []);
  return (
    <>
      {connection === "offline" && (
        <p
          role="status"
          className="fixed inset-x-0 top-(--bar-top) z-10 bg-accent-soft px-4 py-2 text-accent-ink"
        >
          Can't reach your Mac. Checking again every few seconds.
        </p>
      )}
      {/* With the bar, the page ends above the room it floats in, so it
          never covers a row or a button. */}
      <main
        className={
          isChatPage(pathname)
            ? "h-full"
            : `min-h-full pt-(--bar-top) ${bar ? "pb-[calc(var(--bar-bottom,0px)+2.75rem+32px)]" : "pb-(--bar-bottom)"}`
        }
      >
        {/* Ended: the app opens Rufi again, or says this iPhone is unpaired. */}
        {!ended && <Outlet />}
      </main>
      {bar && !ended && <ChatDock person={bar} />}
      <ReadingSheet />
      <AgentSheet />
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
  to: "/" | "/help";
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
