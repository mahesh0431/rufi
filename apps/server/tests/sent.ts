// Documents as a test starts from them: added from the chat box, then sent
// in a message, as the box's send does (core/chat/queue.ts).
import type { Added } from "@rufi/contracts/documents";
import { sendDocuments } from "../src/core/chat/queue.ts";
import type { Documents, NewFile } from "../src/core/documents/documents.ts";
import type { Store } from "../src/core/store/database.ts";

export async function addSent(
  docs: Documents,
  store: Store,
  personId: string,
  files: readonly NewFile[],
  together = true,
): Promise<Added> {
  const added = await docs.add(personId, files, together);
  await store.query
    .transaction()
    .execute((trx) =>
      sendDocuments(trx, personId, added.added, new Date().toISOString()),
    );
  return added;
}
