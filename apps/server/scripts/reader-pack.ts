// The reader's fictional test pack, read by the real reader and scored
// against its answer key: items missed, wrong values (the printed text, the
// number or the comparator) not marked unsure, wrong person or date, time
// per page, and the question for the chat AI, for a person to judge. The numbers are for the bar the
// person sets before dogfood, not pass or fail. Only the sign-in comes from
// RUFI_HOME (the test sign-in). Every document is read at the same time,
// each on its own scratch data folder, person and reader, with the reader's
// default model and effort unless --model or --effort says otherwise. By
// default it reads a small dense set: two pages each of the densest reports,
// as a PDF and as photos. --all reads the whole pack (long and many
// documents, about 20 minutes); --only names the documents to read, from
// either.
//
//
// --copies reads the copy set (tests/pack/copy-set.ts, five pages in two
// files) with the reader that copies (core/documents/copy-reader.ts);
// --runs n reads it n times, one round after another, and writes each copy
// to the output folder. Whether a copy is faithful is a judgement, so an
// AI judge (copy-judge.ts) gives each row of each copied page a verdict
// against its key; code counts only the facts (pages copied, rows on pages
// with no copy) and the verdicts. --judge <folder> judges the copies saved
// by an earlier run again, with no new reading.
//
//   RUFI_HOME=<test sign-in folder> node apps/server/scripts/reader-pack.ts [--all | --only a,b] [--model id] [--effort level] [--out empty-dir]
//   RUFI_HOME=<test sign-in folder> node apps/server/scripts/reader-pack.ts --copies [--runs n] [--model id] [--effort level] [--out empty-dir]
//   RUFI_HOME=<test sign-in folder> node apps/server/scripts/reader-pack.ts --judge <folder of round-n copies> [--out empty-dir]
//   node apps/server/scripts/reader-pack.ts [--copies] --make <dir>    (only writes the pack's files)
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
import { notebook, type Entry } from "../src/core/documents/notebook.ts";
import { pages } from "../src/core/documents/pages.ts";
import {
  entryReader,
  type ReaderKind,
} from "../src/core/documents/reader-tools.ts";
import { readings } from "../src/core/documents/reading.ts";
import {
  databasePath,
  openWritable,
  type Store,
} from "../src/core/store/database.ts";
import { childEnvironment, rufiHome } from "../src/platform/config.ts";
import { Secrets, secretsLayer } from "../src/platform/keychain.ts";
import { diagnostics } from "../src/platform/logs.ts";
import { reader, READER_SETTING, readerChoice } from "../src/server/reader.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "../src/server/mcp.ts";
import { drawn, photo, scan } from "../tests/pack/images.ts";
import { copySetFiles, KEY } from "../tests/pack/copy-set.ts";
import { scanPdf, textPdf } from "../tests/pack/pdf.ts";
import {
  BUNDLE,
  expected,
  layout,
  PRESCRIPTION,
  REPORTS,
  type Report,
} from "../tests/pack/reports.ts";
import { outFolder, runAll, sharedToken } from "./live-run.ts";
import { chooseItems, norm, scoreItems, type Draft } from "./reader-score.ts";
import {
  JUDGE,
  judgePage,
  tally,
  type JudgeDeps,
  type PageResult,
} from "./copy-judge.ts";

const { values } = parseArgs({
  options: {
    all: { type: "boolean", default: false },
    only: { type: "string" },
    out: { type: "string" },
    make: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    copies: { type: "boolean", default: false },
    runs: { type: "string", default: "1" },
    judge: { type: "string" },
  },
});

const report = (name: string): Report => {
  const found = REPORTS[name];
  if (!found) throw new Error(`No report ${name}`);
  return found;
};
const pdfOf = (reports: readonly Report[]) => textPdf(reports.flatMap(layout));

interface Item {
  name: string;
  /** What kind of file it is, for the numbers by kind. */
  kind: "pdf" | "scan" | "photo" | "png";
  files: () => Promise<NewFile[]>;
  key: ReturnType<typeof expected>;
}

/** The first `n` pages of a report's answer key. */
const firstPages = (r: Report, n: number) => {
  const key = expected([r]);
  return {
    items: key.items.filter((i) => i.page <= n),
    pages: key.pages.slice(0, n),
  };
};

const pdfItem = (name: string): Item => ({
  name,
  kind: "pdf",
  files: () =>
    Promise.resolve([{ name: `${name}.pdf`, bytes: pdfOf([report(name)]) }]),
  key: expected([report(name)]),
});

/** The first `n` pages of a report as a text PDF. */
const firstPagesPdf = (name: string, n: number): Item => ({
  name: `${name}_${String(n)}_pages`,
  kind: "pdf",
  files: () =>
    Promise.resolve([
      {
        name: `${name}-${String(n)}-pages.pdf`,
        bytes: textPdf(layout(report(name)).slice(0, n)),
      },
    ]),
  key: firstPages(report(name), n),
});

