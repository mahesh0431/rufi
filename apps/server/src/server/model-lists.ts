// Each provider's models, kept from its last answer (T3 Code's way): the
// model menu, Settings, list_models and start_agent read them, so none of
// them starts a provider's process to ask. Rufi asks each provider at its
// start, after a sign-in and every 5 minutes, one ask per provider at a
// time. A provider that couldn't say is asked again at the next read,
// which doesn't wait for it: one slow or signed out never holds up the
// other's list. Only the first answers are waited for.
import type { ProviderAdapter } from "@rufi/agents/provider";
import type { OfferedModel } from "./rufi-ai.ts";

/** How often Rufi asks the providers again. */
const EVERY_MS = 5 * 60_000;

/** What a provider said last: its models, or why it couldn't say. */
interface Said {
  models?: OfferedModel[];
  failure?: unknown;
  /** The ask under way, if one is. */
  asking?: Promise<void>;
  /** Its first ask. */
  first: Promise<void>;
}

export function modelLists(
  adapters: readonly ProviderAdapter[],
  everyMs = EVERY_MS,
) {
  /** Asks the provider, unless it is being asked now. */
  const ask = (adapter: ProviderAdapter, kept: Said): Promise<void> => {
    kept.asking ??= adapter
      .models()
      .then(
        (models) => {
          kept.models = models.map(({ id, name, efforts, defaultEffort }) => ({
            id,
            name,
            provider: adapter.id,
            efforts,
            ...(defaultEffort !== undefined && { defaultEffort }),
          }));
          kept.failure = undefined;
        },
        (error: unknown) => {
          kept.models = undefined;
          kept.failure = error;
        },
      )
      .finally(() => {
        kept.asking = undefined;
      });
    return kept.asking;
  };
  const providers = adapters.map((adapter) => {
    const kept: Said = { first: Promise.resolve() };
    kept.first = ask(adapter, kept);
    return { adapter, kept };
  });
  const timer = setInterval(() => {
    for (const { adapter, kept } of providers) void ask(adapter, kept);
  }, everyMs);
  timer.unref();

  return {
    /**
     * Every provider's models as it last said; one that couldn't say is
     * left out, unless none could.
     */
    models: async (): Promise<OfferedModel[]> => {
      await Promise.all(providers.map(({ kept }) => kept.first));
      for (const { adapter, kept } of providers) {
        if (kept.failure !== undefined) void ask(adapter, kept);
      }
      const failed = providers.find(({ kept }) => kept.failure !== undefined);
      if (failed && providers.every(({ kept }) => kept.models === undefined)) {
        throw failed.kept.failure;
      }
      return providers.flatMap(({ kept }) => kept.models ?? []);
    },
    /**
     * Asks the provider again once any ask under way has ended, as after
     * its sign-in; resolves once it said.
     */
    refresh: async (provider: string): Promise<void> => {
      const found = providers.find(({ adapter }) => adapter.id === provider);
      if (!found) return;
      await found.kept.asking;
      await ask(found.adapter, found.kept);
    },
    close: () => {
      clearInterval(timer);
    },
  };
}
