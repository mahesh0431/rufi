# Rufi

A family's health record on their Mac, with an AI that reads their documents and talks with them. How it works: `docs/how-rufi-works.md`. Decisions: `docs/adr/`. Words: `GLOSSARY.md`.

## Commands

- Setup: `mise install && pnpm install`, then `pnpm exec playwright install chromium` once.
- While working, check what you changed: `pnpm check:quick` (format, lint, types, unused code) and the tests covering what you changed, with `pnpm exec vitest run <file>` or `pnpm exec playwright test <file>` after `pnpm --filter @rufi/web build`. `pnpm format` fixes formatting.
- CI runs the full suite on every pull request; it must be green before merging. `pnpm check` runs the full suite locally when wanted.
- After changing `schema.sql`, a tool or the Codex pin, run `pnpm db:types`, `pnpm tools:json` or `pnpm codex:types`.
- After changing `apps/server/src/agent/claude/` or the Claude Agent SDK pin, run `pnpm claude:live`: it checks the Claude installed on this Mac, with fictional data (CI has no Claude).
- By hand, always set `RUFI_HOME` to a fictional data folder; without it Rufi opens the person's real `~/.rufi`.

## Tests

- Code decides it: a code test with exact assertions. The AI decides it: a live test with the real AI on fictional data: `pnpm smoke` covers the agent, its instructions and tools. Never mock the AI's judgement, and no test modes in `src`.
- A live test checks facts in code, such as what was saved and stored values against the fixture; what the AI's words mean gets a verdict from an AI judge or a person, never word matching in code.
- Tests meet the `tdd` skill's bar and never show a window or take the focus.
- Don't test purely visual sizes, colours, wrapping or layout (a screenshot shows them); the wording of copy, skills or tool descriptions; code restated (its constants, a copied list, its logic mirrored) or only wired; the words of an AI reply. Behaviour, so tested: a control visible to keyboard users and reachable by the pointer, and accessibility (axe, keyboard, reduced motion).
- A flaky test is fixed at its cause, never retried.
- Never delete: live safety tests, person scope (device data's too), private-log, file-serving, backup/restore/export, migration and upgrade, the device type key guard, capture and Codex protocol tests.

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
- The AI's sandbox (`aiSandbox`, ADR 0016), the window's guards and the CSP (ADR 0017). Never relax them to make a test pass.
- No secret in a process's arguments or environment, Codex's, Claude's or Rufi's: the AI's commands can read them. Codex and Claude keep their own sign-ins in their folders and, for Claude, the person's keychain; the AI's commands can't read their files (ADR 0001, ADR 0016).
- A schema change is a migration; a shipped one never changes (ADR 0011).
- Backups are checked; restore never writes over anything (ADR 0008).
- Values are stored as printed.
- Device data: the person comes from its source, never the batch; a batch is converted whole or not at all, in arrival order per person and system; a shipped device type key is never removed or renamed, and its meaning and unit never change (ADR 0023).

## Docs

- A change to behaviour, commands or settings updates its help page (`docs/help/`, for people) and `GLOSSARY.md`; a change to how parts fit updates `docs/how-rufi-works.md`. All in the same pull request.
- This file holds rules only. Explanations go to `docs/how-rufi-works.md` or an ADR.

## Privacy

- Fictional data only in code, fixtures, tests and screenshots. Never commit real health data, tokens or keys.
