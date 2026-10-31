// The pages and their addresses. Every page draws inside the frame, so a page
// that fails leaves the sidebar working.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import type { PageKind } from "@rufi/contracts/record";
import { House } from "lucide-react";
import type { ReactNode } from "react";
import { BriefPage } from "./brief.tsx";
import { ChatPage } from "./chat.tsx";
import { DocumentPage } from "./document-page.tsx";
import { DocumentsPage } from "./documents.tsx";
import { FollowUpsPage } from "./follow-ups.tsx";
import { Frame } from "./frame.tsx";
import { HelpPage } from "./help-page.tsx";
import { OverviewPage } from "./overview.tsx";
import { ProfilePage } from "./profile.tsx";
import { isPageKind, pageOf, RecordPage } from "./record.tsx";
import { usePeople, useRecordDetail } from "./reads.ts";
import { SettingsPage } from "./settings.tsx";
import { SignIn } from "./signin.tsx";
import { LabResultsPage, TestPage } from "./tests.tsx";
import { VisitPage } from "./visit.tsx";
import { buttonLook, ICON, Problem } from "./ui.tsx";

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

const document = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/documents/$documentId",
  component: function Document() {
    const { personId, documentId } = document.useParams();
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
    return (
      <DocumentPage key={documentId} person={person} documentId={documentId} />
    );
  },
});

/**
 * The address of results before they had two pages, `record/result`: it
 * opens the page of the row's category, or Lab results when no row is
 * asked for (or it can't be read).
 */
function ResultsBefore({
  personId,
  open,
}: {
  personId: string;
  open?: string;
}) {
  const to = (kind: PageKind) => (
    <Navigate
      to="/people/$personId/record/$kind"
      params={{ personId, kind }}
      search={open === undefined ? {} : { open }}
      replace
    />
  );
  if (open === undefined) return to("lab_result");
  return <ResultBefore personId={personId} open={open} to={to} />;
}

function ResultBefore({
  personId,
  open,
  to,
}: {
  personId: string;
  open: string;
  to: (kind: PageKind) => ReactNode;
}) {
  const detail = useRecordDetail(personId, "result", open);
  if (detail.isPending) return null;
  const row = detail.data?.row;
  return to(
    (row !== undefined && !("problem" in row) && pageOf(row)) || "lab_result",
  );
}

/**
 * A lab result's address, `record/lab_result?open=<id>`: it opens on its
 * test's page, or Lab results when it can't be read.
 */
function LabResultAt({ personId, open }: { personId: string; open: string }) {
  const detail = useRecordDetail(personId, "result", open);
  if (detail.isPending) return null;
  const row = detail.data?.row;
  if (row === undefined || "problem" in row || row.kind !== "result") {
    return (
      <Navigate
        to="/people/$personId/record/$kind"
        params={{ personId, kind: "lab_result" }}
        replace
      />
    );
  }
  return (
    <Navigate
      to="/people/$personId/tests/$testId"
      params={{ personId, testId: row.in_test }}
      search={{ open }}
      replace
    />
  );
}

/** `?open=<id>`: the row to open and bring into view. */
const openSearch = (search: Record<string, unknown>): { open?: string } =>
  typeof search["open"] === "string" ? { open: search["open"] } : {};

const record = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/record/$kind",
  validateSearch: openSearch,
  component: function Record() {
    const { personId, kind } = record.useParams();
    const { open } = record.useSearch();
    const people = usePeople();
    if (people.data === undefined) {
      return people.error ? (
        <div className="px-6 py-8">
          <Problem error={people.error} retry={() => void people.refetch()} />
        </div>
      ) : null;
    }
    const person = people.data.find((p) => p.id === personId);
    if (person && kind === "result") {
      return (
        <ResultsBefore
          personId={personId}
          {...(open !== undefined && { open })}
        />
      );
    }
    // Lab results lists tests; a lab result opens on its test's page.
    if (person && kind === "lab_result") {
      return open === undefined ? (
        <LabResultsPage key={personId} person={person} />
      ) : (
        <LabResultAt key={open} personId={personId} open={open} />
      );
    }
    // A visit opens on its own page, whichever link asked for it.
    if (person && kind === "visit" && open !== undefined) {
      return (
        <Navigate
          to="/people/$personId/visits/$visitId"
          params={{ personId, visitId: open }}
          replace
        />
      );
    }
    if (!person || !isPageKind(kind)) {
      return <div className="px-6 py-8 text-muted">There is no page here.</div>;
    }
    return (
      <RecordPage
        key={`${personId}/${kind}/${open ?? ""}`}
        person={person}
        kind={kind}
        {...(open !== undefined && { opened: open })}
      />
    );
  },
});

const visit = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/visits/$visitId",
  component: function Visit() {
    const { personId, visitId } = visit.useParams();
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
    return <VisitPage key={visitId} person={person} visitId={visitId} />;
  },
});

const test = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/tests/$testId",
  validateSearch: openSearch,
  component: function Test() {
    const { personId, testId } = test.useParams();
    const { open } = test.useSearch();
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
    return (
      <TestPage
        key={`${personId}/${testId}/${open ?? ""}`}
        person={person}
        testId={testId}
        {...(open !== undefined && { opened: open })}
      />
    );
  },
});

const followUps = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/follow-ups",
  validateSearch: openSearch,
  component: function FollowUps() {
    const { personId } = followUps.useParams();
    const { open } = followUps.useSearch();
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
    return (
      <FollowUpsPage
        key={`${personId}/${open ?? ""}`}
        person={person}
        {...(open !== undefined && { opened: open })}
      />
    );
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

const profile = createRoute({
  getParentRoute: () => root,
  path: "/people/$personId/profile",
  component: function Profile() {
    const { personId } = profile.useParams();
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
    return <ProfilePage key={personId} person={person} />;
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
      <div className="mx-auto flex max-w-[620px] flex-col gap-8 px-6 py-8">
        <section>
          <h2 className="mb-2 font-semibold">Codex</h2>
          <SignIn provider="codex" />
        </section>
        <section>
          <h2 className="mb-2 font-semibold">Claude</h2>
          <SignIn provider="claude" />
        </section>
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
    document,
    record,
    visit,
    test,
    followUps,
    brief,
    profile,
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
      <Link to="/" className={buttonLook({ look: "quiet" })}>
        <House size={ICON} aria-hidden />
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
