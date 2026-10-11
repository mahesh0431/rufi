// A tool's input as TypeScript, from its JSON Schema, for a description: the
// shape and every note in it, each note once. Codex cuts a tool's input
// schema over its size limit down to `unknown` before the model sees it, but
// keeps the tool's description whole (contract.test.ts).

type Json = Record<string, unknown>;

/** The input `schema` (with its `$defs`) as TypeScript types. */
export function typescriptOf(schema: Json): string {
  const defs = (schema["$defs"] ?? {}) as Record<string, Json>;
  const notes = new Set<string>();
  const named = new Set<string>();
  const pad = (depth: number) => "  ".repeat(depth);

  /** A note's comment lines, the first time the note comes. */
  const note = (node: Json, depth: number) => {
    const text = node["description"];
    if (typeof text !== "string" || notes.has(text)) return "";
    notes.add(text);
    return text
      .split("\n")
      .map((line) => `${pad(depth)}// ${line}\n`)
      .join("");
  };

  const type = (node: Json, depth: number): string => {
    const ref = node["$ref"];
    if (typeof ref === "string") {
      const name = ref.split("/").at(-1) ?? "";
      const def = defs[name] ?? {};
      // A plain string under a name says nothing more than `string`.
      if (
        def["type"] === "string" &&
        !("enum" in def) &&
        !("description" in def)
      )
        return "string";
      named.add(name);
      return name;
    }
    const anyOf = node["anyOf"];
    if (Array.isArray(anyOf))
      return (anyOf as Json[]).map((member) => type(member, depth)).join(" | ");
    const values = node["enum"];
    if (Array.isArray(values))
      return values.map((value) => JSON.stringify(value)).join(" | ");
    switch (node["type"]) {
      case "array": {
        const items = type((node["items"] ?? {}) as Json, depth);
        return items.includes(" | ") ? `Array<${items}>` : `${items}[]`;
      }
      case "object": {
        const required = new Set((node["required"] ?? []) as string[]);
        const properties = Object.entries(
          (node["properties"] ?? {}) as Record<string, Json>,
        ).map(
          ([key, value]) =>
            `${note(value, depth + 1)}${pad(depth + 1)}${key}${required.has(key) ? "" : "?"}: ${type(value, depth + 1)};`,
        );
        return `{\n${properties.join("\n")}\n${pad(depth)}}`;
      }
      case "integer":
        return "number";
      case "string":
      case "number":
      case "boolean":
      case "null":
        return node["type"];
      default:
        return "unknown";
    }
  };

  let out = `type Input = ${type(schema, 0)};`;
  // A named type can name more; a Set's loop visits those too, each once.
  for (const name of named) {
    const def = defs[name] ?? {};
    out += `\n${note(def, 0)}type ${name} = ${type(def, 0)};`;
  }
  return out;
}
