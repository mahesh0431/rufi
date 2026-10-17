// The reader's model and effort until others are chosen in Settings. What
// the reader is told, and its tools, are in copy-reader.ts.

/**
 * The reader's model until one is chosen in Settings (ADR 0009). It must be
 * one the sub-agent runner runs (SUB_AGENT_MODELS).
 */
export const READER_MODEL = "gpt-6.1-sol";

/**
 * How hard the reader thinks until one is chosen in Settings. The test pack
 * measures it against the bar.
 */
export const READER_EFFORT = "medium" as const;
