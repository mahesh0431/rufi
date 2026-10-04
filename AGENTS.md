# Rufi: engineering rules

If something is unclear, stop and ask; don't guess. Rules are added here when the code they govern lands.

## Tests

- If code decides it, a code test covers it, with exact assertions.
- If the AI decides it, a live AI test covers it (real AI, fictional data), reported as passes out of runs. The live smoke set (`pnpm smoke`, the test sign-in in `RUFI_HOME`) runs each case three times; run it when the agent, its instructions or Rufi's tools change.
- An agent adapter passes the same contract tests as the others: `server/chat.test.ts` runs on the scripted fake Codex and on the real Codex binary against a local fake model, offline.
- No mocking the AI's judgement in code tests. No test modes in `src`: fakes are injected at the composition root.
- The screens are tested in Chromium with Playwright (`apps/web/e2e/`) on the real core with the built screens, the scripted fake Codex and a fictional data folder, with axe on each screen and no CSP refusal; a short chat smoke runs the real Codex binary on the local fake model.

## Code

- **Effect v4 only; never v3 APIs** (lint refuses v3 package names). Effect for the parts that open, close, wait or fail; plain TypeScript elsewhere (ADR 0002).
- Every external call has a deadline. Errors keep their `cause`. No empty `catch`, and a comment is not handling.
- Logs hold fixed events and checked fields only (`platform/logs.ts`): a new event or field is added there. Never prompts, replies, health text, tokens or error messages.
- Folders in `apps/server/src`: `platform` (Mac things) uses no other folder; `core` (record, tools, transcripts) and `agent` (sign-in, Codex) use only `platform`; `server` (the chat and the local API) joins `core` and `agent`; `cli` joins them all. Lint checks these borders. API shapes live in `packages/contracts` (Effect Schema).
- `apps/web` (the screens: React, TanStack Router and Query, Tailwind) uses only `@rufi/contracts` and the HTTP API; no server code and no `node:` modules (lint checks this). The core serves its build (`apps/web/dist`) on its own port. The tab's proof stays in `api.ts`; a 401 ends the session for every request.
- The AI's text is shown as Markdown only: no HTML, no images, and links only to http(s) pages, opened outside Rufi with no opener or referrer (`apps/web/src/transcript.tsx`).
- In `apps/web`, a value that changes lives in a store, state or ref, never in a module-level `let` that components reassign: React Compiler 1.0 can read such a variable after a later reassignment.
- One process owns the data folder at a time: the core holds `rufi.lock` for its whole life, and each terminal command holds it too. Sign-in and token renewal take `credentials.lock` inside it (always `rufi.lock` first). If `rufi.lock` is lost, the core stops writing at once.
- Only the core writes the database. Rufi's tools read through their own read-only connection. A transcript change is stored first and shown from what was stored (`core/chat/transcript.ts`).
- Rufi keeps no queue, delivery states or retries of its own for messages: the agent's queue holds what waits, and its errors are shown as they are (ADR 0004).
- The chat's state has one owner each: a message from the box is first its saved draft (the core refuses any other); only the box on screen may hold unsaved text, so the closing save fits the browser's 64 KiB; the chosen conversation is the tab's own, and its writes to the core go in one line per person (`apps/web/src/choice.ts`).

## Docs

- Three places: `docs/help/` for people (the in-app help and the website use these files as they are), `GLOSSARY.md` for everyone, `AGENTS.md` and `docs/adr/` for developers.
- A change to behaviour, commands or settings updates its help page in the same pull request; the step's plan names the pages, or says why none change.
- A help page says what a person sees and can rely on, never module, table, protocol or library names (those go in an ADR). It comes with its feature, never before it.
- Help format: the first heading is the title and the first paragraph the summary; `docs/help/index.md` gives the order. Plain Markdown and tables: relative `.md` links, local images, no front matter, HTML, MDX, admonitions or Mermaid. Fictional data only, and never a real account's email.
- Use the words in `GLOSSARY.md` everywhere: screens, docs, the AI's instructions and code. A new concept, or a changed meaning, updates the glossary in the same pull request.
- Write an ADR in `docs/adr/` only when a decision is hard to reverse, surprising without its reason, and a real choice between options; a paragraph is enough. Update the existing ADR rather than adding a near-copy.

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
- `pnpm check`: oxfmt, oxlint (type-aware), TypeScript 7, builds the screens, then tests, unused-code check and Playwright. Green before every pull request. `pnpm format` fixes formatting. Once: `pnpm exec playwright install chromium`.
- `pnpm start [--no-open]`: builds the screens, starts the core with the real Codex and opens a single-use link; while it runs, it asks the running core for a fresh link instead (`core.json`). Ctrl-C stops it. For screen work, `pnpm --filter @rufi/web watch` rebuilds and you reload.
- `pnpm rufi signin | status | signout`: Sign in with ChatGPT from the terminal. Needs `RUFI_HOME` set to a fictional data folder; tokens go to the macOS Keychain, never to files or logs.
- `pnpm rufi ask "question"`: asks Codex (the pinned `@openai/codex`, never one on PATH) in a new thread using that sign-in, streaming the answer; nothing is saved in Rufi's conversations. Ctrl-C stops it. Codex runs from `$RUFI_HOME/codex` and works in `$RUFI_HOME/workspace`, with full access (`PLAN.md` §4). Rufi's choices on top of Codex's defaults are all in `apps/server/src/agent/codex/settings.ts`; none of the user's own Codex setup or personal skills is loaded. `--debug` prints the log lines that go to `$RUFI_HOME/logs/rufi.log`.
- Rufi's tools live in `apps/server/src/core/tools/` (an Effect Schema each, no agent types); the agent gets them as `rufi.<tool>`. The person a tool reads is chosen by Rufi (`--person`, or the only one), never by the model. `pnpm tools:json` regenerates `tools.json`; a test fails if it differs.
- Test data: `cat apps/server/src/core/store/schema.sql apps/server/tests/fixtures/fictional-family.sql | sqlite3 "$RUFI_HOME/rufi.sqlite"` in a test folder. The core creates `rufi.sqlite` from `schema.sql` when there is none, and refuses one made by another schema (reset until dogfood).
- Models: `models.json` in the data folder is the allowlist (default: the strongest models); the core filters Codex's `model/list` through it.
- Queries use Kysely (`store.query`). `pnpm db:types` regenerates `tables.ts` from `schema.sql`; a test fails if they differ.
- `pnpm codex:types`: regenerates `apps/server/src/agent/codex/protocol/` from the pinned Codex after changing the pin; a test fails if they differ.
