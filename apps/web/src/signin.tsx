// Signing in, in the app, each provider its own way: the core starts the
// provider's own sign-in in the browser on this Mac (Codex with ChatGPT,
// Claude with its account), and this page asks how it goes.
import { SignInState, type Provider, type StartSignIn } from "@rufi/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, LogIn } from "lucide-react";
import { useEffect } from "react";
import { read } from "./api.ts";
import { queries, useStatus } from "./reads.ts";
import { Button } from "./ui.tsx";

/** How often a waiting page asks whether the sign-in is done. */
const POLL_MS = 1_000;

/** What the page says of each provider: drafts. */
const WORDS = {
  codex: {
    about:
      "Rufi's AI runs on Codex, with your ChatGPT plan. Your health record works without it.",
    signedIn: (account: string | null) =>
      `Codex is signed in${account === null ? "" : ` as ${account}`}. Rufi's AI uses your ChatGPT plan.`,
    waiting:
      "Your browser opens ChatGPT's sign-in for Codex. Sign in there; this page goes on by itself.",
    button: "Sign in with ChatGPT",
  },
  claude: {
    about: "Claude signs in with your Claude account, for the AI on Claude.",
    signedIn: () => "Claude is signed in.",
    waiting:
      "Your browser opens Claude's sign-in. Sign in there; this page goes on by itself.",
    button: "Sign in to Claude",
  },
} as const;

/** How the sign-in goes: asked again each second while it waits. */
export const useSignInFlow = () =>
  useQuery({
    queryKey: ["signin"],
    queryFn: () => read(SignInState, "GET", "/api/signin"),
    refetchInterval: (query) =>
      query.state.data?.state === "waiting" ? POLL_MS : false,
  });

export function SignIn({
  provider,
  skip,
}: {
  provider: Provider;
  skip?: () => void;
}) {
  const words = WORDS[provider];
  const status = useStatus().data?.[provider];
  const flow = useSignInFlow();
  const start = useMutation({
    mutationFn: () =>
      read(SignInState, "POST", "/api/signin", {
        provider,
      } satisfies StartSignIn),
    onSuccess: (state) => queries.setQueryData(["signin"], state),
  });
  const mine = flow.data?.provider === provider ? flow.data : undefined;
  const state = mine?.state;
  // One sign-in at a time: another provider's may be waiting.
  const waiting = flow.data?.state === "waiting";
  useEffect(() => {
    if (state === "done") {
      void queries.invalidateQueries({ queryKey: ["status"] });
      void queries.invalidateQueries({ queryKey: ["first-run"] });
      void queries.invalidateQueries({ queryKey: ["models"] });
    }
  }, [state]);

  if (status?.state === "signed_in")
    return <p>{words.signedIn(status.account)}</p>;
  const error = mine?.state === "failed" ? mine.error : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted">{words.about}</p>
      {status?.state === "unavailable" && <p>{status.text}</p>}
      {state === "waiting" && (
        <div role="status" className="flex flex-col gap-1">
          <p>{words.waiting}</p>
          {mine?.link && (
            <p className="text-muted">
              If the browser didn't open,{" "}
              <a
                href={mine.link}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                open the sign-in page
              </a>
              .
            </p>
          )}
        </div>
      )}
      <div className="flex gap-2">
        {state !== "waiting" && status?.state !== "unavailable" && (
          <Button
            look="main"
            icon={LogIn}
            disabled={start.isPending || waiting}
            onClick={() => {
              start.mutate();
            }}
          >
            {words.button}
          </Button>
        )}
        {skip && (
          <Button icon={ArrowRight} onClick={skip}>
            Skip for now
          </Button>
        )}
      </div>
      {(error ?? start.error?.message) && (
        <p role="alert" className="text-muted">
          {error ?? start.error?.message}
        </p>
      )}
    </div>
  );
}
