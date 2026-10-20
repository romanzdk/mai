import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '@mai/agent';
import { Core } from './core';
import { createFakeAgent } from './fake-agent';
import { startServer } from './server';
import { Store } from './store';

const env = process.env;
const token = env.MAI_TOKEN;
if (!token) {
  console.error('MAI_TOKEN is required');
  process.exit(1);
}

// Opened from Finder/the dock, the app gets launchd's short PATH, so workers would miss
// Homebrew, nvm, cargo and friends. Ask the user's login shell for the real one.
function loginShellPath(): string | undefined {
  try {
    const out = execFileSync(
      env.SHELL || '/bin/sh',
      ['-ilc', 'printf "__MAI__%s__MAI__" "$PATH"'],
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return out.match(/__MAI__(.*?)__MAI__/)?.[1] || undefined;
  } catch {
    return undefined;
  }
}
env.PATH = loginShellPath() ?? env.PATH;

const home = homedir();
const dataDir = env.MAI_DATA_DIR ?? join(home, '.local', 'share', 'mai');
mkdirSync(dataDir, { recursive: true });

const core = new Core({
  store: new Store(env.MAI_DB ?? join(dataDir, 'mai.db')),
  agent:
    env.MAI_FAKE_AGENT === '1'
      ? createFakeAgent()
      : createAgent({
          apiKeyMode: env.MAI_API_KEY_MODE === '1',
          // Headless by default (owner's choice); some Cloudflare-protected shops block it.
          headedBrowser: env.MAI_BROWSER_HEADED === '1',
        }),
  workspace: env.MAI_WORKSPACE ?? join(home, 'mai'),
  home,
  maxParallel: Number(env.MAI_MAX_PARALLEL ?? 2),
});

const server = await startServer({ token, core, port: Number(env.MAI_PORT ?? 0) });
// The Tauri host parses this line to learn the port; keep the format in sync with lib.rs.
console.log(`MAI_DAEMON_READY ${JSON.stringify({ port: server.port })}`);
void core.checkAuth().then(() => core.refreshUsage(true));

const shutdown = () => {
  core.shutdown();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// The host keeps our stdin open; EOF means it died without killing us.
if (env.MAI_EXIT_ON_STDIN_EOF === '1') {
  process.stdin.on('end', shutdown);
  process.stdin.resume();
}
