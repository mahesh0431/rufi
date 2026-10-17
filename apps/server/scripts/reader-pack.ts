// The reader's fictional copy set (tests/pack/copy-set.ts, five pages in
// two files), read by the real reader (core/documents/copy-reader.ts) and
// judged against its key. --runs n reads it n times, one round after
// another, and writes each copy to the output folder. Whether a copy is
// faithful is a judgement, so an AI judge (copy-judge.ts) gives each row of
// each copied page a verdict against its key; code counts only the facts
// (pages copied, rows on pages with no copy) and the verdicts. --judge
// <folder> judges the copies saved by an earlier run again, with no new
// reading. Only the sign-in comes from RUFI_HOME (the test sign-in). Each
// file is read on its own scratch data folder, person and reader, with the
// reader's default model and effort unless --model or --effort says
// otherwise. Rufi AI's sorting is not part of it: the live story test sorts.
// A file's data folder goes once its reading is done; one whose reading
// failed stays in the Mac's temporary folder, and the report names it. The
// judge's goes the same way.
//
//   RUFI_HOME=<test sign-in folder> node apps/server/scripts/reader-pack.ts [--runs n] [--model id] [--effort level] [--out empty-dir]
//   RUFI_HOME=<test sign-in folder> node apps/server/scripts/reader-pack.ts --judge <folder of round-n copies> [--out empty-dir]
//   node apps/server/scripts/reader-pack.ts --make <dir>    (only writes the set's files and keys)
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect } from "effect";
import type { ChatGptDeps } from "../src/agent/chatgpt/openai.ts";
import { accessToken } from "../src/agent/chatgpt/session.ts";
import { codexBinary } from "../src/agent/codex/binary.ts";
import { subAgentRunner } from "../src/agent/codex/subagent.ts";
import { transcripts as openTranscripts } from "../src/core/chat/transcript.ts";
import { documents, type NewFile } from "../src/core/documents/documents.ts";
import { copies } from "../src/core/documents/copies.ts";
import { copyReader } from "../src/core/documents/copy-reader.ts";
import { pages } from "../src/core/documents/pages.ts";
import { readings } from "../src/core/documents/reading.ts";
import { databasePath, openWritable } from "../src/core/store/database.ts";
import { childEnvironment, rufiHome } from "../src/platform/config.ts";
import { Secrets, secretsLayer } from "../src/platform/keychain.ts";
import { diagnostics } from "../src/platform/logs.ts";
import { reader, READER_SETTING, readerChoice } from "../src/server/reader.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "../src/server/mcp.ts";
import { copySetFiles, KEY } from "../tests/pack/copy-set.ts";
import { onScratch, outFolder, runAll, sharedToken } from "./live-run.ts";
import {
  JUDGE,
  judgePage,
  tally,
  type JudgeDeps,
  type PageResult,
} from "./copy-judge.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    make: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    runs: { type: "string", default: "1" },
    judge: { type: "string" },
  },
});

if (values.make !== undefined) {
  await mkdir(values.make, { recursive: true });
  for (const file of Object.values(await copySetFiles())) {
    await writeFile(join(values.make, file.name), file.bytes);
  }
  for (const key of KEY) {
    await writeFile(
      join(values.make, `${key.file}-${String(key.page)}.key.md`),
      key.hand,
    );
  }
  console.log(`Copy set written to ${values.make}`);
  process.exit(0);
}

// --- Read the set with the real reader: each file on its own data
// folder, store, person and reader ---

const signIn: ChatGptDeps = {
  home: rufiHome(),
  secrets: await Effect.runPromise(
    Effect.provide(Effect.service(Secrets), secretsLayer),
  ),
  issuer: "https://auth.openai.com",
  sleep: (ms) => sleep(ms),
};
/** One token source for every reader of the run. */
const token = sharedToken((validForMs) => accessToken(signIn, validForMs));
// The sign-in once before any reading starts: a run that can't sign in
// stops here.
await token(10 * 60_000).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
/** The reader's model and effort for every document of the run. */
const choice = await readerChoice((key) =>
  Promise.resolve(
    key === READER_SETTING.model
      ? values.model
      : key === READER_SETTING.effort
        ? values.effort
        : undefined,
  ),
);
if (
  (values.model !== undefined && values.model !== choice.model) ||
  (values.effort !== undefined && values.effort !== choice.effort)
) {
  console.error(
    `The reader doesn't run on ${values.model ?? choice.model}, ${values.effort ?? choice.effort}.`,
  );
  process.exit(2);
}
const out = await outFolder("pack", values.out);
const file = await codexBinary();
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

