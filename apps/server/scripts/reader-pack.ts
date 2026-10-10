// The reader's fictional test pack, read by the real reader and scored
// against its answer key: items missed, wrong values not marked unsure,
// wrong person or date, and time per page. The numbers are for the bar the
// person sets before dogfood, not pass or fail. Only the sign-in comes from
// RUFI_HOME (the test sign-in). Every document is read at the same time,
// each on its own scratch data folder, person and reader. The two long
// documents (big_300 and bundle) set the run's time, about 20 minutes, so
// they are read only with --all: at a milestone's end, or for a change to
// how long documents are read. --only names the documents to read.
//
//   RUFI_HOME=<test sign-in folder> node apps/server/scripts/reader-pack.ts [--all | --only a,b] [--out empty-dir]
//   node apps/server/scripts/reader-pack.ts --make <dir>    (only writes the pack's files)
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { notebook, type Entry } from "../src/core/documents/notebook.ts";
import { pages } from "../src/core/documents/pages.ts";
import { readings } from "../src/core/documents/reading.ts";
import { databasePath, openWritable } from "../src/core/store/database.ts";
import { childEnvironment, rufiHome } from "../src/platform/config.ts";
import { Secrets, secretsLayer } from "../src/platform/keychain.ts";
import { diagnostics } from "../src/platform/logs.ts";
import { reader } from "../src/server/reader.ts";
import { drawn, photo, scan } from "../tests/pack/images.ts";
import { scanPdf, textPdf } from "../tests/pack/pdf.ts";
import {
  BUNDLE,
  expected,
  layout,
  REPORTS,
  type Report,
} from "../tests/pack/reports.ts";
import { outFolder, runAll, sharedToken } from "./live-run.ts";

const { values } = parseArgs({
  options: {
    all: { type: "boolean", default: false },
    only: { type: "string" },
    out: { type: "string" },
    make: { type: "string" },
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
  /** Read only with --all (or --only): it takes far longer than the rest. */
  long?: true;
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
    "five_pages",
    "eight_pages",
  ].map(pdfItem),
  { ...pdfItem("big_300"), long: true },
  {
    name: "bundle",
    long: true,
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
  {
    name: "eight_pages_photos",
    kind: "photo",
    files: async () => {
      const pdf = pdfOf([report("eight_pages")]);
      const out: NewFile[] = [];
      for (let p = 1; p <= 3; p++) {
        out.push({
          name: `eight-pages-photo-${String(p)}.jpg`,
          bytes: await photo(await drawn(pdf, p), 10 + p),
        });
      }
      return out;
    },
    key: firstPages(report("eight_pages"), 3),
  },
];

const only = values.only?.split(",");
const chosen = PACK.filter((item) =>
  only === undefined ? values.all || !item.long : only.includes(item.name),
);
/** Which set ran, for the report. */
const set =
  only !== undefined
    ? `the documents named: ${only.join(", ")}`
    : values.all
      ? "the whole pack, with the long documents"
      : `the pack without the long documents (${PACK.filter((i) => i.long)
          .map((i) => i.name)
          .join(", ")}; --all reads them)`;

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
const out = await outFolder("pack", values.out);
const file = await codexBinary();
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};
const norm = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}<>.,%-]/gu, "");
const totals = {
  pages: 0,
  expected: 0,
  correct: 0,
  missed: 0,
  wrongFlagged: 0,
  wrongSilent: 0,
  extra: 0,
};
const byKind = new Map<string, typeof totals & { ms: number }>();

