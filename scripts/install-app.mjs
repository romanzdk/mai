// One command after `pnpm install`: build the release app, install it for this user (no admin
// rights needed) and start it. On first start it registers itself to start at login.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const tauri = join(root, 'apps/shell/src-tauri');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const mac = process.platform === 'darwin';

run('node', ['scripts/bundle-daemon.mjs']);
run('pnpm', [
  '--filter',
  '@mai/shell',
  'tauri',
  'build',
  '--config',
  'src-tauri/tauri.release.json',
  '--bundles',
  mac ? 'app' : 'appimage',
]);

const bundle = join(tauri, 'target/release/bundle');
if (mac) {
  const target = join(homedir(), 'Applications', 'mai.app');
  // Replacing a running app's files breaks it; ask it to quit first.
  spawnSync('osascript', ['-e', 'tell application id "dev.mai.shell" to quit'], {
    stdio: 'ignore',
  });
  mkdirSync(join(homedir(), 'Applications'), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(join(bundle, 'macos', 'mai.app'), target, { recursive: true, verbatimSymlinks: true });
  console.log(`installed ${target}`);
  run('open', [target]);
} else {
  const image = readdirSync(join(bundle, 'appimage')).find((f) => f.endsWith('.AppImage'));
  if (!image) throw new Error('no AppImage was built');
  const bin = join(homedir(), '.local', 'bin');
  const target = join(bin, 'mai.AppImage');
  mkdirSync(bin, { recursive: true });
  cpSync(join(bundle, 'appimage', image), target);
  chmodSync(target, 0o755);
  const apps = join(homedir(), '.local', 'share', 'applications');
  mkdirSync(apps, { recursive: true });
  writeFileSync(
    join(apps, 'mai.desktop'),
    `[Desktop Entry]\nType=Application\nName=mai\nExec=${target}\nTerminal=false\nCategories=Utility;\n`,
  );
  console.log(`installed ${target}`);
  if (existsSync(target)) spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
}
