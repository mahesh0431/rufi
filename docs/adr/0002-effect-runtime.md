# 0002 · Effect 4 is the core's runtime

**Date:** 3 Oct 2026 · **Status:** accepted · **Pin:** `effect` 4.0.0

## Decision

Rufi's core runs on Effect 4. The parts that open something, wait for something or can fail (the data folder, the Keychain, the log, the record, Codex; later the server, the chat stream and jobs) are Effect services, joined in one composition root (`apps/server/src/cli/main.ts` now). Each part says what it opens and how it closes; Effect closes every part, in reverse order, when the work ends, fails or is stopped. New code uses Effect for deadlines (`Effect.timeout`) and typed errors.

- **Effect v4 only.** Lint refuses the v3 package names (`@effect/schema`, `@effect/platform`, …).
- **Where Effect is not used:** pure functions (tools, schemas' rules, small helpers) stay plain TypeScript. Rufi doesn't use Effect's HTTP server, SQL or UI-state modules: Hono, Kysely and the web's own state libraries do those jobs.
- **Tested code keeps its inside.** The JSON-RPC link, the process clean-up, the sign-in steps and the Codex turn code were wrapped in services, not rewritten, when Effect came in (M2.0).
- **Effect Schema** checks all data at the edges (tool input, sign-in data, later the API contracts); `tools.json` is made from it as JSON Schema.
- **Logs** are Rufi's own file logger (`platform/logs.ts`), a service: a fixed set of events, each field checked for what it may hold. Effect's own loggers are off, because they would print messages, causes and stack traces.

## Why

A long-running local core that starts processes, streams replies and must stop cleanly needs scopes, interruption and deadlines everywhere. Without a runtime, each module writes its own `finally` blocks, timers and abort signals, and a missed one leaves a process or a lock behind. Effect gives these as one model that the type checker follows.

## Costs

- A new way of writing code: generators, layers and typed errors. Rufi keeps Effect at the edges where it earns its place.
- One more core dependency, pinned exactly; upgrades within v4 are checked like any other.
- Effect's OpenTelemetry exporter is not used yet: it needs nine OpenTelemetry packages to write a file nothing reads. It comes when something reads traces.
