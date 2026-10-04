// What every smoke case needs, whatever its own checks: each reply the AI
// ran completed and wrote something. A send the core took can still end
// failed (a usage limit, a lost connection) or stopped, with no reply.
import type { Entry, Turn } from "@rufi/contracts";

export const everyTurnAnswered = (snapshot: {
  entries: readonly Entry[];
  turns: readonly Turn[];
}) =>
  snapshot.turns.length > 0 &&
  snapshot.turns.every(
    (turn) =>
      turn.status === "completed" &&
      snapshot.entries.some(
        (e) => e.kind === "reply" && e.turnId === turn.id && e.text.trim(),
      ),
  );
