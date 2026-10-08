# Rufi: engineering rules

If something is unclear, stop and ask; don't guess. Rules are added here when the code they govern lands.

## Tests

- If code decides it, a code test covers it, with exact assertions.
- If the AI decides it, a live AI test covers it (real AI, fictional data), reported as passes out of runs. The live smoke set (`pnpm smoke`, the test sign-in in `RUFI_HOME`) runs each case three times; run it when the agent, its instructions or Rufi's tools change.
- An agent adapter passes the same contract tests as the others: `server/chat.test.ts` runs on the scripted fake Codex and on the real Codex binary against a local fake model, offline.
- No mocking the AI's judgement in code tests. No test modes in `src`: fakes are injected at the composition root.
- Every test meets the `tdd` skill's bar. Always keep: live safety tests, person scope, nothing private in logs, `schema.sql`, `tools.json`, the Codex protocol types, Stop and clean-up.
- The screens are tested in Chromium with Playwright (`apps/web/e2e/`) on the real core with the built screens, the scripted fake Codex and a fictional data folder, with axe on each screen and no CSP refusal; a short chat smoke runs the real Codex binary on the local fake model.
- The Rufi app is tested with Playwright's Electron support (`apps/desktop/e2e/`) on the real `rufi start`, a fictional data folder per test, signed out; `e2e/fakes.ts` (loaded with `-r`) stands in for the Mac's message box and the browser. No test link names a scheme the Mac itself opens (`mailto:`, a made-up one): its alert can stop Electron from starting until someone closes it. CI runs them under a virtual display. Dock, menus, focus and the looks are checked by hand on the Mac.

## Code

