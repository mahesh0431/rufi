export function f(): unknown {
  try {
    return JSON.parse("1");
  } catch {
    throw new Error("lost");
  }
}
