// Cloudflare Tunnel's setup and route, against a stand-in Cloudflare API and
// a fake cloudflared on a fictional data folder.
import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRunning } from "../agent/codex/processes.ts";
import {
  cloudflareApi,
  fakeCloudflared,
  TOKEN,
  type StandInApi,
} from "../../tests/cloudflare-standin.ts";
import { cloudflare, cloudflareFolder, type Cloudflare } from "./cloudflare.ts";
import { RouteProblem } from "./remote-route.ts";

const ZONES = {
  "example.com": "zone-example",
  "home.example.com": "zone-home",
  "other.org": "zone-other",
};
/** other.org is in a second account of the person's. */
const ACCOUNTS = { "zone-other": "acc1second" };

let home: string;
let stand: StandInApi;
let fake: Awaited<ReturnType<typeof fakeCloudflared>>;
let logged: string[];
let made: Cloudflare;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-cloudflare-"));
  stand = cloudflareApi(ZONES, ACCOUNTS);
  fake = await fakeCloudflared(join(home, "bin"));
  logged = [];
  made = open();
});
afterEach(async () => {
  await made.route.close();
});

const open = (places = [fake.binary]) =>
  cloudflare({
    home,
    api: stand.api,
    places,
    log: (event, fields) => logged.push(JSON.stringify({ event, fields })),
  });

/** Every file in the data folder, with its text. */
async function files(dir = home): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = [];
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    if ((await lstat(path)).isDirectory()) found.push(...(await files(path)));
    else found.push({ path, text: await readFile(path, "utf8") });
  }
  return found;
}

const routeFile = () => join(cloudflareFolder(home), "route.json");

