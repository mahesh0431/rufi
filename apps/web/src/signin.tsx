// Sign in with ChatGPT, in the app: the core opens the browser on this Mac
// and waits for ChatGPT to send you back; this page asks how it goes.
import { SignInState } from "@rufi/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { LogIn } from "lucide-react";
import { useEffect } from "react";
import { read } from "./api.ts";
import { queries, useStatus } from "./reads.ts";
import { Button } from "./ui.tsx";

/** How often a waiting page asks whether the sign-in is done. */
const POLL_MS = 1_000;

export function SignIn({ skip }: { skip?: () => void }) {
  const status = useStatus().data;
  const flow = useQuery({
    queryKey: ["signin"],
    queryFn: () => read(SignInState, "GET", "/api/signin"),
    refetchInterval: (query) =>
      query.state.data?.state === "waiting" ? POLL_MS : false,
  });
  const start = useMutation({
    mutationFn: () => read(SignInState, "POST", "/api/signin"),
    onSuccess: (state) => queries.setQueryData(["signin"], state),
  });
  const state = flow.data?.state;
  useEffect(() => {
    if (state === "done") {
      void queries.invalidateQueries({ queryKey: ["status"] });
      void queries.invalidateQueries({ queryKey: ["first-run"] });
    }
  }, [state]);

  if (status?.account === "signed_in") {
    return (
      <p>
        Signed in{status.email === null ? "" : ` as ${status.email}`}. Rufi's AI
        uses your ChatGPT plan.
      </p>
    );
  }
  const error = flow.data?.state === "failed" ? flow.data.error : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted">
        Rufi's AI uses your ChatGPT plan. Your record works without it.
      </p>
      {status?.account === "no_plan_use" && (
        <p>
          You are signed in, but ChatGPT plan use isn't allowed for Rufi. Sign
          in again and allow it.
        </p>
      )}
      {state === "waiting" && (
        <div role="status" className="flex flex-col gap-1">
          <p>
            Your browser opens ChatGPT's sign-in. Approve Rufi there; this page
            goes on by itself.
          </p>
          {flow.data?.link && (
            <p className="text-muted">
              If the browser didn't open,{" "}
              <a
                href={flow.data.link}
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
        {state !== "waiting" && (
          <Button
            look="main"
            disabled={start.isPending}
            onClick={() => {
              start.mutate();
            }}
          >
            <LogIn size={15} aria-hidden />
            Sign in with ChatGPT
          </Button>
        )}
        {skip && <Button onClick={skip}>Skip for now</Button>}
      </div>
      {(error ?? start.error?.message) && (
        <p role="alert" className="text-muted">
          {error ?? start.error?.message}
        </p>
      )}
    </div>
  );
}
