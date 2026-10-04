// The pages and their addresses. Every page draws inside the frame, so a page
// that fails leaves the sidebar working.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  useLocation,
} from "@tanstack/react-router";
import { FirstRun } from "./first-run.tsx";
import { Frame } from "./frame.tsx";
import { HelpPage } from "./help-page.tsx";
import { OverviewPage } from "./overview.tsx";
import { usePeople } from "./reads.ts";
import { SettingsPage } from "./settings.tsx";
import { Problem } from "./ui.tsx";

const root = createRootRoute({ component: Frame });

const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: function Home() {
    const people = usePeople();
    if (people.data === undefined && people.error) {
      return (
        <div className="px-6 py-8">
          <Problem error={people.error} retry={() => void people.refetch()} />
        </div>
      );
    }
    if (people.data === undefined) return null;
    const person = people.data[0];
    return person ? <OverviewPage person={person} /> : <FirstRun />;
  },
});

const settings = createRoute({
  getParentRoute: () => root,
  path: "/settings",
  component: SettingsPage,
});

function useHash() {
  return useLocation({ select: (location) => location.hash });
}

const helpIndex = createRoute({
  getParentRoute: () => root,
  path: "/help",
  component: function HelpIndex() {
    return <HelpPage page="index" hash={useHash()} />;
  },
});

const helpPage = createRoute({
  getParentRoute: () => root,
  path: "/help/$page",
  component: function Help() {
    const { page } = helpPage.useParams();
    return <HelpPage page={page} hash={useHash()} />;
  },
});

export const router = createRouter({
  routeTree: root.addChildren([home, settings, helpIndex, helpPage]),
  defaultErrorComponent: ({ error, reset }) => (
    <div className="px-6 py-8">
      <Problem
        error={new Error("This page couldn't be shown.", { cause: error })}
        retry={reset}
      />
    </div>
  ),
  defaultNotFoundComponent: () => (
    <div className="px-6 py-8 text-muted">
      There is no page here.{" "}
      <Link to="/" className="text-accent-ink">
        Go to Overview
      </Link>
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
