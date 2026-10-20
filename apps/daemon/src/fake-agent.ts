import type { Agent } from '@mai/agent';

// Deterministic stand-in for tests and e2e: no model calls, no subscription use.
// Messages containing "job" dispatch one job; anything else is echoed back.
export function createFakeAgent(): Agent {
  return {
    async desk(text, _ctx, onDelta) {
      onDelta('…');
      if (!text.includes('job')) return { reply: `echo: ${text}`, jobs: [] };
      return { reply: 'On it.', jobs: [{ title: text, prompt: text }] };
    },
    async runWorker({ spec, onEvent }) {
      onEvent({ kind: 'tool', tool: 'Bash', summary: 'echo working' });
      onEvent({ kind: 'text', text: `Did: ${spec.prompt}` });
      return { ok: true, result: 'done', transcript: `TASK: ${spec.prompt}` };
    },
    async summarize() {
      return { summary: 'Fake report.', changes: ['nothing'], artifacts: [], needs_you: [] };
    },
    close() {},
  };
}
