import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The owner's ~/context convention (its README): hot files are always loaded, the rest is
// read on demand, and agents may only append to inbox.md and decisions.md.
const HOT = ['me.md', 'now.md', 'projects.md'];
export const APPEND_ONLY = ['inbox.md', 'decisions.md'];
// Keeps desk replies fast even if the hot files grow past their ~2,000-token budget.
const HOT_LIMIT = 12_000;

export interface Memory {
  dir: string;
  hot: string;
  cold: string[];
}

function listMarkdown(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith('.') || d.name.startsWith('_')) return [];
    const path = join(dir, d.name);
    if (d.isDirectory()) return listMarkdown(path, root);
    return d.name.endsWith('.md') ? [relative(root, path)] : [];
  });
}

export function loadMemory(dir: string | null): Memory | null {
  if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  const hot = HOT.flatMap((name) => {
    try {
      return [`### ${name}\n${readFileSync(join(dir, name), 'utf8').trim()}`];
    } catch {
      return [];
    }
  }).join('\n\n');
  const clipped =
    hot.length > HOT_LIMIT ? `${hot.slice(0, HOT_LIMIT)}\n[…cut: hot files are over budget]` : hot;
  const cold = listMarkdown(dir).filter((f) => !HOT.includes(f) && f !== 'README.md');
  return { dir, hot: clipped, cold: cold.sort() };
}

export function memoryPrompt(m: Memory, role: 'desk' | 'worker'): string {
  const rules =
    role === 'worker'
      ? `\nMore notes, read or grep them when relevant: ${m.cold.map((f) => `${m.dir}/${f}`).join(', ')}.\nYou may append dated bullets to ${m.dir}/inbox.md and ${m.dir}/decisions.md (format: see ${m.dir}/README.md). Any other change in ${m.dir} needs the user's approval; do not attempt it unless asked.`
      : `\nIf the user asks you to remember something, dispatch a job that appends one dated bullet to ${m.dir}/inbox.md.`;
  return `\n\nThe user's own notes about their world (from ${m.dir}). Use them to understand names, projects and folders; do not repeat them back unless asked.\n<memory>\n${m.hot}\n</memory>${rules}`;
}
