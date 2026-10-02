# 0002 · Node's built-in SQLite, not better-sqlite3

**Date:** 2 Oct 2026 · **Status:** accepted

Rufi uses `node:sqlite` (`DatabaseSync`) instead of the more common better-sqlite3, because from M2 the agent queries the record through a read-only connection, and `node:sqlite` exposes SQLite's authorizer hook (`setAuthorizer`, checked on the pinned Node 24.21.0), which lets Rufi refuse anything but reads at the SQLite level; better-sqlite3 has no authorizer. It also needs no native build. Any replacement driver must offer the same authorizer; switching means redoing connection setup and types and rechecking behaviour, not rewriting the SQL.