/** The first `n` pages of a report, each a photo-like JPEG of its own. */
const photosItem = (itemName: string, name: string, n: number): Item => ({
  name: itemName,
  kind: "photo",
  files: async () => {
    const pdf = pdfOf([report(name)]);
    const out: NewFile[] = [];
    for (let p = 1; p <= n; p++) {
      out.push({
        name: `${name.replaceAll("_", "-")}-photo-${String(p)}.jpg`,
        bytes: await photo(await drawn(pdf, p), 10 + p),
      });
    }
    return out;
  },
  key: firstPages(report(name), n),
});

/** Page 1 of a report as a photo-like JPEG (or a plain PNG). */
const imageItem = (
  name: string,
  kind: "photo" | "png",
  seed: number,
): Item => ({
  name: `${name}_${kind}`,
  kind,
  files: async () => {
    const png = await drawn(pdfOf([report(name)]), 1);
    return [
      kind === "png"
        ? { name: `${name}.png`, bytes: png }
        : { name: `${name}.jpg`, bytes: await photo(png, seed) },
    ];
  },
  key: firstPages(report(name), 1),
});

/** A clinic's prescription with the visit's measurements, an undated height and a lab value. */
const prescription: Item = {
  name: "prescription",
  kind: "pdf",
  files: () =>
    Promise.resolve([
      { name: "prescription.pdf", bytes: textPdf(PRESCRIPTION.pages) },
    ]),
  key: PRESCRIPTION.key,
};

const PACK: Item[] = [
  ...[
    "cbc",
    "lipids",
    "thyroid",
    "urine",
    "liver_dense",
    "comma",
    "amended",
    "ambiguous_date",
    "other_name",
    "name_variant",
    "five_pages",
    "eight_pages",
    "big_300",
  ].map(pdfItem),
  {
    name: "bundle",
    kind: "pdf",
    files: () =>
      Promise.resolve([{ name: "bundle.pdf", bytes: pdfOf(BUNDLE) }]),
    key: expected(BUNDLE),
  },
  imageItem("cbc", "photo", 1),
  imageItem("lipids", "photo", 2),
  imageItem("thyroid", "photo", 3),
  imageItem("urine", "photo", 4),
  imageItem("liver_dense", "png", 5),
  {
    name: "five_pages_scan",
    kind: "scan",
    files: async () => {
      const pdf = pdfOf([report("five_pages")]);
      const pagesOf = [];
      for (let p = 1; p <= 5; p++)
        pagesOf.push(await scan(await drawn(pdf, p)));
      return [{ name: "five_pages_scan.pdf", bytes: scanPdf(pagesOf) }];
    },
    key: expected([report("five_pages")]),
  },
  photosItem("eight_pages_photos", "eight_pages", 3),
  prescription,
];

/**
 * The default: two pages each of the densest reports (30 and 25 results a
 * page), as a PDF and as photos, and the prescription.
 */
const DENSE: Item[] = [
  firstPagesPdf("big_300", 2),
  photosItem("eight_pages_2_photos", "eight_pages", 2),
  prescription,
];

const only = values.only?.split(",");
const chosen = chooseItems(DENSE, PACK, {
  ...(only !== undefined && { only }),
  all: values.all,
});
/** Which set ran, for the report. */
const set =
  only !== undefined
    ? `the documents named: ${only.join(", ")}`
    : values.all
      ? "the whole pack (--all)"
      : "the small dense set (--all reads the whole pack)";

