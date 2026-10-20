// Downloads the pinned Node binary that Tauri ships as the daemon sidecar.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE_VERSION = 'v24.22.0';
const PLATFORMS = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
};

const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
const platform = PLATFORMS[triple];
if (!platform) throw new Error(`unsupported host triple: ${triple}`);

const outDir = new URL('../apps/shell/src-tauri/binaries/', import.meta.url).pathname;
const out = join(outDir, `node-${triple}`);
const stamp = `${out}.version`;
if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, 'utf8') === NODE_VERSION)
  process.exit(0);

const name = `node-${NODE_VERSION}-${platform}`;
const base = `https://nodejs.org/dist/${NODE_VERSION}`;
const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

console.log(`fetching ${name} for the daemon sidecar`);
const [tarball, sums] = await Promise.all([
  get(`${base}/${name}.tar.gz`),
  get(`${base}/SHASUMS256.txt`),
]);
const expected = sums
  .toString()
  .match(new RegExp(`^([0-9a-f]{64})  ${name}\\.tar\\.gz$`, 'm'))?.[1];
const actual = createHash('sha256').update(tarball).digest('hex');
if (actual !== expected) throw new Error(`checksum mismatch for ${name}.tar.gz`);

const tmp = mkdtempSync(join(tmpdir(), 'mai-node-'));
try {
  writeFileSync(join(tmp, 'node.tar.gz'), tarball);
  execFileSync('tar', ['-xzf', 'node.tar.gz', `${name}/bin/node`], { cwd: tmp });
  mkdirSync(outDir, { recursive: true });
  renameSync(join(tmp, name, 'bin', 'node'), out);
  chmodSync(out, 0o755);
  writeFileSync(stamp, NODE_VERSION);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
