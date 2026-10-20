import { type JobSpec, parseCron, type ScheduleSpec } from '@mai/protocol';

const TAGS = ['dispatch', 'cancel', 'schedule', 'unschedule'] as const;
const block = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);

export interface DeskOutput {
  reply: string;
  jobs: JobSpec[];
  cancel: string[];
  schedules: ScheduleSpec[];
  unschedule: string[];
  error?: string;
}

// While streaming, hide action blocks and any partial opening tag at the end.
export function visibleReply(partial: string): string {
  let text = partial;
  for (const tag of TAGS) {
    const start = text.indexOf(`<${tag}>`);
    if (start >= 0) text = text.slice(0, start);
  }
  const lt = text.lastIndexOf('<');
  if (lt >= 0 && TAGS.some((tag) => `<${tag}>`.startsWith(text.slice(lt)))) {
    text = text.slice(0, lt);
  }
  return text === partial ? partial : text.trimEnd();
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

function toScheduleSpec(raw: unknown): ScheduleSpec | null {
  const job = toJobSpec(raw);
  const { cron, when } = (raw ?? {}) as Record<string, unknown>;
  if (!job || !isNonEmptyString(cron) || !isNonEmptyString(when)) return null;
  try {
    parseCron(cron);
  } catch {
    return null;
  }
  return { ...job, cron: cron.trim(), when: when.trim() };
}

// Returns the parsed list, [] when the block is absent, or an error string.
function readBlock<T>(text: string, tag: string, item: (raw: unknown) => T | null): T[] | string {
  const match = text.match(block(tag));
  if (!match) return text.includes(`<${tag}>`) ? `${tag} block was not closed` : [];
  try {
    const parsed: unknown = JSON.parse(match[1] ?? '');
    const items = (Array.isArray(parsed) ? parsed : [parsed]).map(item);
    if (items.length === 0 || items.some((x) => x === null))
      return `${tag} block has an invalid entry`;
    return items as T[];
  } catch {
    return `${tag} block is not valid JSON`;
  }
}

export function parseDeskOutput(text: string): DeskOutput {
  let stripped = text;
  for (const tag of TAGS) stripped = stripped.replace(block(tag), '');
  const reply = visibleReply(stripped).trim();
  const ids = (raw: unknown) => (isNonEmptyString(raw) ? raw : null);
  const jobs = readBlock(text, 'dispatch', toJobSpec);
  const cancel = readBlock(text, 'cancel', ids);
  const schedules = readBlock(text, 'schedule', toScheduleSpec);
  const unschedule = readBlock(text, 'unschedule', ids);
  const errors = [jobs, cancel, schedules, unschedule].filter(
    (x): x is string => typeof x === 'string',
  );
  // Never act on half of a malformed answer.
  if (errors.length) {
    return { reply, jobs: [], cancel: [], schedules: [], unschedule: [], error: errors.join('; ') };
  }
  return {
    reply,
    jobs: jobs as JobSpec[],
    cancel: cancel as string[],
    schedules: schedules as ScheduleSpec[],
    unschedule: unschedule as string[],
  };
}
