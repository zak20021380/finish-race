/**
 * Starts the local pair in one terminal: the Worker on 127.0.0.1:8787 and Vite on 5173.
 *
 * The two binaries are run through Node rather than `npx`/`.cmd` shims, so this works even when
 * PowerShell blocks npm.ps1/npx.ps1 (ExecutionPolicy) and never re-downloads wrangler mid-run.
 * Vite's proxy config (`vite.config.ts`) points /api, /admin, /health and /ws at port 8787.
 *
 * Usage: npm.cmd run dev:all
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bins = {
  worker: join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  web: join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
};

if (!existsSync(bins.worker) || !existsSync(bins.web)) {
  console.error('Local binaries are missing. Run: npm.cmd install');
  process.exit(1);
}

const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      // Windows has no real SIGINT for children, and workerd is a grandchild: kill the tree so
      // 8787/5173 are actually free the next time this runs.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
  process.exit(code);
}

function run(label, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  children.push(child);

  for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`[${label}] ${line}\n`);
    });
    stream.on('end', () => {
      if (buffer) out.write(`[${label}] ${buffer}\n`);
    });
  }

  child.on('exit', (code, signal) => {
    if (stopping) return;
    // If either half dies the other is useless: surface the failure and stop the pair.
    console.error(`[${label}] exited (${signal ?? code}) — stopping the other server.`);
    stop(code ?? 1);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('worker', [bins.worker, 'dev', '--ip', '127.0.0.1', '--port', '8787']);
run('web', [bins.web, '--host']);
