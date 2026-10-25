// `pnpm rufi device-source` and `device-import`: the test tool that puts
// device data in while Rufi is closed (docs/help/device-data.md). An import
// file has one batch per line, as the phone will send it; each is received
// as the phone's would be, and converted when Rufi next starts.
import { createReadStream } from "node:fs";
import {
  MAX_BATCH_BYTES,
  MAX_ENTRIES,
  type Devices,
  type Problem,
  type SourceSummary,
} from "../core/devices/devices.ts";

const SYSTEM_NAMES = { apple_health: "Apple Health" } as const;

const PROBLEMS: Record<Problem, string> = {
  no_such_source:
    "Rufi has no device source with that ID (pnpm rufi device-source list shows them)",
  too_big: `it is bigger than ${String(MAX_BATCH_BYTES / 1024 / 1024)} MB`,
  not_json: "it isn't JSON",
  no_batch_id: "it has no batch ID",
  lists_missing: "it needs a values list and a deleted list",
  too_many_entries: `it has more than ${MAX_ENTRIES.toLocaleString("en")} values and deletions`,
  batch_id_reused: "its batch ID came before with other content",
};

/**
 * The file's lines as bytes, without their line ends; a line over `max`
 * bytes is reported as too big and never held whole.
 */
async function* lines(
  path: string,
  max: number,
): AsyncGenerator<Uint8Array | "too_big"> {
  // The line so far: its parts, or only that it is too big.
  const line = { parts: [] as Buffer[], size: 0, tooBig: false };
  const take = (part: Buffer) => {
    if (line.tooBig || part.length === 0) return;
    line.size += part.length;
    if (line.size > max) {
      line.tooBig = true;
      line.parts = [];
    } else line.parts.push(part);
  };
  const end = () => {
    const whole = line.tooBig ? "too_big" : Buffer.concat(line.parts);
    Object.assign(line, { parts: [], size: 0, tooBig: false });
    return whole;
  };
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, from)) {
      take(chunk.subarray(from, at));
      yield end();
      from = at + 1;
    }
    take(chunk.subarray(from));
  }
  if (line.size > 0 || line.tooBig) yield end();
}

const blank = (line: Uint8Array) =>
  line.every((byte) => byte === 32 || byte === 9 || byte === 13);

/**
 * Receives each line of the file as one batch from the source, and prints
 * what Rufi answered; stops at the first refusal. False when it stopped.
 */
export async function importBatches(
  devices: Pick<Devices, "receive">,
  sourceId: string,
  path: string,
  print: (line: string) => void,
): Promise<boolean> {
  let number = 0;
  let got = 0;
  let had = 0;
  for await (const line of lines(path, MAX_BATCH_BYTES)) {
    number++;
    if (line !== "too_big" && blank(line)) continue;
    const receipt =
      line === "too_big"
        ? ({ answer: "refused", problems: ["too_big"] } as const)
        : await devices.receive(sourceId, line);
    if (receipt.answer === "refused") {
      print(
        `Line ${String(number)}: refused: ${receipt.problems.map((problem) => PROBLEMS[problem]).join("; ")}.`,
      );
      print(
        `Stopped there. ${String(got)} new, ${String(had)} already got. Fix the line and run the import again: what came before is kept.`,
      );
      return false;
    }
    if (receipt.answer === "got_it") got++;
    else had++;
    print(
      `Line ${String(number)}: ${receipt.answer === "got_it" ? "got it" : "already got"}.`,
    );
  }
  print(
    `Done: ${String(got)} new, ${String(had)} already got. Start Rufi to convert them.`,
  );
  return true;
}

/** One source as `device-source list` prints it. */
export const sourceLine = (
  source: Pick<
    SourceSummary,
    "id" | "name" | "system" | "person" | "values" | "waiting"
  >,
) =>
  `${source.id}  ${source.name} (${SYSTEM_NAMES[source.system]}) for ${source.person.name}: ${String(source.values)} values, ${String(source.waiting)} batches waiting`;

export const peopleLines = (people: readonly { id: string; name: string }[]) =>
  people.length === 0
    ? ["No one is in this data folder yet. Start Rufi and add someone first."]
    : [
        "Name the person with --person <id>. In this data folder:",
        ...people.map((person) => `  ${person.id}  ${person.name}`),
      ];
