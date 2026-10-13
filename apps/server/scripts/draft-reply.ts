// Whether a reply about a value that is only in a document's draft items
// says so: it points to the document or its draft, and says that isn't
// saved. A reply that answers from the saved record alone fails.
export const saysDraftNotSaved = (reply: string) =>
  /draft|lotus|report|document/i.test(reply) &&
  /draft|n.t (yet |been )*saved|n.t (yet )?(in|part of) your/i.test(reply);
