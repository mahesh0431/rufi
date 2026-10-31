export function f(): unknown {
  try {
    return JSON.parse("1");
  } catch {
    try {
      return JSON.parse("2");
    } catch (error) {
      throw new Error("fallback failed", { cause: error });
    }
  }
}
