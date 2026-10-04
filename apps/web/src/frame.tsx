// The frame around every page: the sidebar, the toolbar, and
// what the connection to Rufi is doing. It stays when a page fails.
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { CircleHelp, House, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useConnection } from "./api.ts";
import { usePeople, useStatus } from "./reads.ts";

const TITLES: Record<string, string> = { settings: "Settings", help: "Help" };
const titleOf = (pathname: string) =>
  TITLES[pathname.split("/")[1] ?? ""] ?? "Overview";

export function Frame() {
  const connection = useConnection();
  const person = usePeople().data?.[0];
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col gap-0.5 border-r border-line bg-side p-2.5">
        <p className="truncate px-2 py-1.5 font-semibold">
          {person?.displayName ?? "Rufi"}
        </p>
        <nav aria-label="Pages" className="mt-2 flex flex-1 flex-col gap-0.5">
          <Place to="/" icon={<House size={15} aria-hidden />}>
            Overview
          </Place>
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
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center border-b border-line bg-page/80 px-5 backdrop-blur">
          <h1 className="text-[15px] font-semibold">{titleOf(pathname)}</h1>
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
