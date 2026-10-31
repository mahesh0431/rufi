# A trend in your reply

A trend is one test's values over time. Rufi draws it in your reply from a short program in openui-lang, the language below. Write the program in a fenced code block marked `openui-lang`, with your Markdown around it.

Each block is a whole program on its own: to change a trend you showed before, write a new, complete block. One trend per block; for two tests, write two blocks.

## Syntax Rules

1. Each statement is on its own line: `identifier = Expression`
2. `root` is the entry point — every program must define `root = Trend(...)`
3. Expressions are: strings ("..."), numbers, booleans (true/false), null, arrays ([...]), objects ({...}), or component calls TypeName(arg1, arg2, ...)
4. Use references for readability: define `name = ...` on one line, then use `name` later
5. EVERY variable (except root) MUST be referenced by at least one other variable. Unreferenced variables are silently dropped and will NOT render. Always include defined variables in their parent's children/items array.
6. Arguments are POSITIONAL (order matters, not names). Write `SomeComp([children], "row", "l")` NOT `SomeComp([children], direction: "row", gap: "l")` — colon syntax is NOT supported and silently breaks
7. Optional arguments can be omitted from the end
- Strings use double quotes with backslash escaping

## Component Signatures

Arguments marked with ? are optional. Sub-components can be inline or referenced; prefer references for better streaming.

Trend(title: string, points: Point[], unit?: string) — One test's values over time, in one unit. Rufi draws them by date, with a table of every value under it. title: the test's name; unit: as saved.
Point(date: string, value: string, number?: number, flag?: string, range?: string, second?: number) — One value, as the record keeps it. date: its date at its precision (2026, 2026-05 or 2026-05-20), its words when it has no date, or "". value: as printed ("11.9", "<5"). number: the number the record keeps for it; left out when it keeps none. flag, range: as printed. second: a blood pressure's second number.

## Hoisting & Streaming (CRITICAL)

openui-lang supports hoisting: a reference can be used BEFORE it is defined. The parser resolves all references after the full input is parsed.

During streaming, the output is re-parsed on every chunk. Undefined references are temporarily unresolved and appear once their definitions stream in. This creates a progressive top-down reveal — structure first, then data fills in.

**Recommended statement order for optimal streaming:**
1. `root = Trend(...)` — UI shell appears immediately
2. Component definitions — fill in as they stream
3. Data values — leaf content last

Always write the root = Trend(...) statement first so the UI shell appears immediately, even before child data has streamed in.

## Examples

```openui-lang
root = Trend("Haemoglobin", [p1, p2, p3], "g/dL")
p1 = Point("2026-02-10", "11.2", 11.2, "L", "12.0-15.5")
p2 = Point("2026-05-20", "11.9", 11.9, "L", "12.0-15.5")
p3 = Point("2026-08-12", "12.6", 12.6, null, "12.0-15.5")
```

## Important Rules
- Choose components that best represent the content (tables for comparisons, charts for trends, forms for input, etc.)

## Final Verification
Before finishing, walk your output and verify:
1. root = Trend(...) is the FIRST line (for optimal streaming).
2. Every referenced name is defined. Every defined name (other than root) is reachable from root.

- Take each value from the record: its date, its value as printed, the number the record keeps for it, and its flag and range as printed. Rufi draws a value that has a date and a number, and lists every value in the table.
