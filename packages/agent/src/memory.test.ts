import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadMemory, memoryPrompt } from './memory';

function contextDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mai-context-'));
  writeFileSync(join(dir, 'me.md'), '# Me\n- data engineer\n');
  writeFileSync(join(dir, 'now.md'), '# Now\n- shipping mai\n');
  writeFileSync(join(dir, 'README.md'), 'rules');
  writeFileSync(join(dir, 'people.md'), 'people');
  mkdirSync(join(dir, 'projects'));
  writeFileSync(join(dir, 'projects', 'stockwatch.md'), 'sw');
  writeFileSync(join(dir, 'projects', '_template.md'), 't');
  return dir;
}

test('hot files are loaded, cold files listed, templates and README left out', () => {
  const dir = contextDir();
  const m = loadMemory(dir);
  expect(m?.hot).toContain('### me.md\n# Me\n- data engineer');
  expect(m?.hot).toContain('### now.md');
  expect(m?.hot).not.toContain('projects.md');
  expect(m?.cold).toEqual(['people.md', 'projects/stockwatch.md']);
});

test('a missing folder or switched-off memory gives nothing', () => {
  expect(loadMemory(null)).toBeNull();
  expect(loadMemory('/definitely/not/here')).toBeNull();
});

test('oversized hot files are cut to keep the desk fast', () => {
  const dir = contextDir();
  writeFileSync(join(dir, 'projects.md'), 'x'.repeat(50_000));
  const m = loadMemory(dir);
  expect(m?.hot.length).toBeLessThan(12_100);
  expect(m?.hot).toContain('over budget');
});

test('workers learn where cold notes are and what they may write', () => {
  const dir = contextDir();
  const m = loadMemory(dir);
  if (!m) throw new Error('no memory');
  const worker = memoryPrompt(m, 'worker');
  expect(worker).toContain(`${dir}/projects/stockwatch.md`);
  expect(worker).toContain(`${dir}/inbox.md`);
  expect(memoryPrompt(m, 'desk')).toContain('remember');
});
