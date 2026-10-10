import HostError from './errors';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * How deeply a save body may nest. Real content stays in the tens — a book of
 * columns of interactive videos is about twenty levels — while h5p-server and
 * this host walk parameters recursively, and a body a few thousand levels deep
 * overflows the stack: a 500 instead of an answer the caller can act on.
 */
const maxBodyDepth = 256;

function deeperThan(value: unknown, limit: number): boolean {
  const pending: [unknown, number][] = [[value, 0]];
  while (pending.length) {
    const [next, depth] = pending.pop()!;
    if (!next || typeof next !== 'object') continue;
    if (depth >= limit) return true;
    for (const child of Object.values(next)) pending.push([child, depth + 1]);
  }
  return false;
}

/** Shared validation for both producers of the flat embedding save contract. */
export function savePayload(body: unknown): {
  library: string;
  params: Record<string, unknown>;
  metadata: Record<string, unknown>;
} {
  if (
    !isObject(body) ||
    typeof body.library !== 'string' ||
    !body.library.trim() ||
    !isObject(body.params) ||
    !isObject(body.metadata)
  ) {
    throw new HostError(
      'A library string, params object and metadata object are required.',
      400
    );
  }
  if (deeperThan(body, maxBodyDepth)) {
    throw new HostError('The content is nested too deeply.', 400);
  }
  return {
    library: body.library,
    params: body.params,
    metadata: body.metadata
  };
}
