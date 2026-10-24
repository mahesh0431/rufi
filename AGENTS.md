# Rufi

A family's health record on their Mac, with an AI that reads their documents and talks with them. How it works: `docs/how-rufi-works.md`. Decisions: `docs/adr/`. Words: `GLOSSARY.md`.

## Commands

- Setup: `mise install && pnpm install`, then `pnpm exec playwright install chromium` once.
- While working, check what you changed: `pnpm check:quick` (format, lint, types, unused code) and the tests you touched, with `pnpm exec vitest run <file>` or `pnpm exec playwright test <file>` after `pnpm --filter @rufi/web build`. `pnpm format` fixes formatting.
- CI runs the full suite on every pull request; it must be green before merging. `pnpm check` runs the full suite locally when wanted.
- After changing `schema.sql`, a tool or the Codex pin, run `pnpm db:types`, `pnpm tools:json` or `pnpm codex:types`.
- By hand, always set `RUFI_HOME` to a fictional data folder; without it Rufi opens the person's real `~/.rufi`.

## Tests

- Code decides it: a code test with exact assertions. The AI decides it: a live test with the real AI on fictional data: `pnpm smoke` covers the agent, its instructions and tools; the reader pack covers the reader. Never mock the AI's judgement, and no test modes in `src`.
- A live test checks facts in code, such as what was saved and stored values against the fixture; what the AI's words mean gets a verdict from an AI judge or a person, never word matching in code.
- Tests meet the `tdd` skill's bar and never show a window or take the focus.
- Never delete: live safety tests, person scope, private-log, file-serving, backup/restore/export, migration and upgrade, capture and Codex protocol tests.

## Code

- Effect v4, never v3 (ADR 0002). Check Codex protocol claims against `protocol/` and the pinned `openai/codex` source.
- Every external call has a deadline; errors keep their `cause`; no empty `catch`.
- Logs hold only the events in `platform/logs.ts`: never prompts, replies, health text, tokens or errors.
- In `apps/web`, no module-level `let` that components reassign.
- Rufi's look comes from `packages/brand`: read its `DESIGN.md` before a screen changes. Colours come only from its tokens; the dog only from `@rufi/brand/mark` (its `svg()` or `mark/assets/`), never redrawn or copied.

## Never weaken

- Person scope: composite `(person_id, id)` foreign keys.
- The record changes only by a save, in one transaction, with a receipt; records are never deleted (ADR 0005).
- The AI reads the record only through Rufi's tools, for the person Rufi chose (ADR 0006).
- The AI's sandbox (`aiSandbox`, ADR 0016), the reader's lock-down (ADR 0010), the window's guards and the CSP (ADR 0017). Never relax them to make a test pass.
- A schema change is a migration; a shipped one never changes (ADR 0011).
- Backups are checked; restore never writes over anything (ADR 0008).
- Values are stored as printed.

## Docs

- A change to behaviour, commands or settings updates its help page (`docs/help/`, for people) and `GLOSSARY.md`; a change to how parts fit updates `docs/how-rufi-works.md`. All in the same pull request.
- This file holds rules only. Explanations go to `docs/how-rufi-works.md` or an ADR.

## Privacy

- Fictional data only in code, fixtures, tests and screenshots. Never commit real health data, tokens or keys.
