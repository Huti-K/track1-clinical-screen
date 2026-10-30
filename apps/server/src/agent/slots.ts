/**
 * A fixed number of slots for background model runs, shared by every patient's runtime, so that
 * preparing all patients at once stays under the provider's rate limit and leaves room for the
 * screens a clinician waits for. Runs wait their turn in the order they asked.
 */
export class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(count: number) {
    this.#free = count;
  }

  async use<T>(run: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await run();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

/** Runs `run` in a slot and again after a pause when it fails, such as on a rate limit. */
export async function inBackground<T>(
  slots: Slots,
  run: () => Promise<T>,
  pausesMs: readonly number[] = [3_000, 10_000],
  log?: (message: string, error?: unknown) => void,
): Promise<T> {
  for (const pause of pausesMs) {
    try {
      return await slots.use(run);
    } catch (error) {
      log?.(`background run failed, trying again in ${pause / 1000} s`, error);
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return slots.use(run);
}
