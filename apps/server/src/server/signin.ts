// Signing in from the screens, the providers' own way: each provider (Codex,
// Claude) signs in by itself in the browser and keeps and renews its
// sign-in in its folder in the data folder. The core starts the provider's
// sign-in and waits for it; the screens ask how it goes. One sign-in at a
// time, for up to 5 minutes.
import type { Provider, ProviderStatus, SignInState } from "@rufi/contracts";
import {
  claudeLogIn,
  claudeSignedIn,
  findClaude,
} from "../agent/claude/executable.ts";
import type { CodexAdapter } from "../agent/codex/adapter.ts";
import { errorCode, type Log } from "../platform/logs.ts";

/** How long Rufi waits for the person to finish signing in. */
const WAIT_MS = 5 * 60_000;
/** How often Rufi asks each provider again how it's signed in. */
const KEEP_MS = 5 * 60_000;

/** A provider's sign-in: how it stands, and how to start it. */
export interface ProviderSignIn {
  /** As the provider reports it. */
  status: () => Promise<ProviderStatus>;
  /**
   * Runs the provider's own sign-in: shows its link, and resolves once it
   * has finished. Aborting `signal` cancels it.
   */
  start: (handlers: {
    showLink: (link: string) => void;
    signal: AbortSignal;
  }) => Promise<void>;
}

export function signInFlow(
  providers: Partial<Record<Provider, ProviderSignIn>>,
  log: Log,
  /** Done once Rufi has heard the provider is signed in. */
  signedIn: (provider: Provider) => Promise<void> = () => Promise.resolve(),
) {
  let state: SignInState = {
    provider: null,
    state: "idle",
    link: null,
    error: null,
  };
  return {
    state: (): SignInState => state,
    /** Starts a provider's sign-in, or gives the one already waiting. */
    start: (provider: Provider): SignInState => {
      if (state.state === "waiting") return state;
      const signIn = providers[provider];
      if (!signIn) {
        state = {
          provider,
          state: "failed",
          link: null,
          error: "This Rufi can't sign in from the app. Use pnpm rufi signin.",
        };
        return state;
      }
      state = { provider, state: "waiting", link: null, error: null };
      const signal = AbortSignal.timeout(WAIT_MS);
      signIn
        .start({
          showLink: (link) => {
            state = { provider, state: "waiting", link, error: null };
          },
          signal,
        })
        .then(
          async () => {
            await signedIn(provider);
            state = { provider, state: "done", link: null, error: null };
          },
          (error: unknown) => {
            log("signin.failed", { error: errorCode(error) });
            state = {
              provider,
              state: "failed",
              link: null,
              error: signal.aborted
                ? "The sign-in didn't finish in 5 minutes. Try again."
                : error instanceof Error
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

/**
 * Each provider's sign-in as it last said (T3 Code's way), so a send and
 * its hand-over ask neither Codex nor Claude. Rufi asks each at its start,
 * every 5 minutes, and on each sign-in or sign-out in Rufi, one ask per
 * provider at a time; only the first answer is waited for. One not signed
 * in is asked again at the next read, which doesn't wait for it, so a
 * sign-in outside Rufi shows soon.
 */
export function keptSignIns(
  providers: Partial<Record<Provider, ProviderSignIn>>,
  everyMs = KEEP_MS,
) {
  interface Kept {
    status: ProviderStatus;
    first: Promise<void>;
    /** The ask under way, if one is. */
    asking?: Promise<void>;
  }
  const kept = new Map<Provider, Kept>();
  const ask = (provider: Provider, one: Kept): Promise<void> => {
    one.asking ??= (
      providers[provider]?.status() ?? Promise.resolve(SIGNED_OUT)
    )
      .catch(unavailable)
      .then((status) => {
        one.status = status;
      })
      .finally(() => {
        one.asking = undefined;
      });
    return one.asking;
  };
  for (const provider of ["codex", "claude"] as const) {
    const one: Kept = { status: SIGNED_OUT, first: Promise.resolve() };
    one.first = ask(provider, one);
    kept.set(provider, one);
  }
  const timer = setInterval(() => {
    for (const [provider, one] of kept) void ask(provider, one);
  }, everyMs);
  timer.unref();
  return {
    /** The provider's sign-in as it last said. */
    status: async (provider: Provider): Promise<ProviderStatus> => {
      const one = kept.get(provider);
      if (!one) return SIGNED_OUT;
      await one.first;
      if (one.status.state !== "signed_in") void ask(provider, one);
      return one.status;
    },
    /** Asks it again once any ask under way has ended; resolves once it said. */
    refresh: async (provider: Provider): Promise<void> => {
      const one = kept.get(provider);
      if (!one) return;
      await one.asking;
      await ask(provider, one);
    },
    close: () => {
      clearInterval(timer);
    },
  };
}

const SIGNED_OUT: ProviderStatus = {
  state: "signed_out",
  account: null,
  text: null,
};

/** What a provider's sign-in says when Rufi can't ask it. */
const unavailable = (error: unknown): ProviderStatus => ({
  state: "unavailable",
  account: null,
  text: error instanceof Error ? error.message : String(error),
});

/**
 * Codex's sign-in, as Codex reports it; its own ChatGPT sign-in, opened in
 * the browser.
 */
export const codexSignIn = (
  codex: Pick<CodexAdapter, "account" | "signIn">,
  openBrowser: (link: string) => void,
): ProviderSignIn => ({
  status: () =>
    codex
      .account()
      .then(
        ({ signedIn, email }): ProviderStatus =>
          signedIn
            ? { state: "signed_in", account: email, text: null }
            : { state: "signed_out", account: null, text: null },
        unavailable,
      ),
  start: async ({ showLink, signal }) => {
    const { link, done } = await codex.signIn(signal);
    showLink(link);
    openBrowser(link);
    await done;
  },
});

/**
 * Claude's sign-in, as Claude reports it; `claude auth login`. `env` names
 * Claude's folder (claudeEnvironment).
 */
export const claudeSignIn = (env: Record<string, string>): ProviderSignIn => ({
  status: () =>
    findClaude()
      .then((claude) => claudeSignedIn(claude, env))
      .then(
        (signedIn): ProviderStatus => ({
          state: signedIn ? "signed_in" : "signed_out",
          account: null,
          text: null,
        }),
        unavailable,
      ),
  start: async (handlers) => {
    await claudeLogIn(await findClaude(), env, handlers);
  },
});