- **Effect v4 only; never v3 APIs** (lint refuses v3 package names). Effect for the parts that open, close, wait or fail; plain TypeScript elsewhere (ADR 0002).
- Check Codex protocol claims against `protocol/` and the `openai/codex` source at the pinned tag; most of the app-server is undocumented.
- Every external call has a deadline. Errors keep their `cause`. No empty `catch`, and a comment is not handling.
- Logs hold fixed events and checked fields only (`platform/logs.ts`): a new event or field is added there. Never prompts, replies, health text, tokens or error messages.
- Folders in `apps/server/src`: `platform` (Mac things) uses no other folder; `core` (record, tools, transcripts) and `agent` (sign-in, Codex) use only `platform`; `server` (the chat and the local API) joins `core` and `agent`; `cli` joins them all. Lint checks these borders. API shapes live in `packages/contracts` (Effect Schema).
- `apps/web` (the screens: React, TanStack Router and Query, Tailwind) uses only `@rufi/contracts` and the HTTP API; no server code and no `node:` modules (lint checks this). The core serves its build (`apps/web/dist`) on its own port. The tab's proof stays in `api.ts`; a 401 ends the session for every request.
- `apps/desktop` (the Rufi app, Electron) runs `rufi start` on the pinned Node as a child, over Node's IPC channel (`cli/app.ts`, `@rufi/contracts/app`); it imports neither the server's nor the screens' code (lint checks this) and reads no `core.json`. Its window (`src/window.ts`) sets every guard explicitly: no Node or preload, context isolation, sandbox, web security, no permission, download or new window, navigation only within the core's origin, no redirect out, storage in memory. As in the web app, an http(s) link the page follows or opens goes to the browser (none with a name or password in it); one a frame follows doesn't, and a popup goes only while the page has no frame, because Electron doesn't say which frame opened it (Rufi has none: its pages refuse to be framed and its CSP blocks frames from elsewhere, but script can still make a blank or `srcdoc` frame, which takes the page's CSP). What guards this is the page's CSP: only Rufi's own code runs, and replies are Markdown without HTML. Remaining risk: script that somehow ran in the page could open an address in the browser, with data in it. Known gap: Electron doesn't report a navigation to `about:blank`, so one leaves the window blank (⌘W and the Dock bring Rufi back). It loads the screens from the loopback port, so it trusts the other programs on this Mac as the browser does. The screens see `RufiApp` in the user agent, mark the page `data-app`, and style the app on the `data-sidebar` and `data-toolbar` hooks.
- The AI's text is shown as Markdown only: no HTML, no images, and links only to http(s) pages, opened outside Rufi with no opener or referrer (`apps/web/src/transcript.tsx`).
- In `apps/web`, a value that changes lives in a store, state or ref, never in a module-level `let` that components reassign: React Compiler 1.0 can read such a variable after a later reassignment.
- One process owns the data folder at a time: the core holds `rufi.lock` for its whole life, and each terminal command holds it too. Sign-in and token renewal take `credentials.lock` inside it (always `rufi.lock` first). If `rufi.lock` is lost, the core stops writing at once.
- Only the core writes the database. Rufi's tools read through their own read-only connection; `save_changes` writes through the core's, in Rufi's chat only. A transcript change is stored first and shown from what was stored (`core/chat/transcript.ts`).
- The AI's SQL (`run_sql`) runs on a copy of the active person's record in a child process (`core/store/scoped.ts`, ADR 0006): a new table goes in `RECORD_TABLES` or in Rufi's own list, never in both or neither.
- A reply is stored as it came; its How is split off when it is read (`core/chat/basis.ts`), and its Used is built each time from its own `tool_calls` and activity lines, never stored (ADR 0007).
- Rufi keeps no queue or retries of its own for messages: the agent's queue holds what waits, and its errors are shown as they are (ADR 0004). The one delivery state is the draft a send holds until the agent took or refused the message (`drafts.state`); a send Rufi stopped during is never sent again.
- The chat's state has one owner each: a draft is the core's, and every save or send is checked against its revision and the send holding it; a conversation exists before its first message (Send never creates, chooses or navigates); the conversation on screen is the tab's own (`apps/web/src/choice.ts`), and the core's chosen conversation is only where the chat opens next time. Nothing is saved as a page closes.

## Docs

- Three places: `docs/help/` for people (also the in-app help and the website, as they are), `GLOSSARY.md` for everyone, `AGENTS.md` and `docs/adr/` for developers; otherwise the `project-docs` skill.
- A change to behaviour, commands or settings updates its help page and the glossary in the same pull request; the step's plan names the pages, or says why none change.
- Use the glossary's words everywhere: screens, docs, the AI's instructions and code.

## Data model

- Person‑owned rows carry `person_id`; references between them use composite `(person_id, id)` foreign keys, so the database rejects cross‑person links. File bytes are shared and carry no person.
- Store values as printed and dates at the precision known; never overwrite printed fields.
- The record changes only by a save (ADR 0005, `core/record`): one transaction with the records, each one's before and after, and the receipt built from what was stored. Records are never deleted (`removed`). A date keeps the user's words; code checks dates, sources and the health rules, never what the user meant.

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
- `pnpm desktop`: builds the screens and opens the Rufi app, which starts the core itself or opens on the one `pnpm start` runs. ⌘W keeps Rufi running; ⌘Q and Ctrl-C stop what the app started (gracefully, killed after 10 s), then close the windows without asking the page. A killed or crashed core leaves nothing behind because Codex ends itself and its commands when its stdin closes (`contract.test.ts` checks this on the fake and the real Codex). On the Mac it runs Electron from a copy of its bundle named Rufi (`apps/desktop/node_modules/.cache`). Electron (pinned) fetches its binary on first use; it has no install script.
- `pnpm rufi signin | status | signout`: Sign in with ChatGPT from the terminal. Needs `RUFI_HOME` set to a fictional data folder; tokens go to the macOS Keychain, never to files or logs.
- `pnpm rufi ask "question"`: asks Codex (the pinned `@openai/codex`, never one on PATH) in a new thread using that sign-in, streaming the answer; nothing is saved in Rufi's conversations. Ctrl-C stops it. Codex runs from `$RUFI_HOME/codex` and works in `$RUFI_HOME/workspace`, with full access (`PLAN.md` §4). Rufi's choices on top of Codex's defaults are all in `apps/server/src/agent/codex/settings.ts`; none of the user's own Codex setup or personal skills is loaded. `--debug` prints the log lines that go to `$RUFI_HOME/logs/rufi.log`.
- Rufi's tools live in `apps/server/src/core/tools/` (an Effect Schema each, no agent types); the agent gets them as `rufi.<tool>`. The person a tool reads is chosen by Rufi (`--person`, or the only one), never by the model. `pnpm tools:json` regenerates `tools.json`; a test fails if it differs.
- Test data: `cat apps/server/src/core/store/schema.sql apps/server/tests/fixtures/fictional-family.sql | sqlite3 "$RUFI_HOME/rufi.sqlite"` in a test folder. The core creates `rufi.sqlite` from `schema.sql` when there is none, and refuses one made by another schema (reset until dogfood).
- Models: `models.json` in the data folder is the allowlist (default: the strongest models); the core filters Codex's `model/list` through it.
- Queries use Kysely (`store.query`). `pnpm db:types` regenerates `tables.ts` from `schema.sql`; a test fails if they differ.
- `pnpm codex:types`: regenerates `apps/server/src/agent/codex/protocol/` from the pinned Codex after changing the pin; a test fails if they differ.
