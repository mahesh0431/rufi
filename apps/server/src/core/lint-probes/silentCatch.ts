export function f(): unknown {
  try {
    return JSON.parse("1");
  } catch {
    // ignored
  }
  return undefined;
}
