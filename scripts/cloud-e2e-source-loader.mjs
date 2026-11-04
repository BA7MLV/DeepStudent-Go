// Only this E2E opts into the current TypeScript Node task runtime. Production
// deliberately loads its compiled runtime; never rewrite or rebuild that file
// while the main session is freezing artifacts.
const compiledRuntime = new URL('../apps/api/dist/apps/api/runtime/node.mjs', import.meta.url).href;
const sourceRuntime = new URL('../apps/api/runtime/node.ts', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === compiledRuntime ? sourceRuntime : specifier, context);
}
