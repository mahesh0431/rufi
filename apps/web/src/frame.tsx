// The frame around every page: the sidebar, the toolbar, the chat, and
// what the connection to Rufi is doing. It stays when a page fails.
import type { Person } from "@rufi/contracts";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { CircleHelp, House, Settings, SquarePen } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useConnection } from "./api.ts";
import { ChatDock, titleOf, useNewConversation } from "./chat.tsx";
import { messageOf } from "./live.ts";
import { useConversations, usePeople, useStatus } from "./reads.ts";

const TITLES: Record<string, string> = { settings: "Settings", help: "Help" };

/** The person and conversation of a conversation page's address. */
const conversationOf = (pathname: string) => {
  const match = /^\/people\/([^/]+)\/conversations\/([^/]+)$/.exec(pathname);
  return (
    match && {
      personId: decodeURIComponent(match[1] ?? ""),
      conversationId: decodeURIComponent(match[2] ?? ""),
    }
  );
};

export function Frame() {
  const connection = useConnection();
  const person = usePeople().data?.[0];
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const onConversation = conversationOf(pathname);

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
            <NewConversation
              personId={person.id}
              onPage={onConversation !== null}
            />
          )}
          <Place to="/" icon={<House size={15} aria-hidden />}>
            Overview
          </Place>
          {person ? (
            <Conversations
              person={person}
              current={onConversation?.conversationId}
            />
          ) : (
            <div className="flex-1" />
          )}
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
            {onConversation ? (
              <ConversationTitle {...onConversation} />
            ) : (
              (TITLES[pathname.split("/")[1] ?? ""] ?? "Overview")
            )}
          </h1>
        </header>
        {connection === "offline" && (
          <p role="status" className="bg-accent-soft px-5 py-2 text-accent-ink">
            Rufi can't be reached. If you stopped it, run{" "}
            <code className="font-mono">pnpm start</code> and use its new link.
          </p>
        )}
        <main className="flex-1 overflow-auto">
          {connection === "ended" ? (
            <div role="alert" className="mx-auto mt-24 max-w-sm">
              <h2 className="text-xl font-semibold">This session has ended</h2>
              <p className="mt-2 text-muted">
                Open Rufi again from the terminal: run{" "}
                <code className="font-mono">pnpm start</code>.
              </p>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
      {person && connection !== "ended" && onConversation === null && (
        <ChatDock person={person} />
      )}
    </div>
  );
}

function NewConversation({
  personId,
  onPage,
}: {
  personId: string;
  onPage: boolean;
}) {
  const start = useNewConversation(personId);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setProblem(null);
          start(onPage).catch((error: unknown) => {
            setProblem(messageOf(error));
          });
        }}
        className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/60"
      >
        <SquarePen size={15} aria-hidden />
        New conversation
      </button>
      {problem !== null && (
        <p role="alert" className="px-2 text-xs text-muted">
          {problem}
        </p>
      )}
    </>
  );
}

/** The person's conversations, newest first, each at its own page. */
function Conversations({
  person,
  current,
}: {
  person: Person;
  current: string | undefined;
}) {
  const conversations = useConversations(person.id).data?.conversations ?? [];
  return (
    <section
      aria-labelledby="conversations"
      className="mt-3 flex min-h-0 flex-1 flex-col"
    >
      {conversations.length > 0 && (
        <h2 id="conversations" className="px-2 pb-1 text-xs text-muted">
          Conversations
        </h2>
      )}
      <ul className="min-h-0 flex-1 overflow-auto">
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <Link
              to="/people/$personId/conversations/$conversationId"
              params={{ personId: person.id, conversationId: conversation.id }}
              aria-current={current === conversation.id ? "page" : undefined}
              className={
                current === conversation.id
                  ? "block truncate rounded-lg bg-accent-soft px-2 py-1.5 text-accent-ink"
                  : "block truncate rounded-lg px-2 py-1.5 hover:bg-white/60"
              }
            >
              {titleOf(conversation)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConversationTitle({
  personId,
  conversationId,
}: {
  personId: string;
  conversationId: string;
}) {
  const conversations = useConversations(personId).data?.conversations;
  return <>{titleOf(conversations?.find((c) => c.id === conversationId))}</>;
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
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/60"
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
      to="/help/$page"
      params={{ page: "signing-in" }}
      className="px-2 pt-2 text-xs text-accent-ink hover:underline"
    >
      {account === "signed_out"
        ? "Not signed in"
        : "ChatGPT plan can't be used"}
    </Link>
  );
}
