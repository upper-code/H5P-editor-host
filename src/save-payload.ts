import HostError from './errors';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  return {
    library: body.library,
    params: body.params,
    metadata: body.metadata
  };
}
