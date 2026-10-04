// The Rufi app (apps/desktop) runs `rufi start` with a private channel to it:
// Node's IPC channel, never the terminal, so no link is printed. The start
// command answers on it once: owned (it runs Rufi), attached (another Rufi
// runs) or failed. An owned Rufi then gives the app a fresh link for each new
// window. When the channel closes, because the app quits or dies, an owned
// Rufi stops as it does with Ctrl-C.
import { FromApp, type ToApp } from "@rufi/contracts/app";
import { Effect, Schema } from "effect";

export interface AppChannel {
  /** Sends one message; done when it has gone, or when the app is gone. */
  send: (message: ToApp) => Effect.Effect<void>;
  /** Answers the app's link requests until the channel closes. */
  serve: (link: () => string) => Effect.Effect<void>;
}

const isLinkRequest = Schema.is(FromApp);

/**
 * Sends `message` if the app is there. A failed send only means the app is
 * gone, which the channel's closing reports.
 */
function post(message: ToApp, sent: () => void = () => undefined): void {
  if (process.send === undefined || !process.connected) {
    sent();
    return;
  }
  process.send(message, undefined, {}, sent);
}

/** The channel when the app started this command; undefined in a terminal. */
export function appChannel(): AppChannel | undefined {
  if (process.send === undefined) return undefined;
  return {
    send: (message) =>
      Effect.callback<undefined>((resume) => {
        post(message, () => {
          resume(Effect.succeed(undefined));
        });
      }),
    serve: (link) =>
      Effect.callback<undefined>((resume) => {
        const onMessage = (message: unknown) => {
          if (isLinkRequest(message)) post({ type: "link", url: link() });
        };
        const onClose = () => {
          resume(Effect.succeed(undefined));
        };
        process.on("message", onMessage);
        process.once("disconnect", onClose);
        if (!process.connected) onClose();
        return Effect.sync(() => {
          process.off("message", onMessage);
          process.off("disconnect", onClose);
        });
      }),
  };
}

/** Closes the channel, so this command can end once its work is done. */
export function closeAppChannel(): void {
  if (process.connected) process.disconnect();
}
