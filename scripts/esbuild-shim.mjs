/**
 * esbuild-shim.mjs — a rollup + TypeScript stand-in for esbuild.
 *
 * On some Windows boxes the shipped `@esbuild/win32-x64/esbuild.exe` cannot start at all: it exits
 * 1 with no output, which takes `vite build` and every harness that bundles through esbuild down
 * with it. Nothing about the app is wrong — the toolchain's binary simply does not run here.
 *
 * This is not a reimplementation of esbuild. It covers the surface Vite 6 actually calls:
 *   - `build()`  — bundling `vite.config.ts`, and the worker harnesses bundling one entry to one
 *                  outfile. Rollup does the bundling; TypeScript strips the types.
 *   - `transform()` / `transformSync()` — Vite's own TS stage. `ts.transpileModule` is a faithful
 *                  *type-stripping* transform, which is all Vite asks for.
 *   - `version`, `formatMessages`, `analyzeMetafile`, `stop` — probed for, never depended on.
 *
 * Minification is deliberately a NO-OP: it returns the code unchanged rather than pretending to
 * minify. A bundle that merely *looks* built would be worse than no build, so the output is larger
 * than a real esbuild run and says so. Everything else — module resolution, tree shaking, the HTML
 * and CSS pipelines — is Vite's own, untouched.
 *
 * `scripts/build-vite.mjs` only reaches for this when the real binary has already failed, so a
 * healthy machine runs the stock `vite build` and never loads a line of it.
 */
import { rollup } from 'rollup';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

/** Vite JSON-parses `map` when a plugin asked for a sourcemap, so it has to be valid JSON text. */
const NO_MAP = '{"version":3,"mappings":"","sources":[],"sourcesContent":[],"names":[]}';

const TS_OPTS = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  isolatedModules: true,
  sourceMap: false,
};

export const version = '0.21.5-shim';

/** The loaders Vite hands us. Everything Vite cannot ask for is passed through untouched. */
const LOADER = { ts: true, tsx: true, js: true, jsx: true };

export async function build(opts = {}) {
  const entry = Array.isArray(opts.entryPoints) ? opts.entryPoints[0] : opts.entryPoints;
  if (!entry) throw new Error('esbuild-shim: entryPoints is required');
  const outfile = opts.outfile ?? path.join(path.dirname(entry), 'out.js');

  const bundle = await rollup({
    input: entry,
    /* bare specifiers stay external, exactly as esbuild's own `packages: 'external'` does here */
    external: (id) => !id.startsWith('.') && !path.isAbsolute(id),
    plugins: [{
      name: 'ts-lite',
      resolveId(source, importer) {
        if (!source.startsWith('.')) return null;
        const base = importer ? path.dirname(importer) : path.dirname(entry);
        const p = path.resolve(base, source);
        for (const c of [p, `${p}.ts`, `${p}.js`, path.join(p, 'index.ts')]) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
        }
        return null;
      },
      load(id) {
        if (!id.endsWith('.ts')) return null;
        return ts.transpileModule(fs.readFileSync(id, 'utf8'), { fileName: id, compilerOptions: TS_OPTS }).outputText;
      },
    }],
  });

  const { output } = await bundle.generate({ format: 'es', inlineDynamicImports: true });
  const chunk = output.find((o) => o.type === 'chunk');
  if (!chunk) throw new Error('esbuild-shim: rollup produced no chunk');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, chunk.code);
  /* Vite's config loader reads `metafile.inputs` to work out which files to watch */
  const inputs = {};
  for (const m of bundle.watchFiles) inputs[m] = { bytes: 0, imports: [] };
  return {
    outputFiles: [{ path: outfile, text: chunk.code, contents: chunk.code }],
    metafile: { inputs, outputs: {} },
  };
}

export function transformSync(code, opts = {}) {
  const loader = opts.loader ?? 'js';
  /* minify is the one option this shim refuses to fake — see the header */
  if (!(loader in LOADER) || opts.minify) return { code, map: NO_MAP, warnings: [] };
  const out = ts.transpileModule(code, {
    fileName: opts.sourcefile ?? (loader === 'ts' ? 'x.ts' : 'x.js'),
    compilerOptions: { ...TS_OPTS, target: ts.ScriptTarget.ES2020 },
  });
  return { code: out.outputText, map: NO_MAP, warnings: [] };
}

export async function transform(code, opts = {}) {
  return transformSync(code, opts);
}

export function formatMessages() { return []; }
export function analyzeMetafile() { return ''; }
export function stop() { return Promise.resolve(); }

export default { build, transform, transformSync, version, formatMessages, analyzeMetafile, stop };
