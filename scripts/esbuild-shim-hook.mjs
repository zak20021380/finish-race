/**
 * esbuild-shim-hook.mjs — points every `esbuild` import at `esbuild-shim.mjs`, ESM and CJS alike.
 *
 * Vite is ESM and imports `esbuild` by name; the worker harnesses do the same. The `load` half is
 * for anything that reaches esbuild through its CJS entry (`esbuild/lib/main.js`), which the
 * resolver hook alone would not catch.
 */
const SHIM = new URL('./esbuild-shim.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'esbuild') return { url: SHIM, shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.includes('/esbuild/lib/')) {
    const src = `export * from ${JSON.stringify(SHIM)};\n`
      + `import d from ${JSON.stringify(SHIM)};\nexport default d;\n`;
    return { format: 'module', shortCircuit: true, source: src };
  }
  return next(url, context);
}
