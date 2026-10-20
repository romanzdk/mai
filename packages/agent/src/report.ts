import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Report } from '@mai/protocol';
import { ISOLATED, REPORT_MODEL, sdkEnv } from './sdk';

const SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One or two sentences: what was done and the outcome.',
    },
    changes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files or system state changed.',
    },
    artifacts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Absolute paths or URLs produced.',
    },
    needs_you: {
      type: 'array',
      items: { type: 'string' },
      description: 'Decisions or actions the user must take.',
    },
  },
  required: ['summary', 'changes', 'artifacts', 'needs_you'],
  additionalProperties: false,
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

function isReport(v: unknown): v is Report {
  const r = v as Report;
  return (
    typeof r?.summary === 'string' &&
    isStringArray(r.changes) &&
    isStringArray(r.artifacts) &&
    isStringArray(r.needs_you)
  );
}

export async function summarize(transcript: string, apiKeyMode: boolean): Promise<Report> {
  const q = query({
    prompt: `Write the report for this finished background job. Only state what the transcript shows.\n\n${transcript}`,
    options: {
      ...ISOLATED,
      model: REPORT_MODEL,
      tools: [],
      settingSources: [],
      persistSession: false,
      systemPrompt: 'You turn agent transcripts into short, factual job reports.',
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      env: sdkEnv(apiKeyMode),
    },
  });
  for await (const m of q) {
    if (m.type === 'result') {
      if (m.subtype === 'success' && isReport(m.structured_output)) return m.structured_output;
      throw new Error(`report failed: ${m.subtype}`);
    }
  }
  throw new Error('report ended without a result');
}
