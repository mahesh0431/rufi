// Which of the provider's models Rufi may use: an allowlist file in the data
// folder that the user can edit. Rufi starts it with the strongest models.
import { join } from "node:path";
import { Result, Schema } from "effect";
import { readJson, writePrivateJson } from "../../platform/files.ts";

/** The strongest models today; the first is the default for a new conversation. */
export const DEFAULT_ALLOWLIST = ["gpt-6-astra", "gpt-6.1-sol"];

const File = Schema.Struct({
  models: Schema.Array(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1)),
  ).check(Schema.isMinLength(1)),
});

export interface Allowlist {
  /** The models allowed, in the file's order. */
  models: readonly string[];
  /** Why the file couldn't be used; the last good list stands meanwhile. */
  error?: string;
}

/** `models.json` in the data folder, read on every use. */
export function allowlistFile(home: string) {
  const path = join(home, "models.json");
  let lastGood: readonly string[] = DEFAULT_ALLOWLIST;
  return {
    path,
    read: async (): Promise<Allowlist> => {
      let raw: unknown;
      try {
        raw = await readJson(path);
      } catch (error) {
        return {
          models: lastGood,
          error: `${path} isn't valid JSON: ${errorText(error)}`,
        };
      }
      if (raw === undefined) {
        await writePrivateJson(path, { models: DEFAULT_ALLOWLIST });
        lastGood = DEFAULT_ALLOWLIST;
        return { models: lastGood };
      }
      const parsed = Schema.decodeUnknownResult(File)(raw);
      if (Result.isFailure(parsed)) {
        return {
          models: lastGood,
          error: `${path} needs a list of model names, like {"models": ["${DEFAULT_ALLOWLIST[0] ?? ""}"]}.`,
        };
      }
      lastGood = parsed.success.models;
      return { models: lastGood };
    },
  };
}

function errorText(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? cause.message : "it can't be read";
}

/** The provider's models that are allowed, in the allowlist's order. */
export function allowedModels<M extends { id: string }>(
  offered: readonly M[],
  allowlist: readonly string[],
): M[] {
  return allowlist.flatMap((id) => offered.filter((model) => model.id === id));
}
