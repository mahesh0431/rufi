// Sign in with ChatGPT from the screens. The core runs the same sign-in as
// `pnpm rufi signin` (it already holds the data folder): it opens the
// browser on this Mac and waits for ChatGPT to send the person back. One
// sign-in at a time; the screens ask how it goes.
import type { SignInState } from "@rufi/contracts";
import { errorCode, type Log } from "../platform/logs.ts";

/** Runs one sign-in: shows the link, opens the browser, waits for the return. */
export type SignIn = (handlers: {
  showLink: (link: string) => void;
}) => Promise<{ email: string | undefined }>;

export function signInFlow(signIn: SignIn | undefined, log: Log) {
  let state: SignInState = { state: "idle", link: null, error: null };
  return {
    state: (): SignInState => state,
    /** Starts a sign-in, or gives the one already waiting. */
    start: (): SignInState => {
      if (state.state === "waiting") return state;
      if (!signIn) {
        state = {
          state: "failed",
          link: null,
          error: "This Rufi can't sign in from the app. Use pnpm rufi signin.",
        };
        return state;
      }
      state = { state: "waiting", link: null, error: null };
      signIn({
        showLink: (link) => {
          state = { state: "waiting", link, error: null };
        },
      }).then(
        () => {
          state = { state: "done", link: null, error: null };
        },
        (error: unknown) => {
          log("signin.failed", { error: errorCode(error) });
          state = {
            state: "failed",
            link: null,
            error:
              error instanceof Error
                ? error.message
                : "The sign-in didn't finish. Try again.",
          };
        },
      );
      return state;
    },
  };
}

export type SignInFlow = ReturnType<typeof signInFlow>;
