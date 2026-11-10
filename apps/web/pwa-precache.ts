/** Vite's static entry graph is the shell; dynamic feature chunks are demand
 * loads. Never infer dependency edges from filenames or minified JavaScript. */
export interface BuildManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}
export function shellPrecache<T extends { url: string; size: number }>(entries: T[], chunks: Record<string, BuildManifestChunk>) {
  const files = new Set(['registerSW.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']);
  const seen = new Set<string>();
  function visit(key: string) {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = chunks[key];
    if (!chunk) throw new Error(`pwa_missing_static_dependency:${key}`);
    files.add(chunk.file);
    for (const file of [...chunk.css ?? [], ...chunk.assets ?? []]) files.add(file);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  const roots = Object.keys(chunks).filter(key => chunks[key].isEntry);
  if (!roots.length) throw new Error('pwa_missing_entry_graph');
  for (const key of roots) visit(key);
  const manifest = entries.filter(entry => files.has(entry.url));
  // This is a build gate, not a claim about runtime browser-cache bytes.
  if (manifest.reduce((sum, entry) => sum + entry.size, 0) > 3 * 1024 * 1024) throw new Error('pwa_shell_bytes_limit');
  return { manifest, warnings: [] };
}
