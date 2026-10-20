import type { Options } from '@anthropic-ai/claude-agent-sdk';

export const DESK_MODEL = 'claude-haiku-5-5';
export const WORKER_MODEL = 'claude-opus-5-5';
export const REPORT_MODEL = 'claude-haiku-5-5';

// Without these, every session inherits the user's own MCP servers and claude.ai connectors
// (Gmail, Slack, ...), which is slower and hands tools to agents nobody asked for.
export const ISOLATED = {
  strictMcpConfig: true,
  mcpServers: {},
  settings: { disableClaudeAiConnectors: true },
} satisfies Options;

// Subscription mode is the default, so an ANTHROPIC_API_KEY in the environment must not
// silently switch billing to the API.
export function sdkEnv(apiKeyMode: boolean): NonNullable<Options['env']> {
  const env: NonNullable<Options['env']> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'mai' };
  if (!apiKeyMode) delete env.ANTHROPIC_API_KEY;
  return env;
}