describe("setting up Cloudflare", () => {
  it("makes Rufi's tunnel and a proxied record in the address's own domain, keeping the token nowhere", async () => {
    await made.setup(" Rufi.Home.Example.com ", TOKEN);

    // The longest domain the address is in.
    const [tunnel] = stand.tunnels;
    expect(stand.records.get("zone-home")).toEqual([
      expect.objectContaining({
        type: "CNAME",
        name: "rufi.home.example.com",
        content: `${tunnel?.id ?? ""}.cfargotunnel.com`,
        proxied: true,
      }),
    ]);
    expect(stand.records.get("zone-example")).toEqual([]);
    expect(Buffer.from(tunnel?.secret ?? "", "base64")).toHaveLength(32);
    expect(await made.state()).toEqual({
      installed: true,
      address: "rufi.home.example.com",
    });
    // The tunnel's credentials, for this user only.
    const credentials = join(
      cloudflareFolder(home),
      "tunnels",
      `${tunnel?.id ?? ""}.json`,
    );
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentials, "utf8"))).toMatchObject({
      TunnelID: tunnel?.id,
      TunnelSecret: tunnel?.secret,
    });

    // Pairing runs cloudflared with file paths only and its own HOME.
    expect(await made.route.up(41234, true)).toBe("rufi.home.example.com");
    const ran = await fake.ran();
    // Beyond what the shell and macOS add themselves, nothing of Rufi's.
    const own = new Set(["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]);
    expect(
      Object.keys(ran.env)
        .filter((key) => !own.has(key))
        .sort(),
    ).toEqual(["HOME", "PATH"]);
    expect(ran.env["HOME"]).toBe(cloudflareFolder(home));

    // The token is in no file, log line, argument or environment.
    const everywhere = [
      ...(await files()).map((file) => file.text),
      ...logged,
      ...ran.args,
      ...Object.values(ran.env),
    ];
    expect(everywhere.filter((text) => text.includes(TOKEN))).toEqual([]);
  });

  it("after a setup cut short, reuses its tunnel and the record already made for it", async () => {
    stand.failNext("POST /zones/zone-example/dns_records");
    await expect(made.setup("rufi.example.com", TOKEN)).rejects.toThrow(
      "Cloudflare couldn't add the address's record: Internal error",
    );
    expect(await made.state()).toMatchObject({ address: null });

    await made.setup("rufi.example.com", TOKEN);
    expect(stand.tunnels).toHaveLength(1);
    // And once more: the record to its tunnel stays as it is.
    await made.setup("rufi.example.com", TOKEN);
    expect(stand.tunnels).toHaveLength(1);
    expect(stand.records.get("zone-example")).toHaveLength(1);
    expect(await made.state()).toMatchObject({ address: "rufi.example.com" });
  });

  it("keeps the address set up before working when a change to another account fails, and reuses that account's new tunnel on the retry", async () => {
    await made.setup("rufi.example.com", TOKEN);
    stand.failNext("POST /zones/zone-other/dns_records");
    await expect(made.setup("rufi.other.org", TOKEN)).rejects.toThrow(
      "Cloudflare couldn't add the address's record",
    );

    expect(await made.state()).toMatchObject({ address: "rufi.example.com" });
    expect(await made.route.up(41234, true)).toBe("rufi.example.com");
    await made.route.down(41234);

    await made.setup("rufi.other.org", TOKEN);
    expect(stand.tunnels).toHaveLength(2);
    expect(await made.route.up(41234, true)).toBe("rufi.other.org");
  });

  it("never replaces another record at the address, and keeps the address set up before", async () => {
    await made.setup("rufi.example.com", TOKEN);
    const before = await readFile(routeFile(), "utf8");
    stand.records.get("zone-example")?.push({
      id: "the-persons-own",
      type: "A",
      name: "blog.example.com",
      content: "192.0.2.10",
      proxied: false,
    });

    await expect(made.setup("blog.example.com", TOKEN)).rejects.toThrow(
      "An A, AAAA, or CNAME record with that host already exists.",
    );
    expect(
      stand.records
        .get("zone-example")
        ?.filter((record) => record.name === "blog.example.com"),
    ).toEqual([expect.objectContaining({ type: "A", content: "192.0.2.10" })]);
    expect(await readFile(routeFile(), "utf8")).toBe(before);
    expect(await made.route.up(41234, true)).toBe("rufi.example.com");
  });

  it("refuses an address in no domain the token reaches, and a token Cloudflare refuses, in Cloudflare's words", async () => {
    await expect(made.setup("rufi.elsewhere.org", TOKEN)).rejects.toThrow(
      "That address isn't in a domain this token can reach.",
    );
    await expect(
      made.setup("rufi.example.com", "not-the-token"),
    ).rejects.toThrow(
      "Cloudflare couldn't find the address's domain: Invalid request headers",
    );
    expect(stand.tunnels).toEqual([]);
  });

  it("without cloudflared on this Mac, asks Cloudflare nothing", async () => {
    made = open([join(home, "nowhere", "cloudflared")]);
    expect(await made.state()).toEqual({ installed: false, address: null });
    await expect(made.setup("rufi.example.com", TOKEN)).rejects.toThrow(
      "Install cloudflared on this Mac first",
    );
    expect(stand.asked).toEqual([]);
  });
});

describe("the route", () => {
  it("can't pair before Cloudflare is set up", async () => {
    await expect(made.route.up(41234, true)).rejects.toThrow(
      new RouteProblem("Set up Cloudflare first."),
    );
  });

  it("stops cloudflared when nothing needs the door, and says so when it stops by itself", async () => {
    await made.setup("rufi.example.com", TOKEN);
    await made.route.up(41234, true);
    const first = await fake.ran();
    await made.route.down(41234);
    expect(isRunning(first.pid)).toBe(false);
    expect(made.route.trouble?.()).toBeNull();

    await rm(join(home, "bin", "ran.json"));
    await made.route.resume(41234);
    const second = await fake.ran();
    expect(second.pid).not.toBe(first.pid);
    process.kill(second.pid, "SIGKILL");
    await expect
      .poll(() => made.route.trouble?.())
      .toBe("Cloudflare Tunnel stopped. Restart Rufi to start it again.");
  });
});
