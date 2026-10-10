// The pages and their addresses. Every page draws inside the frame, so a page
// that fails leaves the sidebar working.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { BriefPage } from "./brief.tsx";
import { ChatPage } from "./chat.tsx";
import { DocumentsPage } from "./documents.tsx";
import { Frame } from "./frame.tsx";
import { HelpPage } from "./help-page.tsx";
import { OverviewPage } from "./overview.tsx";
import { usePeople } from "./reads.ts";
import { SettingsPage } from "./settings.tsx";
import { SignIn } from "./signin.tsx";
import { Problem } from "./ui.tsx";

const root = createRootRoute({ component: Frame });

const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  // First run, until it is done, is the frame's.
  component: function Home() {
    const people = usePeople();
    if (people.data === undefined) {
      return people.error ? (
        <div className="px-6 py-8">
          <Problem error={people.error} retry={() => void people.refetch()} />
        </div>
      ) : null;
    }
    const person = people.data[0];
    return person ? <OverviewPage person={person} /> : null;
  },
});

const chat = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/chat",
  component: function Chat() {
    const { personId } = chat.useParams();
    const people = usePeople();
    if (people.data === undefined) {
      return people.error ? (
        <div className="px-6 py-8">
          <Problem error={people.error} retry={() => void people.refetch()} />
        </div>
      ) : null;
    }
    const person = people.data.find((p) => p.id === personId);
    if (!person) {
      return <div className="px-6 py-8 text-muted">There is no page here.</div>;
    }
    return <ChatPage key={personId} person={person} />;
  },
});

const documents = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/documents",
  component: function Documents() {
    const { personId } = documents.useParams();
    const people = usePeople();
    if (people.data === undefined) {
      return people.error ? (
        <div className="px-6 py-8">
          <Problem error={people.error} retry={() => void people.refetch()} />
        </div>
      ) : null;
    }
    const person = people.data.find((p) => p.id === personId);
    if (!person) {
      return <div className="px-6 py-8 text-muted">There is no page here.</div>;
    }
    return <DocumentsPage key={personId} person={person} />;
  },
});

const brief = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/briefs/$briefId",
  component: function Brief() {
    const { personId, briefId } = brief.useParams();
    const people = usePeople();
    if (people.data === undefined) {
      return people.error ? (
        <div className="px-6 py-8">
          <Problem error={people.error} retry={() => void people.refetch()} />
        </div>
      ) : null;
    }
    const person = people.data.find((p) => p.id === personId);
    if (!person) {
      return <div className="px-6 py-8 text-muted">There is no page here.</div>;
    }
    return <BriefPage key={briefId} person={person} briefId={briefId} />;
  },
});

// Addresses of the conversations Rufi once had lead to the person's chat.
const conversation = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/conversations/$conversationId",
  beforeLoad: ({ params }) => {
    redirect({
      to: "/people/$personId/chat",
      params: { personId: params.personId },
      replace: true,
      throw: true,
    });
  },
});

const settings = createRoute({
  getParentRoute: () => root,
  path: "/settings",
  component: SettingsPage,
});

const signIn = createRoute({
  getParentRoute: () => root,
  path: "/sign-in",
  component: function SignInPage() {
    return (
      <div className="mx-auto max-w-[620px] px-6 py-8">
        <SignIn />
      </div>
    );
  },
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
  routeTree: root.addChildren([
    home,
    chat,
    documents,
    brief,
    conversation,
    settings,
    signIn,
    helpIndex,
    helpPage,
  ]),
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