/** Reads one document with the real reader, then scores it. */
async function readOne(item: Item) {
  const home = await mkdtemp(join(tmpdir(), "rufi-pack-"));
  const store = openWritable(databasePath(home));
  const transcripts = openTranscripts(store);
  const person = await transcripts.addFirstPerson("Asha Fictional");
  const reads = readings(store);
  await reads.setConsent("yes");
  const { log } = diagnostics(home);
  const running = reader({
    readings: reads,
    book: notebook(store),
    pages: pages(store, home),
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
    signedIn: () => Promise.resolve(true),
    log,
  });
  const { added } = await documents(store, home, undefined, reads).add(
    person?.id ?? "",
    await item.files(),
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
  try {
    return score(item, store, documentId, home);
  } finally {
    store.close();
  }
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
  ).map((d) => ({
    page: d.page,
    fields: JSON.parse(d.fields) as {
      test_name: string;
      value_text: string;
      column?: string;
    },
    unsure: (JSON.parse(d.unsure) as string[]).length > 0,
    used: false,
  }));
  const pageRows = store.db
    .prepare(
      "SELECT position, entry, entry_checks, state FROM document_pages WHERE document_id = ? ORDER BY position",
    )
    .all(documentId) as {
    position: number;
    entry: string | null;
    entry_checks: string | null;
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

  const score = { correct: 0, missed: 0, wrongFlagged: 0, wrongSilent: 0 };
  const wrong: string[] = [];
  for (const want of item.key.items) {
    const found = drafts.find(
      (d) =>
        !d.used &&
        d.page === want.page &&
        d.fields.column !== "earlier" &&
        norm(d.fields.test_name) === norm(want.test),
    );
    if (!found) {
      score.missed++;
      continue;
    }
    found.used = true;
    if (norm(found.fields.value_text) === norm(want.value)) score.correct++;
    else {
      if (found.unsure) score.wrongFlagged++;
      else score.wrongSilent++;
      wrong.push(
        `p${String(want.page)} ${want.test}: "${found.fields.value_text}" for "${want.value}"${found.unsure ? " (unsure)" : ""}`,
      );
    }
  }
  const extra = drafts.filter(
    (d) => !d.used && d.fields.column !== "earlier",
  ).length;
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
    incomplete: pageRows.filter((p) => p.entry_checks?.includes("incomplete"))
      .length,
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
  const kind = byKind.get(item.kind) ?? {
    pages: 0,
    expected: 0,
    correct: 0,
    missed: 0,
    wrongFlagged: 0,
    wrongSilent: 0,
    extra: 0,
    ms: 0,
  };
  kind.pages += pageCount;
  kind.expected += item.key.items.length;
  kind.correct += score.correct;
  kind.missed += score.missed;
  kind.wrongFlagged += score.wrongFlagged;
  kind.wrongSilent += score.wrongSilent;
  kind.extra += extra;
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
      String(wrongPerson),
      `${String(wrongDate)} / ${String(noDate)}`,
      `${String(flags.incomplete)} / ${String(flags.notLooked)} / ${String(flags.unreadable)}`,
      pageCount > 0 ? `${(ms / pageCount / 1000).toFixed(1)} s` : "—",
      usage ? `${String(usage.totalTokens)} / ${String(usage.looks)}` : "—",
      asked ? "yes" : "no",
      line ?? "—",
    ].join(" | "),
  );
  if (wrong.length > 0) rows.push(`  wrong: ${wrong.join("; ")}`);
  rows.push(`  scratch data folder: ${home}`);
  return rows;
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
  `${String(chosen.length)} documents at once, ${set}; wall time ${String(Math.round((Date.now() - started) / 1000))} s.`,
  "",
  "Columns: document | kind | outcome | pages | expected items | correct | missed | wrong, marked unsure | wrong, not marked | extra | pages with another name | pages with a wrong / no date | pages may be incomplete / not looked at / unreadable | time per page | tokens / looks | AI asked | end line",
  "",
  ...rows.map((r) => `- ${r}`),
  "",
  `Totals: ${String(totals.pages)} pages, ${String(totals.expected)} expected items, ${String(totals.correct)} correct, ${String(totals.missed)} missed, ${String(totals.wrongFlagged)} wrong but marked unsure, ${String(totals.wrongSilent)} wrong and not marked, ${String(totals.extra)} extra.`,
  "",
  "By kind:",
  ...[...byKind].map(
    ([kind, k]) =>
      `- ${kind}: ${String(k.pages)} pages, ${String(k.expected)} items, ${String(k.correct)} correct, ${String(k.missed)} missed, ${String(k.wrongFlagged)} wrong (unsure), ${String(k.wrongSilent)} wrong (not marked), ${String(k.extra)} extra, ${k.pages > 0 ? (k.ms / k.pages / 1000).toFixed(1) : "—"} s per page`,
  ),
].join("\n");
await writeFile(join(out, "report.md"), `${text}\n`);
console.log(text);
