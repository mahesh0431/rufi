/** Waits for `promise`, something Claude answers, at most `ms`. */
export async function within<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Claude didn't answer in time: ${what}.`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
