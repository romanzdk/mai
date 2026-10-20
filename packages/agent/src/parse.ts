import type { JobSpec } from '@mai/protocol';

const OPEN = '<dispatch>';
const BLOCK = /<dispatch>([\s\S]*?)<\/dispatch>/;

export interface DeskOutput {
  reply: string;
  jobs: JobSpec[];
  error?: string;
}

// While streaming, hide the dispatch block and any partial "<disp..." at the end.
export function visibleReply(partial: string): string {
  const start = partial.indexOf(OPEN);
  if (start >= 0) return partial.slice(0, start).trimEnd();
  const lt = partial.lastIndexOf('<');
  if (lt >= 0 && OPEN.startsWith(partial.slice(lt))) return partial.slice(0, lt).trimEnd();
  return partial;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function toJobSpec(raw: unknown): JobSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { title, prompt, cwd, model } = raw as Record<string, unknown>;
  if (!isNonEmptyString(title) || !isNonEmptyString(prompt)) return null;
  if (cwd !== undefined && !(isNonEmptyString(cwd) && cwd.startsWith('/'))) return null;
  if (model !== undefined && !isNonEmptyString(model)) return null;
  return { title, prompt, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) };
}

export function parseDeskOutput(text: string): DeskOutput {
  const reply = visibleReply(text.replace(BLOCK, '')).trim();
  const match = text.match(BLOCK);
  if (!match) {
    return text.includes(OPEN)
      ? { reply, jobs: [], error: 'dispatch block was not closed' }
      : { reply, jobs: [] };
  }
  try {
    const parsed: unknown = JSON.parse(match[1] ?? '');
    const jobs = (Array.isArray(parsed) ? parsed : [parsed]).map(toJobSpec);
    if (jobs.length === 0 || jobs.some((j) => j === null)) {
      return { reply, jobs: [], error: 'dispatch block has an invalid job' };
    }
    return { reply, jobs: jobs as JobSpec[] };
  } catch {
    return { reply, jobs: [], error: 'dispatch block is not valid JSON' };
  }
}
