// Builds apps/daemon/package/: the daemon bundle plus a flat node_modules with only what it
// loads at runtime (the Agent SDK with this platform's Claude binary, and the Playwright MCP
// server). The release app ships this folder as a resource. Run after `pnpm install`.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const daemon = join(root, 'apps/daemon');
const out = join(daemon, 'package');
const deps = JSON.parse(readFileSync(join(daemon, 'package.json'), 'utf8')).dependencies;
const RUNTIME = ['@anthropic-ai/claude-agent-sdk', '@playwright/mcp'];

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('pnpm', ['--filter', '@mai/daemon', 'build'], root);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'mai-daemon-runtime',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(RUNTIME.map((name) => [name, deps[name]])),
    },
    null,
    2,
  )}\n`,
);
// Flat and outside the workspace, so the bundle has no symlinks into the repo.
run(
  'pnpm',
  ['install', '--prod', '--ignore-workspace', '--config.node-linker=hoisted', '--prefer-offline'],
  out,
);
// Only symlinks in the tree, and nothing runs them; Tauri resources should be plain files.
rmSync(join(out, 'node_modules', '.bin'), { recursive: true, force: true });
rmSync(join(out, 'pnpm-lock.yaml'), { force: true });
cpSync(join(daemon, 'dist', 'daemon.mjs'), join(out, 'daemon.mjs'));
console.log(`daemon package ready: ${out}`);
