// Rufi's door for the iPhone app in the Simulator, on this Mac only, with
// fictional data. It is the screens' test setup (apps/web/e2e/rufi.ts): a
// fresh folder with the fictional family, and a scripted Rufi AI whose
// every reply is REPLY. Tailscale is never run: a stand-in serves HTTPS at
// this Mac's network address on the door's port, with a certificate from a
// certificate authority made here, and passes it on to the door on
// 127.0.0.1, as Tailscale Serve does. The Simulator trusts that authority
// once it is added to it (xcrun simctl keychain <device> add-root-cert).
//
//   node apps/ios/scripts/door.ts <folder>
//
// <folder> keeps the authority between runs (ca.pem, to add to the
// Simulator) and each run's data folder. It prints Rufi's link for this
// Mac's browser, and a new one at each `kill -USR1 <its pid>`: Settings ›
// iPhone › Pair an iPhone makes the pairing link. Ctrl-C stops it. It proves the app against the door's real code; it can't
// prove Tailscale on the Mac or the iPhone, or a tailnet certificate.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import {
  request as plainRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer, request, type Server } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Rufi } from "../../web/e2e/rufi.ts";
import type { Tailscale } from "../../server/src/server/tailscale.ts";

/** What Rufi AI answers every message: a result of the family's, linked. */
const REPLY = [
  "Your **HbA1c** was 6.8 % on 12 Aug 2026, above the 4.0–5.6 range.",
  "",
  "[See your HbA1c results](/people/asha/tests/tst-hba1c) · [What HbA1c measures](https://example.com/hba1c)",
].join("\n");

const run = promisify(execFile);
const folder = process.argv[2];
if (folder === undefined) {
  throw new Error("Usage: node apps/ios/scripts/door.ts <folder>");
}
await mkdir(folder, { recursive: true, mode: 0o700 });

/** This Mac's IPv4 address on its network, which the Simulator reaches. */
const address = Object.values(networkInterfaces())
  .flat()
  .find((one) => one?.family === "IPv4" && !one.internal)?.address;
if (address === undefined) throw new Error("This Mac has no network address.");

// The authority, kept; the certificate for this address, made each run.
const ca = join(folder, "ca.pem");
const caKey = join(folder, "ca-key.pem");
if (!existsSync(ca)) {
  await run("openssl", [
    "req",
    "-x509",
    "-sha256",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "365",
    "-subj",
    "/CN=Rufi local door (fictional data only)",
    "-keyout",
    caKey,
    "-out",
    ca,
  ]);
}
const key = join(folder, "door-key.pem");
const csr = join(folder, "door.csr");
const cert = join(folder, "door.pem");
const extensions = join(folder, "door.ext");
await run("sh", [
  "-c",
  `printf 'subjectAltName=IP:${address}\\nextendedKeyUsage=serverAuth\\nbasicConstraints=CA:FALSE\\n' > '${extensions}'`,
]);
await run("openssl", [
  "req",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-subj",
  `/CN=${address}`,
  "-keyout",
  key,
  "-out",
  csr,
]);
await run("openssl", [
  "x509",
  "-req",
  "-sha256",
  "-in",
  csr,
  "-CA",
  ca,
  "-CAkey",
  caKey,
  "-CAcreateserial",
  "-days",
  "30",
  "-extfile",
  extensions,
  "-out",
  cert,
]);
const tls = {
  key: await readFile(key),
  cert: await readFile(cert),
  ca: await readFile(ca),
};

/** Passes one request on to the door on 127.0.0.1, streams included. */
function pass(port: number, incoming: IncomingMessage, out: ServerResponse) {
  const sent = plainRequest(
    {
      host: "127.0.0.1",
      port,
      method: incoming.method,
      path: incoming.url,
      headers: {
        ...incoming.headers,
        "x-forwarded-for": incoming.socket.remoteAddress ?? "",
      },
    },
    (answer) => {
      out.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(out);
    },
  );
  sent.on("error", () => out.destroy());
  out.on("close", () => sent.destroy());
  incoming.pipe(sent);
}

const served = new Map<number, Server>();
const tailscale: Tailscale = {
  name: () => Promise.resolve(address),
  serve: async (port) => {
    if (served.has(port)) return;
    const server = createServer(tls, (incoming, out) => {
      pass(port, incoming, out);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, address, resolve);
    });
    served.set(port, server);
  },
  off: async (port) => {
    const server = served.get(port);
    served.delete(port);
    if (server) await new Promise((closed) => server.close(closed));
  },
  check: async (origin, answers) => {
    const { port } = new URL(origin);
    const response = await new Promise<Response>((resolve, reject) => {
      const sent = request(
        {
          host: address,
          port: Number(port),
          method: "POST",
          path: "/api/pair",
          ca: tls.ca,
          headers: { "content-type": "application/json" },
        },
        (answer) => {
          let text = "";
          answer.setEncoding("utf8");
          answer.on("data", (chunk: string) => (text += chunk));
          answer.on("end", () => {
            resolve(new Response(text, { status: answer.statusCode }));
          });
        },
      );
      sent.on("error", reject);
      sent.end(JSON.stringify({ code: "check", name: "check" }));
    });
    if (!(await answers(response))) throw new Error("The door didn't answer.");
  },
};

const rufi = new Rufi(await mkdtemp(join(folder, "data-")));
await rufi.family();
/** Each step of the stand-in, and what failed, in this script's output. */
const said = Object.fromEntries(
  Object.entries(tailscale).map(([step, does]) => [
    step,
    async (...args: never[]) => {
      try {
        return await (does as (...a: never[]) => Promise<unknown>)(...args);
      } catch (error) {
        console.error(`tailscale ${step} failed:`, error);
        throw error;
      }
    },
  ]),
) as unknown as Tailscale;
await rufi.start({ scenario: { answer: REPLY }, tailscale: said });
console.log(`The Simulator trusts ${ca} once added to it.`);
console.log("Rufi on this Mac (its link works once):");
console.log(rufi.link());
process.on("SIGUSR1", () => {
  console.log(rufi.link());
});
process.on("SIGINT", () => {
  void Promise.all([...served.keys()].map((port) => tailscale.off(port)))
    .then(() => rufi.close())
    .finally(() => process.exit(0));
});
