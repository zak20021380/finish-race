/**
 * run-tests.mjs — the local test pipeline.
 *
 * Runs the assertion and headless suites in one pass, stops at the first red
 * suite, and prints a compact summary. Pure-logic suites need Node's type
 * stripping; the headless suites read ./dist, so run `npm run build` first.
 *
 * Run: npm test
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SUITES = [
  { name: 'countries registry', script: 'verify-countries.mjs', stripTypes: false },
  { name: 'mines', script: 'mines-check.mjs', stripTypes: true },
  { name: 'walls', script: 'walls-check.mjs', stripTypes: true },
  { name: 'room', script: 'room-check.mjs', stripTypes: true },
  { name: 'bot tiers', script: 'bot-tiers-check.mjs', stripTypes: true },
  { name: 'tutorial', script: 'tutorial-check.mjs', stripTypes: true },
  { name: 'tutorial walkthrough', script: 'verify-tutorial.mjs', stripTypes: false },
  { name: 'ranks', script: 'verify-ranks.mjs', stripTypes: false },
  { name: 'squad register', script: 'verify-squad-register.mjs', stripTypes: false },
  { name: 'worker badges', script: 'verify-worker-badges.mjs', stripTypes: false },
  { name: 'worker telegram bot', script: 'verify-worker-telegram.mjs', stripTypes: false },
  { name: 'vs clash', script: 'verify-vs-clash.mjs', stripTypes: true },
];

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const results = [];
for (const suite of SUITES) {
  const started = Date.now();
  const args = [...(suite.stripTypes ? ['--experimental-strip-types'] : []), path.join('scripts', suite.script)];
  console.log(`\n▶ ${suite.name} ${dim(`(${suite.script})`)}`);
  const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  const ms = Date.now() - started;
  const code = run.status ?? 1;
  results.push({ ...suite, code, ms });
  if (code !== 0) {
    console.log(red(`■ ${suite.name} failed (exit ${code})`));
    break;
  }
  console.log(green(`■ ${suite.name} passed`) + dim(` · ${(ms / 1000).toFixed(1)}s`));
}

const passed = results.filter((r) => r.code === 0).length;
const failed = results.filter((r) => r.code !== 0);
const skipped = SUITES.length - results.length;

console.log('\n' + '─'.repeat(52));
console.log(`${passed}/${SUITES.length} suites passed${skipped ? dim(` · ${skipped} not run`) : ''}`);
if (failed.length > 0) {
  for (const suite of failed) console.log(red(`  ✗ ${suite.name} (${suite.script})`));
  process.exit(1);
}
console.log(green('All suites green.'));
