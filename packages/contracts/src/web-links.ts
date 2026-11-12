/** Only public-looking DNS names may be used for favicon requests.
 * IPs, single-label/intranet names, credentials and URL paths are not hosts. */
export function linkIconHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 253) return null;
  const host = value.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (!/^[a-z][a-z0-9-]*$/.test(labels.at(-1)!) || /\.(?:localhost|local|internal|intranet|lan|home|arpa|test|invalid|example|onion)$/.test(host)) return null;
  return host;
}

/** The icon endpoint accepts an origin, never a page URL or arbitrary path. */
export function linkIconOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null;
    return linkIconHost(url.hostname) ? url.origin : null;
  } catch { return null; }
}
