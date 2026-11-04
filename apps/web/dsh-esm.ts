import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const renderer = '@deepseek-ai/dsh-client-ui-renderer/client';
const virtual = '\0wangke:dsh-ui-renderer-esm';

/** Carrier packaging only: published implementations remain unchanged. */
export function dshEsm(): Plugin {
  const esmEntries = new Set<string>();
  return {
    name: 'wangke-dsh-esm', enforce: 'pre',
    resolveId(id) {
      if (id === renderer) return virtual;
      if (id === '@deepseek-ai/dsh-api-gateway/client' || id === '@deepseek-ai/dsh-client-connection/client') {
        const name = id.slice(0, -'/client'.length);
        const file = path.join(path.dirname(require.resolve(`${name}/package.json`)), 'lib/client.node.js');
        esmEntries.add(file);
        return file;
      }
    },
    load(id) {
      if (esmEntries.has(id)) return fs.readFileSync(id, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
      if (id !== virtual) return;
      const source = fs.readFileSync(require.resolve(renderer), 'utf8');
      const imports = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/cordis'];
      const required = [...source.matchAll(/\brequire\("([^"]+)"\)/g)].map(match => match[1]);
      for (const dependency of required) if (!imports.includes(dependency)) throw new Error(`Unaudited DSH renderer dependency: ${dependency}`);
      if (!source.startsWith('window.__ModuleLoader__.load({') || !source.includes('return module.exports;')) throw new Error('DSH renderer packaging changed; audit the adapter');
      // This is the upstream's existing CommonJS factory, statically linked to
      // the application's React instance. No global loader or eval is installed.
      const definition = source.replace(/^window\.__ModuleLoader__\.load\(/, 'const definition = ')
        .replace(/\}\);\s*(?:\/\/# sourceMappingURL=.*)?\s*$/, '};');
      return `${imports.map((name, index) => `import * as dependency${index} from ${JSON.stringify(name)};`).join('\n')}
${definition}
const dependencies = { ${imports.map((name, index) => `${JSON.stringify(name)}: dependency${index}`).join(', ')} };
const result = definition.factory(name => { if (!Object.hasOwn(dependencies, name)) throw new Error('Unknown DSH dependency'); return dependencies[name]; });
export const SlotRegistry = result.SlotRegistry;
export const apply = result.apply;
export const inject = result.inject;
`;
    },
  };
}
