// The frame around every page: the sidebar, the toolbar, the chat bar on the
// Overview, and what the connection to Rufi is doing. It stays when a page
// fails. Until first run is known to be done, it shows first run only, over
// the whole window, whatever the address.
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  CircleHelp,
  FileText,
  House,
  MessageCircle,
  Settings,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useConnection } from "./api.ts";
import { useAppearance } from "./appearance.tsx";
import { CHAT_TITLE, ChatDock } from "./chat.tsx";
import { FirstRun } from "./first-run.tsx";
import { useFirstRun, usePeople, useStatus } from "./reads.ts";

const TITLES: Record<string, string> = {
  settings: "Settings",
  help: "Help",
  "sign-in": "Sign in with ChatGPT",
};

/** Whether the address is a person's chat page. */
const isChatPage = (pathname: string) =>
  /^\/people\/[^/]+\/chat$/.test(pathname);

/** Whether the address is a person's Documents page. */
const isDocumentsPage = (pathname: string) =>
  /^\/people\/[^/]+\/documents$/.test(pathname);

export function Frame() {
  useAppearance();
  const connection = useConnection();
  const person = usePeople().data?.[0];
  const step = useFirstRun().data?.step;
  /** First run is done: known only once the core says so. */
  const welcomed = step === "done";
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const onChat = isChatPage(pathname);
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
    <div className="flex h-full">
      <aside
        data-sidebar=""
        className="flex w-60 shrink-0 flex-col gap-0.5 border-r border-line bg-side p-2.5"
      >
        <p className="truncate px-2 py-1.5 font-semibold">
          {person?.displayName ?? "Rufi"}
        </p>
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
              <MessageCircle size={15} aria-hidden />
              {CHAT_TITLE}
            </Link>
          )}
          <Place to="/" icon={<House size={15} aria-hidden />}>
            Overview
          </Place>
          {person && (
            <Link
              to="/people/$personId/documents"
              params={{ personId: person.id }}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface/60"
              activeProps={{ className: "bg-accent-soft text-accent-ink" }}
            >
              <FileText size={15} aria-hidden />
              Documents
            </Link>
          )}
          <div className="flex-1" />
          <Place to="/help" icon={<CircleHelp size={15} aria-hidden />}>
            Help
          </Place>
          <Place to="/settings" icon={<Settings size={15} aria-hidden />}>
            Settings
          </Place>
        </nav>
        <Account />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col bg-page">
        <header
          data-toolbar=""
          className="flex h-[52px] shrink-0 items-center border-b border-line bg-page/80 px-5 backdrop-blur"
        >
          <h1 className="truncate text-[15px] font-semibold">
            {onChat
              ? CHAT_TITLE
              : isDocumentsPage(pathname)
                ? "Documents"
                : (TITLES[pathname.split("/")[1] ?? ""] ?? "Overview")}
          </h1>
        </header>
        <Offline shown={connection === "offline"} />
        <main className="flex-1 overflow-auto">
          {connection === "ended" ? <Ended alone={false} /> : <Outlet />}
        </main>
      </div>
      {person && connection !== "ended" && pathname === "/" && (
        <ChatDock person={person} />
      )}
    </div>
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

/** The ChatGPT sign-in, at the bottom of the sidebar only when it needs you. */
function Account() {
  const account = useStatus().data?.account;
  if (account === undefined || account === "signed_in") return null;
  return (
    <Link
      to="/sign-in"
      className="px-2 pt-2 text-xs text-accent-ink hover:underline"
    >
      {account === "signed_out"
        ? "Not signed in"
        : "ChatGPT plan can't be used"}
    </Link>
  );
}
