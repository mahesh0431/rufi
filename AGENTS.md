# Rufi: engineering rules

If something is unclear, stop and ask; don't guess. Rules are added here when the code they govern lands.

## Tests

- If code decides it, a code test covers it, with exact assertions.
- If the AI decides it, a live AI test covers it (real AI, fictional data), reported as passes out of runs.
- No mocking the AI's judgement in code tests. No test modes in `src`: fakes are injected at the composition root.

## Code

- **Effect v4 only; never v3 APIs** (lint refuses v3 package names). Effect for the parts that open, close, wait or fail; plain TypeScript elsewhere (ADR 0002).
- Every external call has a deadline. Errors keep their `cause`. No empty `catch`, and a comment is not handling.
- Logs hold fixed events and checked fields only (`platform/logs.ts`): a new event or field is added there. Never prompts, replies, health text, tokens or error messages.
- Folders in `apps/server/src`: `platform` (Mac things) uses no other folder; `core` (record, tools) and `agent` (sign-in, Codex) use only `platform`; `cli` joins them. Lint checks these borders.
- A change to behaviour, commands or settings updates its docs in the same pull request.

## Data model

- Person‑owned rows carry `person_id`; references between them use composite `(person_id, id)` foreign keys, so the database rejects cross‑person links. File bytes are shared and carry no person.
- Store values as printed and dates at the precision known; never overwrite printed fields.

## Data and privacy

- **Fictional data only** in code, fixtures, tests and screenshots. Never commit real health data, tokens or keys.
- Development and tests use a fictional data folder outside the checkout.

## Git

- `main` changes only through pull requests: one small step each, checks green, review answered, then squash‑merge.
- Commit messages say what changed and why, in plain English.

## Commands

- `mise install && pnpm install`: pinned Node, pnpm and gitleaks; turns on the git hooks.
- `pnpm check`: oxfmt, oxlint (type-aware), TypeScript 7, tests and unused-code check. Green before every pull request. `pnpm format` fixes formatting.
- `pnpm rufi signin | status | signout`: Sign in with ChatGPT from the terminal. Needs `RUFI_HOME` set to a fictional data folder; tokens go to the macOS Keychain, never to files or logs.
- `pnpm rufi ask "question"`: asks Codex (the pinned `@openai/codex`, never one on PATH) using that sign-in, streaming the answer; Ctrl-C stops it. Codex runs from `$RUFI_HOME/codex` and works in `$RUFI_HOME/workspace`, with full access (`PLAN.md` §4). Rufi's choices on top of Codex's defaults are all in `apps/server/src/agent/codex/settings.ts`; none of the user's own Codex setup or personal skills is loaded. `--debug` prints the log lines that go to `$RUFI_HOME/logs/rufi.log`.
- Rufi's tools live in `apps/server/src/core/tools/` (an Effect Schema each, no agent types); the agent gets them as `rufi.<tool>`. The person a tool reads is chosen by Rufi (`--person`, or the only one), never by the model. `pnpm tools:json` regenerates `tools.json`; a test fails if it differs.
- Test data: `cat apps/server/src/core/store/schema.sql apps/server/tests/fixtures/fictional-family.sql | sqlite3 "$RUFI_HOME/rufi.sqlite"` in a test folder. Rufi only reads the database until M2.
- Queries use Kysely (`store.query`). `pnpm db:types` regenerates `tables.ts` from `schema.sql`; a test fails if they differ.
- `pnpm codex:types`: regenerates `apps/server/src/agent/codex/protocol/` from the pinned Codex after changing the pin; a test fails if they differ.
