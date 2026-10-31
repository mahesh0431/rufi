export function f(x: "a" | "b"): number {
  switch (x) {
    case "a":
      return 1;
  }
  return 0;
}
