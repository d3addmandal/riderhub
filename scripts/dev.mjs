#!/usr/bin/env node
/**
 * Runs the backend and frontend together with prefixed, colour-coded output.
 * Zero dependencies — no `concurrently` needed.
 *
 *   npm run dev
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m' };

for (const d of ['backend', 'frontend']) {
  if (!existsSync(join(ROOT, d, '.env'))) {
    console.error(`${c.red}Missing ${d}/.env${c.reset} — run ${c.cyan}npm run setup${c.reset} first.`);
    process.exit(1);
  }
  if (!existsSync(join(ROOT, d, 'node_modules'))) {
    console.error(`${c.red}${d} dependencies not installed${c.reset} — run ${c.cyan}npm run install:all${c.reset}.`);
    process.exit(1);
  }
}

const targets = [
  { name: 'api', dir: 'backend', color: c.cyan },
  { name: 'web', dir: 'frontend', color: c.magenta },
];

const children = [];
let shuttingDown = false;

for (const t of targets) {
  // shell:true so npm resolves via .cmd on Windows
  const child = spawn('npm', ['run', 'dev'], {
    cwd: join(ROOT, t.dir),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${t.color}${t.name.padEnd(3)}${c.reset} ${c.dim}│${c.reset} `;
  const relay = stream => {
    let buf = '';
    stream.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) console.log(prefix + line);
    });
  };
  relay(child.stdout);
  relay(child.stderr);

  child.on('exit', code => {
    if (shuttingDown) return;
    console.log(`${prefix}${c.red}exited with code ${code}${c.reset}`);
    shutdown(code ?? 1);
  });

  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const ch of children) {
    if (ch.exitCode === null) {
      // Kill the whole tree on Windows; npm spawns the real process as a child.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(ch.pid), '/f', '/t'], { stdio: 'ignore' });
      else ch.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`${c.bold}🏍️  RiderHub dev${c.reset}
${c.cyan}api${c.reset} → http://localhost:3001
${c.magenta}web${c.reset} → http://localhost:5173
${c.dim}Ctrl+C to stop both.${c.reset}
`);
