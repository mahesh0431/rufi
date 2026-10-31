// Finding the Claude installed on this Mac, and how it's signed in. Fake
// `claude` programs stand in for the real one, which CI doesn't have; the
// real one is checked by scripts/claude-live.ts.
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  claudeEnvironment,
  claudeLogIn,
  claudeSignedIn,
  claudeSignIn,
  ClaudeMissing,
  ClaudeTooOld,
  findClaude,
} from "./executable.ts";

/** A folder holding a `claude` that says `version`. */
async function folderWith(version: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "rufi-claude-"));
  const path = join(folder, "claude");
  await writeFile(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  await chmod(path, 0o755);
  return folder;
}

async function emptyFolder(): Promise<string> {
  const folder = join(await mkdtemp(join(tmpdir(), "rufi-claude-")), "empty");
  await mkdir(folder);
  return folder;
}

describe("the installed Claude", () => {
  it("is the first on PATH, else the one in an installer's place", async () => {
    const [onPath, installed, empty] = await Promise.all([
      folderWith("2.1.314"),
      folderWith("2.1.400"),
      emptyFolder(),
    ]);
    expect(
      await findClaude({ PATH: `${empty}:${onPath}` }, [installed]),
    ).toEqual({
      path: join(onPath, "claude"),
      version: "2.1.314",
    });
    expect(await findClaude({ PATH: empty }, [installed])).toEqual({
      path: join(installed, "claude"),
      version: "2.1.400",
    });
  });

  it("is refused when it's older than Rufi needs, and missing when nowhere", async () => {
    const [old, newer, empty] = await Promise.all([
      folderWith("2.1.313"),
      folderWith("2.10.0"),
      emptyFolder(),
    ]);
    await expect(findClaude({ PATH: old }, [])).rejects.toBeInstanceOf(
      ClaudeTooOld,
    );
    expect((await findClaude({ PATH: newer }, [])).version).toBe("2.10.0");
    await expect(findClaude({ PATH: empty }, [])).rejects.toBeInstanceOf(
      ClaudeMissing,
    );
  });
});

describe("Claude's sign-in", () => {
  it("is told by its kind only, and the asking session is closed", async () => {
    let closed = 0;
    const answering = (account: AccountInfo) =>
      (() => ({
        accountInfo: () => Promise.resolve(account),
        close: () => {
          closed++;
        },
      })) as unknown as typeof query;
    const claude = { path: "/fictional/claude", version: "2.1.312" };
    const ask = (account: AccountInfo) =>
      claudeSignIn(claude, {
        cwd: tmpdir(),
        env: {},
        query: answering(account),
      });

    expect(
      await ask({ email: "asha@example.com", subscriptionType: "Claude Max" }),
    ).toBe("subscription");
    expect(await ask({ apiKeySource: "ANTHROPIC_API_KEY" })).toBe("api key");
    expect(await ask({ apiKeySource: "none" })).toBe("none");
    expect(closed).toBe(3);
  });
});

describe("Claude's own sign-in, in its folder in the data folder", () => {
  it("opens Claude's link, and is signed in once Claude says so, never as whom", async () => {
    // A `claude` that signs in by itself when asked, in CLAUDE_CONFIG_DIR.
    const home = await mkdtemp(join(tmpdir(), "rufi-claude-"));
    const path = join(await emptyFolder(), "claude");
    await writeFile(
      path,
      `#!/bin/sh
case "$1 $2" in
  "auth status")
    if [ -f "$CLAUDE_CONFIG_DIR/.claude.json" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai","email":"asha@example.com"}'
    else
      echo '{"loggedIn":false,"authMethod":"none"}'
      exit 1
    fi ;;
  "auth login")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?fictional=1"
    mkdir -p "$CLAUDE_CONFIG_DIR"
    echo '{}' > "$CLAUDE_CONFIG_DIR/.claude.json"
    echo "Login successful." ;;
esac
`,
    );
    await chmod(path, 0o755);
    const claude = { path, version: "2.1.314" };
    const env = claudeEnvironment(home, { PATH: "/usr/bin:/bin" });

    expect(await claudeSignedIn(claude, env)).toBe(false);
    const links: string[] = [];
    await claudeLogIn(claude, env, {
      showLink: (link) => links.push(link),
      signal: new AbortController().signal,
    });
    expect(links).toEqual([
      "https://claude.com/cai/oauth/authorize?fictional=1",
    ]);
    expect(await claudeSignedIn(claude, env)).toBe(true);
  });
});

describe("Claude stopped by Rufi", () => {
  it("settles a cancelled sign-in or sign-in check only once Claude has exited, so it writes nothing after", async () => {
    // A `claude` that takes half a second to exit when stopped, and writes
    // a file as it goes, as the real one writes its .claude.json.
    const home = await mkdtemp(join(tmpdir(), "rufi-claude-"));
    const path = join(await emptyFolder(), "claude");
    await writeFile(
      path,
      `#!/bin/sh
mkdir -p "$CLAUDE_CONFIG_DIR"
trap 'sleep 0.5; echo ended > "$CLAUDE_CONFIG_DIR/ended-$2"; exit 143' TERM
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?fictional=1"
while :; do sleep 0.1; done
`,
    );
    await chmod(path, 0o755);
    const claude = { path, version: "2.1.314" };
    const env = claudeEnvironment(home, { PATH: "/usr/bin:/bin" });
    const ended = (what: string) =>
      access(join(env["CLAUDE_CONFIG_DIR"] ?? "", `ended-${what}`));

    // Quit while the browser sign-in waits.
    const login = new AbortController();
    await expect(
      claudeLogIn(claude, env, {
        showLink: () => {
          login.abort();
        },
        signal: login.signal,
      }),
    ).rejects.toThrow();
    await expect(ended("login")).resolves.toBeUndefined();

    // Quit while Rufi asks how it's signed in.
    const status = new AbortController();
    setTimeout(() => {
      status.abort();
    }, 200);
    await expect(claudeSignedIn(claude, env, status.signal)).rejects.toThrow();
    await expect(ended("status")).resolves.toBeUndefined();
  });
});
