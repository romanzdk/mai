import type { Agent } from '@mai/agent';

// Deterministic stand-in for tests and e2e: no model calls, no subscription use.
// Messages containing "job" dispatch one job; anything else is echoed back. A job prompt with
// "delete" asks for approval first; one with "slow" runs until cancelled.
export function createFakeAgent(): Agent {
  return {
    async desk(text, _ctx, onDelta) {
      onDelta('…');
      if (text.startsWith('cancel '))
        return { reply: 'Stopping it.', jobs: [], cancel: [text.slice(7)] };
      if (!text.includes('job')) return { reply: `echo: ${text}`, jobs: [], cancel: [] };
      return { reply: 'On it.', jobs: [{ title: text, prompt: text }], cancel: [] };
    },
    async runWorker({ spec, onEvent, requestApproval, signal }) {
      onEvent({ kind: 'tool', tool: 'Bash', summary: 'echo working' });
      if (spec.prompt.includes('delete')) {
        const command = 'rm -rf ~/Documents/old';
        onEvent({ kind: 'tool', tool: 'Bash', summary: command });
        const answer = await requestApproval({
          ruleId: 'delete',
          reason: 'deletes files',
          tool: 'Bash',
          command,
        });
        if (answer === 'denied') return { ok: false, result: 'denied', transcript: 'denied' };
      }
      if (spec.prompt.includes('slow')) {
        await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        return { ok: false, result: 'cancelled', transcript: 'cancelled' };
      }
      onEvent({ kind: 'text', text: `Did: ${spec.prompt}` });
      return { ok: true, result: 'done', transcript: `TASK: ${spec.prompt}` };
    },
    async summarize() {
      return { summary: 'Fake report.', changes: ['nothing'], artifacts: [], needs_you: [] };
    },
    async authState() {
      return 'logged_in';
    },
    openLogin() {},
    async usage() {
      const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
      return {
        fiveHour: { pct: 42, resetsAt: inHours(2) },
        week: { pct: 18, resetsAt: inHours(80) },
        models: [{ name: 'Opus', pct: 31, resetsAt: inHours(80) }],
        checkedAt: Date.now(),
      };
    },
    close() {},
  };
}
