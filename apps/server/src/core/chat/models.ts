// Rufi's four models (MODELS, in the contracts): the one a new chat starts
// on, and why a model can't run, for the person and for agents alike.
import { MODELS } from "@rufi/contracts";

/** A new chat's model. */
export const DEFAULT_MODEL: string = MODELS[0].id;

/** A model that isn't one of the four. */
export const NOT_A_MODEL =
  "That model isn't one of Rufi's: GPT-6-Astra, GPT-6.1-Sol, Claude Fable 5.1 or Claude Opus 5.5.";

/** A model whose provider isn't signed in, for the agent that asked for it. */
export const notSignedIn = (provider: string) =>
  provider === "claude"
    ? "Claude isn't signed in, so its models can't run now."
    : "ChatGPT isn't signed in, so its models can't run now.";

/** A chat's model whose provider Rufi doesn't know: nothing goes. */
export const UNKNOWN_PROVIDER =
  "Rufi doesn't know which AI runs this chat's model. Choose the model again in the menu.";
