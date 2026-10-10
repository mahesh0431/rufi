// Each person's chat box, the same in every size and on every page: its
// draft (text and chips) is the core's (draft.ts). Other pages add to it
// with `append`: "+ Add to chat" puts chips in it, and the person sends.
import { request } from "./api.ts";
import { type DraftBox, draftBox } from "./draft.ts";
import { chatPath } from "./live.ts";
import { queries } from "./reads.ts";

const boxes = new Map<string, DraftBox>();

/** The box of a person's chat. */
export function boxFor(personId: string): DraftBox {
  let box = boxes.get(personId);
  if (!box) {
    const path = chatPath(personId);
    box = draftBox({
      call: (method, to, body) => request(method, `${path}/${to}`, body),
      client: queries,
      scope: `draft/${personId}`,
      storage: sessionStorage,
    });
    boxes.set(personId, box);
  }
  return box;
}