/**
 * Reads files added as one document, on the scratch data folder `home`,
 * with the reader that copies, until its reading ends. The caller closes
 * the store.
 */
async function readFiles(home: string, files: NewFile[]) {
  const store = openWritable(databasePath(home));
  const transcripts = openTranscripts(store);
  const person = await transcripts.addFirstPerson("Asha Fictional");
  const reads = readings(store);
  const { log } = diagnostics(home);
  // Rufi's MCP server for the reader's tools, as the core serves it.
  const keys = mcpKeys();
  let port = 0;
  const served = await serveMcp(mcpEndpoint({ keys, port: () => port, log }));
  port = served.port;
  const running = reader({
    readings: reads,
    kind: copyReader(pages(store, home), copies(store)),
    event: async (id, event, write) => {
      const chat = await transcripts.chat(id);
      if (!chat) throw new Error("No chat.");
      await transcripts.addEvent(chat, event, write);
    },
    run: subAgentRunner({
      home,
      command: { file, args: [] },
      env: childEnvironment(),
      token,
      version,
      log,
    }),
    // Rufi AI doesn't sort here: the pack judges the copies only.
    sort: () => Promise.resolve(),
    choice: () => Promise.resolve(choice),
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp/reader`, keys },
    log,
  });
  const { added } = await documents(store, home, undefined, reads).add(
    person?.id ?? "",
    files,
    true,
  );
  const documentId = added[0] ?? "";
  reads.watch(running.poke);
  running.start();
  const state = () =>
    (
      store.db
        .prepare("SELECT state FROM jobs WHERE document_id = ?")
        .get(documentId) as { state: string } | undefined
    )?.state;
  const started = Date.now();
  while (state() === "queued" || state() === "running") {
    if (Date.now() - started > 3 * 60 * 60_000) break;
    await sleep(2_000);
  }
  await running.close();
  await served.close();
  return { store, documentId };
}

if (values.judge !== undefined) {
  await judgeSaved(values.judge);
  process.exit(0);
}
await readCopies(Number(values.runs));

/** A round of the copy set: what the reader did, and each page's copy. */
interface Round {
  name: string;
  lines: string[];
  pages: PageResult[];
}

/**
 * Reads the copy set `runs` times, a round after another (each round's two
 * files at once), writes each copy to the output folder, has the judge give
 * its verdicts on every copy, and reports every round.
 */
async function readCopies(runs: number) {
  if (!Number.isInteger(runs) || runs < 1) {
    console.error("--runs takes a whole number of rounds, 1 or more.");
    process.exit(2);
  }
  const files = await copySetFiles();
  const begun = Date.now();
  const rounds: Round[] = [];
  for (let round = 1; round <= runs; round++) {
    const results = await runAll(
      ["mixed", "photo"],
      undefined,
      async (name) => {
        const { result, kept } = await onScratch(
          "rufi-pack-",
          async (home) => {
            const { store, documentId } = await readFiles(home, [
              name === "mixed" ? files.mixed : files.photo,
            ]);
            let read: ReturnType<typeof copiesOf>;
            try {
              read = copiesOf(store, documentId);
            } finally {
              store.close();
            }
            // The copies are in the output folder before the data folder goes.
            const folder = join(out, `round-${String(round)}`);
            for (const key of KEY.filter((k) => k.file === name)) {
              const copy = read.saved.find((c) => c.position === key.page);
              if (!copy) continue;
              await mkdir(folder, { recursive: true });
              await writeFile(
                join(folder, `${name}-${String(key.page)}.md`),
                copy.copy,
              );
            }
            return read;
          },
          ({ job }) => job.state === "done",
        );
        return { ...result, kept };
      },
    );
    const done: Round = {
      name: `Round ${String(round)}`,
      lines: [],
      pages: [],
    };
    for (const name of ["mixed", "photo"] as const) {
      const keys = KEY.filter((k) => k.file === name);
      const result = results.get(name);
      if (result?.status !== "fulfilled") {
        done.lines.push(
          `- ${name}: the harness failed: ${String(result?.reason)}`,
        );
        done.pages.push(...keys.map((key) => ({ key, copy: undefined })));
        continue;
      }
      const { job, saved, kept } = result.value;
      const ms =
        job.started_at && job.ended_at
          ? Date.parse(job.ended_at) - Date.parse(job.started_at)
          : 0;
      const usage = job.usage
        ? (JSON.parse(job.usage) as { totalTokens: number; looks: number })
        : undefined;
      done.lines.push(
        `- ${name}: ${job.state}${job.error ? ` (${job.error})` : ""} · ${String(saved.length)} pages copied · ${saved.length > 0 ? (ms / saved.length / 1000).toFixed(1) : "—"} s a page · ${usage ? `${String(usage.totalTokens)} tokens, ${String(usage.looks)} looks` : "—"}${kept === undefined ? "" : ` · data folder: ${kept}`}`,
      );
      for (const key of keys) {
        const copy = saved.find((c) => c.position === key.page);
        done.pages.push({ key, copy: copy?.copy });
      }
    }
    rounds.push(done);
  }
  await judgeAll(rounds);
  await writeCopyReport(
    `# Reader pack: the copy set, ${new Date(begun).toISOString()}`,
    `Reader: the reader that copies, ${choice.model}, ${choice.effort}. ${String(runs)} ${runs === 1 ? "round" : "rounds"}, one after another; wall time ${String(Math.round((Date.now() - begun) / 1000))} s. Each copy is in this folder, by round.`,
    rounds,
  );
}

/**
 * Has the judge give its verdicts again on copies saved by an earlier run
 * (a folder of round-n folders of <file>-<page>.md), with no new reading.
 * A page with no file there counts as not copied.
 */
async function judgeSaved(folder: string) {
  const names = (await readdir(folder, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^round-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  if (names.length === 0) {
    console.error(`${folder} has no round-n folders of copies.`);
    process.exit(2);
  }
  const rounds: Round[] = [];
  for (const name of names) {
    const pages: PageResult[] = [];
    for (const key of KEY) {
      const copy = await readFile(
        join(folder, name, `${key.file}-${String(key.page)}.md`),
        "utf8",
      ).catch(() => undefined);
      pages.push({ key, copy });
    }
    rounds.push({ name: `Round ${name.slice(6)}`, lines: [], pages });
  }
  const begun = Date.now();
  await judgeAll(rounds);
  await writeCopyReport(
    `# Reader pack: the copy set judged again, ${new Date(begun).toISOString()}`,
    `The copies in ${folder}, judged again; no new reading.`,
    rounds,
  );
}

/**
 * Has the judge give its verdicts on every copied page of the rounds. Its
 * data folder holds only the log of Rufi's MCP server for the judge.
 */
async function judgeAll(rounds: readonly Round[]) {
  await onScratch(
    "rufi-judge-",
    (home) => judgeOn(home, rounds),
    () => true,
  );
}

async function judgeOn(home: string, rounds: readonly Round[]) {
  const { log } = diagnostics(home);
  const keys = mcpKeys();
  let port = 0;
  const served = await serveMcp(mcpEndpoint({ keys, port: () => port, log }));
  port = served.port;
  const deps: JudgeDeps = {
    run: (judgeHome) =>
      subAgentRunner({
        home: judgeHome,
        command: { file, args: [] },
        env: childEnvironment(),
        token,
        version,
        log,
      }),
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp/judge`, keys },
    log,
  };
  const copied = rounds.flatMap((r) =>
    r.pages.filter((p) => p.copy !== undefined),
  );
  try {
    await runAll(
      copied.map((_, i) => String(i)),
      // Copies the judge reads at once.
      4,
      async (i) => {
        const page = copied[Number(i)];
        if (page?.copy === undefined) return;
        page.judged = await judgePage(deps, page.key, page.copy);
        console.log(
          `judged ${page.key.file} page ${String(page.key.page)}${"failed" in page.judged ? `: ${page.judged.failed}` : ""}`,
        );
      },
    );
  } finally {
    await served.close();
  }
}

/** Writes the report of the rounds' copies and verdicts to the output folder. */
async function writeCopyReport(
  title: string,
  about: string,
  rounds: readonly Round[],
) {
  const totals = tally(rounds.flatMap((r) => r.pages));
  /** Rows with a hard part, verdict by round. */
  const hard = new Map<string, string[]>();
  const forPerson: string[] = [];
  const lines: string[] = [];
  for (const round of rounds) {
    lines.push(`## ${round.name}`, "", ...round.lines);
    for (const { key, copy, judged } of round.pages) {
      const where = `${key.file} page ${String(key.page)}`;
      if (copy === undefined) {
        lines.push(
          `- ${where}: no copy (its ${String(key.rows.length)} rows count as missed)`,
        );
        continue;
      }
      if (judged === undefined || "failed" in judged) {
        const why = judged?.failed ?? "not judged";
        lines.push(
          `- ${where}: no verdicts (${why}); its rows count as unsure`,
        );
        forPerson.push(`- ${round.name}, ${where}: no verdicts (${why})`);
        continue;
      }
      const one = tally([{ key, copy, judged }]);
      lines.push(
        `- ${where}: ${String(one.same)} same · ${String(one.changedMarked)} changed and marked · ${String(one.changedSilently)} changed silently · ${String(one.missed)} missing · ${String(one.unsure)} unsure · ${String(one.notInKey)} not in the key`,
        ...judged.rows
          .filter((r) => r.verdict !== "same")
          .map(
            (r) => `  - ${r.label}: ${r.verdict}${r.why ? ` — ${r.why}` : ""}`,
          ),
        ...judged.notInKey.map(
          (v) => `  - not in the key: ${v.value} — ${v.where}`,
        ),
      );
      for (const r of judged.rows) {
        if (r.verdict === "unsure")
          forPerson.push(
            `- ${round.name}, ${where}, ${r.label}: ${r.why ?? "unsure"}`,
          );
        if (key.doubts.some((d) => d.row === r.label))
          hard.set(r.label, [...(hard.get(r.label) ?? []), r.verdict]);
      }
    }
    lines.push("");
  }
  const text = [
    title,
    "",
    about,
    "",
    `Judge: ${JUDGE.model}, ${JUDGE.effort}, one turn for each copied page, with the page's hand-checked copy and the rows it must hold.`,
    "",
    `**Silent errors: ${String(totals.silent)}** (${String(totals.changedSilently)} rows changed silently, ${String(totals.notInKey)} values not in the key). **Unsure, for a person: ${String(totals.unsure)} rows.**`,
    "",
    `Totals: ${String(totals.pages)} pages (${String(totals.copied)} copied), ${String(totals.rows)} rows: ${String(totals.same)} same, ${String(totals.changedMarked)} changed and marked, ${String(totals.changedSilently)} changed silently, ${String(totals.missed)} missed, ${String(totals.unsure)} unsure.`,
    "",
    "The key holds chosen rows of each page (every test row, the report's names, numbers and dates), not every word.",
    "",
    "Rows with a hard part, round by round:",
    ...[...hard].map(([row, verdicts]) => `- ${row}: ${verdicts.join(" · ")}`),
    "",
    "For a person:",
    ...(forPerson.length > 0 ? forPerson : ["- nothing"]),
    "",
    ...lines,
  ].join("\n");
  await writeFile(join(out, "report.md"), `${text}\n`);
  console.log(text);
}

/** A document's latest reading and its page copies, by position. */
function copiesOf(store: ReturnType<typeof openWritable>, documentId: string) {
  const job = store.db
    .prepare(
      "SELECT id, state, error, started_at, ended_at, usage FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(documentId) as {
    id: string;
    state: string;
    error: string | null;
    started_at: string | null;
    ended_at: string | null;
    usage: string | null;
  };
  const saved = store.db
    .prepare(
      `SELECT p.position, c.outcome, c.copy FROM page_copies c
       JOIN document_pages p ON p.person_id = c.person_id AND p.file_id = c.file_id AND p.page_in_file = c.page_in_file
       WHERE p.document_id = ? AND c.job_id = ? ORDER BY p.position`,
    )
    .all(documentId, job.id) as {
    position: number;
    outcome: string;
    copy: string;
  }[];
  return { job, saved };
}
