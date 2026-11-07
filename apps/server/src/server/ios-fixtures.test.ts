// The iPhone app's fixtures: what the record's routes answer for a
// fictional record, kept in apps/ios/RufiTests/Fixtures, which the app's
// tests decode. A route that answers differently fails here until the files
// are written again (`pnpm ios:fixtures`), so a change to what the screens
// read can't leave the iPhone behind unseen.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codexAdapter } from "../agent/codex/adapter.ts";
import { databasePath, openWritable } from "../core/store/database.ts";
import { FAMILY } from "../../tests/fixtures/golden.ts";
import { PROOF_HEADER } from "./api.ts";
import { agentSetup, startCore, type Core } from "./core.ts";

const FAKE = join(import.meta.dirname, "../../tests/fake-codex.ts");
const MORE = join(import.meta.dirname, "../../tests/fixtures/record-pages.sql");
const FIXTURES = join(import.meta.dirname, "../../../ios/RufiTests/Fixtures");
const WRITE = process.env["WRITE_IOS_FIXTURES"] === "1";
// One Mac's clock wherever this runs: Today's day, zone and doses are its.
process.env["TZ"] = "Europe/Berlin";
const NOW = "2026-10-06T06:30:00.000Z";

/** Each fixture: its file's name and the route that answers it. */
const ROUTES: readonly (readonly [string, string])[] = [
  ["overview", "/api/people/asha/overview"],
  ["record-condition", "/api/people/asha/record/condition"],
  ["record-allergy", "/api/people/asha/record/allergy"],
  ["record-symptom", "/api/people/asha/record/symptom"],
  ["record-care_event", "/api/people/asha/record/care_event"],
  ["detail-condition", "/api/people/asha/record/condition/cond-a1"],
  ["detail-none_known", "/api/people/asha/record/none_known/nk-a1"],
  ["detail-result-amended", "/api/people/asha/record/result/res-a4"],
  ["detail-result-current", "/api/people/asha/record/result/res-a5"],
  ["follow-ups", "/api/people/asha/follow-ups"],
  ["lab-results", "/api/people/asha/lab-results"],
  ["test-tsh", "/api/people/asha/tests/tst-tsh"],
  ["detail-test-tsh", "/api/people/asha/record/test/tst-tsh"],
  ["record-measurement", "/api/people/asha/record/measurement"],
  ["record-medicine_use", "/api/people/asha/record/medicine_use"],
  ["detail-medicine", "/api/people/asha/record/medicine_use/med-a1"],
  ["today", "/api/people/asha/today"],
  [
    "doses",
    "/api/people/asha/doses?from=2026-10-01&to=2026-10-14&medicine=med-a1",
  ],
  ["documents", "/api/people/asha/documents"],
  ["document-items", "/api/people/asha/documents/doc-asha-aug/items"],
  ["document-reading", "/api/people/asha/documents/doc-asha-aug/reading"],
  ["document-reading-older", "/api/people/asha/documents/doc-asha-sep/reading"],
  ["document-delete", "/api/people/asha/documents/doc-asha-aug/delete"],
  ["record-visit", "/api/people/asha/record/visit"],
  ["detail-visit", "/api/people/asha/record/visit/vis-a1"],
];

let home: string;
let scope: Scope.Closeable | undefined;
let core: Core;
let headers: Record<string, string>;

function call(
  method: string,
  path: string,
  extra: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; text: string; cookie: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: core.port,
        method,
        path,
        headers: { host: `127.0.0.1:${String(core.port)}`, ...extra },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            text,
            cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "",
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.setHeader("content-type", "application/json");
      req.end(JSON.stringify(body));
    } else req.end();
  });
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-ios-fixtures-"));
  const store = openWritable(databasePath(home));
  try {
    store.db.exec(await readFile(FAMILY, "utf8"));
    store.db.exec(await readFile(MORE, "utf8"));
  } finally {
    store.close();
  }
  const opened = await Effect.runPromise(Scope.make());
  scope = opened;
  core = await Effect.runPromise(
    startCore({
      home,
      adapters: [
        codexAdapter({
          home,
          ...agentSetup(home),
          command: { file: process.execPath, args: [FAKE] },
          env: { PATH: process.env["PATH"] ?? "", FAKE_CODEX: "{}" },
          version: "0.0.0",
        }),
      ],
      log: () => undefined,
      now: () => NOW,
    }).pipe(Scope.provide(opened)),
  );
  const launch =
    new URLSearchParams(new URL(core.launchUrl()).hash.slice(1)).get(
      "launch",
    ) ?? "";
  const origin = `http://127.0.0.1:${String(core.port)}`;
  const session = await call("POST", "/api/session", { origin }, { launch });
  const { proof } = JSON.parse(session.text) as { proof: string };
  headers = { origin, cookie: session.cookie, [PROOF_HEADER]: proof };
});

afterAll(async () => {
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
});

describe("the iPhone's fixtures", () => {
  it.each(ROUTES)("%s is what its route answers", async (name, path) => {
    const answer = await call("GET", path, headers);
    expect(answer.status).toBe(200);
    const file = join(FIXTURES, `${name}.json`);
    if (WRITE) await writeFile(file, answer.text);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
      JSON.parse(answer.text),
    );
  });
});
