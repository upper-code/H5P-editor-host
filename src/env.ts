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
 * This mirrors `envNumber` in WebEditorShelf so both services answer a typo
 * the same way; `integer` is the one addition, for the counts (cache sizes,
 * file counts) where a fraction is as much a typo as a word is.
 */
export default function envNumber(
  name: string,
  fallback: number,
  options: { min?: number; integer?: boolean } = {}
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  const min = options.min ?? 0;
  const valid = options.integer
    ? Number.isInteger(value)
    : Number.isFinite(value);
  if (!valid || value < min) {
    throw new Error(
      `${name} must be ${options.integer ? 'a whole number' : 'a number'} of ` +
        `at least ${min} (got '${raw}').`
    );
  }
  return value;
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