if (values.make !== undefined && values.copies) {
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
if (values.make !== undefined) {
  await mkdir(values.make, { recursive: true });
  for (const item of chosen) {
    for (const file of await item.files()) {
      await writeFile(join(values.make, file.name), file.bytes);
    }
    await writeFile(
      join(values.make, `${item.name}.key.json`),
      `${JSON.stringify(item.key, null, 2)}\n`,
    );
  }
  console.log(`Pack written to ${values.make}`);
  process.exit(0);
}

// --- Read the pack with the real reader: each document on its own data
// folder, store, person and reader, all at once ---

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
const totals = {
  pages: 0,
  expected: 0,
  correct: 0,
  missed: 0,
  wrongFlagged: 0,
  wrongSilent: 0,
  extra: 0,
  wrongItemDates: 0,
};
const byKind = new Map<string, typeof totals & { ms: number }>();

/** Reads one document with the real reader, then scores it. */
async function readOne(item: Item) {
  const { store, documentId, home } = await readFiles(
    await item.files(),
    (store, home) => entryReader(pages(store, home), notebook(store)),
  );
  try {
    return score(item, store, documentId, home);
  } finally {
    store.close();
  }
}

/**
 * Reads files added as one document, on a scratch data folder of its own,
 * with the reader `kind` makes, until its reading ends. The caller closes
 * the store.
 */
async function readFiles(
  files: NewFile[],
  kind: (store: Store, home: string) => ReaderKind,
) {
  const home = await mkdtemp(join(tmpdir(), "rufi-pack-"));
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
    kind: kind(store, home),
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
  return { store, documentId, home };
}

function score(
  item: Item,
  store: ReturnType<typeof openWritable>,
  documentId: string,
  home: string,
) {
  const rows: string[] = [];
  const job = store.db
    .prepare(
      "SELECT state, error, started_at, ended_at, usage FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(documentId) as {
    state: string;
    error: string | null;
    started_at: string | null;
    ended_at: string | null;
    usage: string | null;
  };
  const drafts = (
    store.db
      .prepare(
        "SELECT page, fields, unsure FROM draft_items WHERE document_id = ?",
      )
      .all(documentId) as { page: number; fields: string; unsure: string }[]
  ).map((d): Draft => ({
    page: d.page,
    fields: JSON.parse(d.fields) as Draft["fields"],
    unsure: (JSON.parse(d.unsure) as string[]).length > 0,
  }));
  const pageRows = store.db
    .prepare(
      "SELECT position, entry, state FROM document_pages WHERE document_id = ? ORDER BY position",
    )
    .all(documentId) as {
    position: number;
    entry: string | null;
    state: string | null;
  }[];
  const line = (
    store.db
      .prepare(
        "SELECT text FROM transcript_entries WHERE kind = 'event' AND details LIKE ? ORDER BY seq DESC LIMIT 1",
      )
      .get(`%${documentId}%`) as { text: string } | undefined
  )?.text;
  const asked = (
    store.db
      .prepare(
        "SELECT text FROM chat_queue WHERE origin = 'rufi' AND text LIKE ?",
      )
      .get(`%${documentId}%`) as { text: string } | undefined
  )?.text;

  const score = scoreItems(item.key.items, drafts);
  const { wrong, extra } = score;
  let wrongPerson = 0;
  let wrongDate = 0;
  let noDate = 0;
  for (const p of pageRows) {
    const keyPage = item.key.pages[p.position - 1];
    const entry = p.entry ? (JSON.parse(p.entry) as Entry) : undefined;
    if (!keyPage || !entry) continue;
    const name = entry.facts?.name;
    if (name !== undefined && norm(name) !== norm(keyPage.patient))
      wrongPerson++;
    const iso = entry.facts?.dates?.[0]?.iso;
    if (iso === undefined) noDate++;
    else if (keyPage.collectedIso === null || iso !== keyPage.collectedIso)
      wrongDate++;
  }
  const flags = {
    notLooked: pageRows.filter((p) => p.state === "not_looked_at").length,
    unreadable: pageRows.filter((p) => p.state === "unreadable").length,
  };
  const ms =
    job.started_at && job.ended_at
      ? Date.parse(job.ended_at) - Date.parse(job.started_at)
      : 0;
  const usage = job.usage
    ? (JSON.parse(job.usage) as { totalTokens: number; looks: number })
    : undefined;
  const pageCount = pageRows.length;
  totals.pages += pageCount;
  totals.expected += item.key.items.length;
  totals.correct += score.correct;
  totals.missed += score.missed;
  totals.wrongFlagged += score.wrongFlagged;
  totals.wrongSilent += score.wrongSilent;
  totals.extra += extra;
  totals.wrongItemDates += score.wrongItemDates;
  const kind = byKind.get(item.kind) ?? {
    pages: 0,
    expected: 0,
    correct: 0,
    missed: 0,
    wrongFlagged: 0,
    wrongSilent: 0,
    extra: 0,
    wrongItemDates: 0,
    ms: 0,
  };
  kind.pages += pageCount;
  kind.expected += item.key.items.length;
  kind.correct += score.correct;
  kind.missed += score.missed;
  kind.wrongFlagged += score.wrongFlagged;
  kind.wrongSilent += score.wrongSilent;
  kind.extra += extra;
  kind.wrongItemDates += score.wrongItemDates;
  kind.ms += ms;
  byKind.set(item.kind, kind);
  rows.push(
    [
      item.name,
      item.kind,
      job.state + (job.error ? ` (${job.error})` : ""),
      String(pageCount),
      String(item.key.items.length),
      String(score.correct),
      String(score.missed),
      String(score.wrongFlagged),
      String(score.wrongSilent),
      String(extra),
      String(score.wrongItemDates),
      String(wrongPerson),
      `${String(wrongDate)} / ${String(noDate)}`,
      `${String(flags.notLooked)} / ${String(flags.unreadable)}`,
      pageCount > 0 ? `${(ms / pageCount / 1000).toFixed(1)} s` : "—",
      usage ? `${String(usage.totalTokens)} / ${String(usage.looks)}` : "—",
      asked ? "yes" : "no",
      line ?? "—",
    ].join(" | "),
  );
  if (wrong.length > 0) rows.push(`  wrong: ${wrong.join("; ")}`);
  // For a person to judge: is each doubt real, and is a question about
  // whose report it is right?
  if (asked !== undefined) rows.push(`  asked: ${asked.replace(/\n/g, " / ")}`);
  rows.push(`  scratch data folder: ${home}`);
  return rows;
}

if (values.judge !== undefined) {
  await judgeSaved(values.judge);
  process.exit(0);
}
if (values.copies) {
  await readCopies(Number(values.runs));
  process.exit(0);
}

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
        const { store, documentId } = await readFiles(
          [name === "mixed" ? files.mixed : files.photo],
          (store, home) => copyReader(pages(store, home), copies(store)),
        );
        try {
          return copiesOf(store, documentId);
        } finally {
          store.close();
        }
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
      const { job, saved } = result.value;
      const ms =
        job.started_at && job.ended_at
          ? Date.parse(job.ended_at) - Date.parse(job.started_at)
          : 0;
      const usage = job.usage
        ? (JSON.parse(job.usage) as { totalTokens: number; looks: number })
        : undefined;
      done.lines.push(
        `- ${name}: ${job.state}${job.error ? ` (${job.error})` : ""} · ${String(saved.length)} pages copied · ${saved.length > 0 ? (ms / saved.length / 1000).toFixed(1) : "—"} s a page · ${usage ? `${String(usage.totalTokens)} tokens, ${String(usage.looks)} looks` : "—"}`,
      );
      for (const key of keys) {
        const copy = saved.find((c) => c.position === key.page);
        done.pages.push({ key, copy: copy?.copy });
        if (!copy) continue;
        const folder = join(out, `round-${String(round)}`);
        await mkdir(folder, { recursive: true });
        await writeFile(
          join(folder, `${name}-${String(key.page)}.md`),
          copy.copy,
        );
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

/** Has the judge give its verdicts on every copied page of the rounds. */
async function judgeAll(rounds: readonly Round[]) {
  const home = await mkdtemp(join(tmpdir(), "rufi-judge-"));
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

const started = Date.now();
const results = await runAll(
  chosen.map((item) => item.name),
  undefined,
  async (name) => {
    const item = chosen.find((i) => i.name === name);
    if (!item) throw new Error(`No item ${name}`);
    const lines = await readOne(item);
    console.log(lines[0]);
    return lines;
  },
);
const rows = chosen.flatMap((item) => {
  const result = results.get(item.name);
  return result?.status === "fulfilled"
    ? result.value
    : [`${item.name} | the harness failed: ${String(result?.reason)}`];
});

const text = [
  `# Reader pack, ${new Date(started).toISOString()}`,
  "",
  `Reader: ${choice.model}, ${choice.effort}.`,
  "",
  `${String(chosen.length)} documents at once, ${set}; wall time ${String(Math.round((Date.now() - started) / 1000))} s.`,
  "",
  "Columns: document | kind | outcome | pages | expected items | correct | missed | wrong, marked unsure | wrong, not marked | extra | items with a wrong date of their own | pages with another name | pages with a wrong / no date | pages not looked at / unreadable | time per page | tokens / looks | AI asked | end line",
  "",
  ...rows.map((r) => `- ${r}`),
  "",
  `Totals: ${String(totals.pages)} pages, ${String(totals.expected)} expected items, ${String(totals.correct)} correct, ${String(totals.missed)} missed, ${String(totals.wrongFlagged)} wrong but marked unsure, ${String(totals.wrongSilent)} wrong and not marked, ${String(totals.extra)} extra, ${String(totals.wrongItemDates)} with a wrong date of their own.`,
  "",
  "By kind:",
  ...[...byKind].map(
    ([kind, k]) =>
      `- ${kind}: ${String(k.pages)} pages, ${String(k.expected)} items, ${String(k.correct)} correct, ${String(k.missed)} missed, ${String(k.wrongFlagged)} wrong (unsure), ${String(k.wrongSilent)} wrong (not marked), ${String(k.extra)} extra, ${String(k.wrongItemDates)} with a wrong date of their own, ${k.pages > 0 ? (k.ms / k.pages / 1000).toFixed(1) : "—"} s per page`,
  ),
].join("\n");
await writeFile(join(out, "report.md"), `${text}\n`);
console.log(text);
