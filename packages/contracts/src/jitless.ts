// Rufi's screens forbid eval (script-src 'self'). Zod compiles parsers with
// `new Function` where it may, and probes for that as it builds its first
// object schema; a strict policy reports even the caught probe as a refusal.
// Import this before anything that builds zod schemas: OpenUI's packages
// build theirs as they load.
import { config } from "zod";

config({ jitless: true });
