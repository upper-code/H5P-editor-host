/**
 * Numeric configuration read from the environment.
 *
 * Every quantity read through here is a limit — a wait budget, a retention
 * window, an upload ceiling — so a value that is set but is not a number is a
 * deployment mistake, not something to paper over: falling back to the default
 * silently would turn a typo (`H5P_HOST_MUTATION_WAIT_MS=30_000`) into a
 * different limit that nobody notices until it matters. An unset or blank
 * variable takes the documented default; anything else fails the start, where
 * an operator is watching.
 *
 * `integer` is for the counts (cache sizes, file counts) where a fraction is
 * as much a typo as a word is. `max` is for a value with a hard ceiling of its
 * own, such as a timer delay, which Node cuts to 1 ms past 2^31 - 1.
 */
export default function envNumber(
  name: string,
  fallback: number,
  options: { min?: number; max?: number; integer?: boolean } = {}
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  const min = options.min ?? 0;
  const max = options.max ?? Infinity;
  const valid = options.integer
    ? Number.isInteger(value)
    : Number.isFinite(value);
  if (!valid || value < min || value > max) {
    throw new Error(
      `${name} must be ${options.integer ? 'a whole number' : 'a number'} of ` +
        `at least ${min}${max === Infinity ? '' : ` and at most ${max}`} ` +
        `(got '${raw}').`
    );
  }
  return value;
}

/** Larger delays are silently reduced to 1 ms by Node's timers. */
export const maxTimerMs = 2 ** 31 - 1;

/** Zero remains available to callers that use it to disable a timeout. */
export function envTimerMs(
  name: string,
  fallback: number,
  options: { min?: number } = {}
): number {
  return envNumber(name, fallback, { ...options, max: maxTimerMs });
}

/**
 * How long a tenant's content operation queues for its turn, in ms.
 *
 * Read in three places that must agree: the HTTP-level queue (`app.ts`), the
 * content lock (`content-transactions.ts`) and the `Retry-After` of the 503
 * that ends the wait (`errors.ts`). Zero is refused: the lock reads a
 * non-positive budget as "no limit", so a zero would have meant an immediate
 * 503 for a write and an unbounded wait for a read.
 */
export function mutationWaitMs(): number {
  return envTimerMs('H5P_HOST_MUTATION_WAIT_MS', 30_000, { min: 1 });
}

/**
 * The largest single upload the editor accepts, in bytes.
 *
 * Read in two places that must agree: express-fileupload's `limits.fileSize`,
 * which aborts the request, and H5P's own `maxFileSize`, which is what the
 * editor UI checks before it sends. Two spellings of the default would let
 * them drift apart silently — the browser would accept a file the transport
 * then refuses.
 */
export function editorMaxUploadBytes(): number {
  return envNumber('EDITOR_MAX_UPLOAD_BYTES', 256 * 1024 * 1024);
}
