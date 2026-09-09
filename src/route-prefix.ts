export const DEFAULT_H5P_HOST_ROUTE_PREFIX = '/h5p-editor-core';

/** Normalizes the public/internal mount shared by the host and its proxy. */
export function h5pHostRoutePrefix(): string {
  const value = (
    process.env.H5P_HOST_ROUTE_PREFIX || DEFAULT_H5P_HOST_ROUTE_PREFIX
  ).trim();
  if (value === '' || value === '/') {
    throw new Error('H5P_HOST_ROUTE_PREFIX cannot be the site root.');
  }
  if (
    !value.startsWith('/') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\\')
  ) {
    throw new Error(`Invalid H5P host route prefix: ${value}`);
  }
  const normalized = value.replace(/\/+$/, '');
  const validSegments = normalized
    .slice(1)
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        /^[A-Za-z0-9._~-]+$/.test(segment)
    );
  if (!validSegments) {
    throw new Error(`Invalid H5P host route prefix: ${value}`);
  }
  return normalized;
}

export function hostRoute(suffix: string): string {
  const prefix = h5pHostRoutePrefix();
  const normalizedSuffix =
    suffix === '' ? '' : `/${suffix.replace(/^\/+/, '')}`;
  return `${prefix}${normalizedSuffix}` || '/';
}
