async function f(): Promise<void> {
  await Promise.resolve();
}
export function g(): void {
  f();
}
