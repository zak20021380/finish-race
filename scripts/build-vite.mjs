/**
 * build-vite.mjs — run `vite build`, stepping around two broken-esbuild scenarios.
 *
 * `npm run build` is `tsc --noEmit && tsc -p worker/tsconfig.json && vite build`. The two type
 * checks are the real gate and they always run. The third step needs esbuild, and two things go
 * wrong with it on some Windows machines:
 *
 * 1. `@esbuild/win32-x64/esbuild.exe` cannot start at all — it exits 1 with no output, so
 *    Vite dies before it has read a single source file:
 *
 *      failed to load config from vite.config.ts
 *      Error: The service was stopped
 *
 * 2. The service starts, but its temp-directory handoff fails. A large CSS bundle is written to
 *    `%TEMP%` for Vite to read back, and the Rust process cannot delete its own file there:
 *
 *      [vite:css-post] remove C:\...\Temp\esbuild-<hash>: Access is denied.
 *
 *    That is an antivirus/ACL quirk of the system temp directory, not an app problem. esbuild
 *    honours `TMPDIR`/`TEMP`/`TMP`, so pointing it at a directory inside this checkout — where
 *    the build demonstrably has full control — fixes it without touching the shipped tool.
 *
 * So: probe the real binary first. If it runs, this script hands over to the stock CLI with a
 * sane temp directory and the build is byte-for-byte what it always was. Only if the probe fails
 * does it register the rollup stand-in in `esbuild-shim.mjs` and run Vite in-process, printing a
 * loud notice so nobody mistakes that build for a normal one.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);

/** Can the shipped esbuild actually start? `--version` prints and exits 0 when it can. */
function esbuildWorks() {
  let bin;
  try {
    bin = require.resolve('@esbuild/win32-x64/esbuild.exe');
  } catch {
    return false;                      // not a Windows x64 install: leave the real one alone
  }
  const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * A temp directory this build can actually delete from. The system `%TEMP%` is where esbuild's
 * large-CSS handoff fails on Windows (`[vite:css-post] remove ...: Access is denied`); the
 * checkout's own `.tmp/` (already git-ignored) is writable by this process by construction.
 * `null` means "leave the platform default alone" on every non-Windows host.
 */
function buildTempDir() {
  if (process.platform !== 'win32') return null;
  const dir = path.join(root, '.tmp', 'build-temp');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return dir;
  } catch {
    return null;                       // cannot use it: better the default than a broken build
  }
}

/** Vite's CLI entry, found through its package directory — `vite/bin/vite.js` is not an exported subpath. */
function viteCli() {
  const candidates = [];
  try {
    candidates.push(path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'));
  } catch { /* the package.json subpath is not exported either: fall through to the literal path */ }
  candidates.push(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'));
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('build-vite: cannot find vite/bin/vite.js — run `npm install` first');
  return found;
}

const temp = buildTempDir();
const tempEnv = temp ? { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp } : process.env;

if (esbuildWorks()) {
  /* the healthy path: exactly the CLI command this replaced, with a temp dir esbuild can clean */
  const run = spawnSync(process.execPath, [viteCli(), 'build'], { cwd: root, stdio: 'inherit', env: tempEnv });
  process.exit(run.status ?? 1);
}

console.warn(
  '\n[build] The bundled esbuild binary will not start on this machine '
  + '(`esbuild.exe --version` exits non-zero).\n'
  + '[build] Falling back to the rollup + TypeScript stand-in in scripts/esbuild-shim.mjs.\n'
  + '[build] The bundle is real, but it is NOT minified — do not ship this output.\n',
);

/* The shim's own temp writes go through Node, but esbuild may still be reached for CSS/JS
   transforms, so it keeps the same working temp directory. */
if (temp) {
  process.env.TEMP = temp;
  process.env.TMP = temp;
  process.env.TMPDIR = temp;
}

const { register } = await import('node:module');
register('./esbuild-shim-hook.mjs', import.meta.url);

const { build } = await import('vite');
await build({ root, configFile: path.join(root, 'vite.config.ts') });
