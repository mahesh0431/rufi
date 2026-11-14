// Tailscale's steps on a stand-in `tailscale` command: what Rufi asks it, and
// the one line Settings shows for each way it isn't ready. No real
// `tailscale` runs.
import { describe, expect, it } from "vitest";
import { funnelRoute, tailscale, type Run } from "./tailscale.ts";

/** A `tailscale` that answers `status --json` with `status`, and logs the rest. */
const standIn = (status: object | Error, ran: string[] = []): Run => {
  return (args) => {
    ran.push(args.join(" "));
    if (args[0] !== "status") return Promise.resolve("");
    return status instanceof Error
      ? Promise.reject(status)
      : Promise.resolve(JSON.stringify(status));
  };
};

const READY = {
  BackendState: "Running",
  Self: { DNSName: "asha-mbp.tail1234.ts.net." },
  CertDomains: ["asha-mbp.tail1234.ts.net"],
};

describe("Tailscale", () => {
  it("gives the Mac's name, and serves and stops the door's port on HTTPS only", async () => {
    const ran: string[] = [];
    const steps = tailscale(standIn(READY, ran));

    expect(await steps.name()).toBe("asha-mbp.tail1234.ts.net");
    await steps.serve(47860);
    await steps.off(47860);

    expect(ran).toEqual([
      "status --json",
      "serve --bg --https=47860 http://127.0.0.1:47860",
      "serve --https=47860 off",
    ]);
  });

  it("says what to do when it isn't installed, signed in, or set up for HTTPS", async () => {
    const missing = Object.assign(new Error("spawn tailscale ENOENT"), {
      code: "ENOENT",
    });
    await expect(tailscale(standIn(missing)).name()).rejects.toThrow(
      "Rufi reaches your iPhone through Tailscale. Install it and sign in on this Mac, then try again.",
    );
    await expect(
      tailscale(standIn({ ...READY, BackendState: "NeedsLogin" })).name(),
    ).rejects.toThrow(
      "Tailscale isn't connected on this Mac. Open Tailscale and sign in, then try again.",
    );
    await expect(
      tailscale(standIn({ ...READY, CertDomains: null })).name(),
    ).rejects.toThrow(
      "Turn on HTTPS in your Tailscale admin console (DNS page), then try again.",
    );
  });

  it("passes on Tailscale's own words when Serve fails", async () => {
    const refused: Run = (args) =>
      args[0] === "serve"
        ? Promise.reject(
            Object.assign(new Error("Command failed"), {
              stderr:
                "Serve is not enabled on your tailnet.\nTo enable, visit:\n  https://login.tailscale.com/f/serve?node=n1\n",
            }),
          )
        : Promise.resolve("");

    await expect(tailscale(refused).serve(47860)).rejects.toThrow(
      "Tailscale couldn't serve Rufi: Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=n1",
    );
  });

  it("funnels the door from the first Funnel port nothing holds, a foreground command's too, and turns off only its own", async () => {
    const ran: string[] = [];
    const settings = new Map<string, string>();
    // Serve on 8443 for the tailnet; `tailscale funnel 10000` in a terminal.
    let config: object = {
      Web: {
        "asha-mbp.tail1234.ts.net:8443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
        },
      },
      Foreground: { "session-1": { TCP: { "10000": { HTTPS: true } } } },
    };
    const run: Run = (args) => {
      ran.push(args.join(" "));
      if (args[0] === "status") return Promise.resolve(JSON.stringify(READY));
      if (args.join(" ") === "funnel status --json") {
        return Promise.resolve(JSON.stringify(config));
      }
      return Promise.resolve("");
    };
    const route = funnelRoute(tailscale(run), {
      setting: (key) => Promise.resolve(settings.get(key)),
      saveSetting: (key, value) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
        return Promise.resolve();
      },
    });

    expect(await route.up(47860, true)).toBe("asha-mbp.tail1234.ts.net");
    expect(ran).toContain("funnel --bg --https=443 http://127.0.0.1:47860");

    // Rufi's own Funnel now, as Tailscale reports it.
    config = {
      ...config,
      Web: {
        ...(config as { Web: object }).Web,
        "asha-mbp.tail1234.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:47860" } },
        },
      },
      AllowFunnel: { "asha-mbp.tail1234.ts.net:443": true },
    };
    await route.down(47860);
    expect(ran.at(-1)).toBe("funnel --https=443 off");
    expect(
      ran.some((step) => step.includes("8443") || step.includes("10000")),
    ).toBe(false);
  });
});
