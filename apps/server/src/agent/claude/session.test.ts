// A Claude conversation's parts that don't need Claude: Rufi's skills as
// Claude's plugin, and ending the conversation's process. What Claude itself
// does with Rufi's settings is checked by scripts/claude-live.ts.
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { isRunning, killGroup } from "../codex/processes.ts";
import {
  openClaudeSession,
  prepareClaudePlugin,
  spawnClaude,
} from "./session.ts";

const skill = (name: string) => ({
  name,
  text: `---\nname: ${name}\ndescription: A fictional skill.\n---\nBody.\n`,
  files: {},
});

describe("Rufi's skills as Claude's plugin", () => {
  it("are written afresh, so a skill Rufi no longer has is gone", async () => {
    const home = await mkdtemp(join(tmpdir(), "rufi-claude-"));
    await prepareClaudePlugin(home, [skill("visits"), skill("results")]);
    const plugin = await prepareClaudePlugin(home, [
      { ...skill("visits"), files: { "paper.css": "body {}" } },
    ]);

    expect(plugin.skills).toEqual(["rufi:visits"]);
    expect(await readdir(join(plugin.path, "skills"))).toEqual(["visits"]);
    expect(
      await readFile(join(plugin.path, "skills/visits/paper.css"), "utf8"),
    ).toBe("body {}");
    expect(
      JSON.parse(
        await readFile(join(plugin.path, ".claude-plugin/plugin.json"), "utf8"),
      ),
    ).toMatchObject({ name: "rufi" });
  });
});

describe("closing a conversation", () => {
  it("ends Claude's process even when it won't end by itself", async () => {
    let spawned: SpawnedProcess | undefined;
    // A Claude that ignores the SDK closing it, and SIGTERM too.
    const stubborn = (({ options }: Parameters<typeof query>[0]) => {
      spawned = options?.spawnClaudeCodeProcess?.({
        command: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        env: {},
        signal: new AbortController().signal,
      });
      return { close: () => undefined };
    }) as unknown as typeof query;
    const session = openClaudeSession({
      claude: { path: "/fictional/claude", version: "2.1.312" },
      sandbox: { folder: tmpdir(), unreadable: [] },
      env: {},
      instructions: "",
      model: "claude-fictional",
      conversation: { start: crypto.randomUUID() },
      plugin: { path: tmpdir(), skills: [] },
      query: stubborn,
      closeMs: 100,
    });
    const pid = (spawned as { pid?: number } | undefined)?.pid;
    expect(pid).toBeDefined();

    await session.close();
    expect(isRunning(pid ?? 0)).toBe(false);
  });
});

describe("when Rufi goes away", () => {
  // Claude goes on with its turn after its pipes close: a Rufi that
  // crashed would leave it working, unseen, beside the one Rufi resumes.
  it("Claude stops its turn too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rufi-claude-cli-"));
    const cli = join(dir, "claude");
    // A fictional Claude, busy with a long turn.
    await writeFile(cli, "#!/bin/sh\nsleep 600\n", { mode: 0o755 });
    const claude = spawnClaude({
      command: cli,
      args: [],
      cwd: dir,
      env: { PATH: process.env["PATH"] },
      signal: new AbortController().signal,
    });
    const stopped = new Promise<void>((resolve) =>
      claude.once("exit", () => {
        resolve();
      }),
    );
    try {
      // A crashing Rufi's pipes close; the system closes them for it.
      for (const pipe of claude.stdio) pipe?.destroy();
      await stopped;
    } finally {
      killGroup(claude.pid ?? 0);
    }
  });
});
