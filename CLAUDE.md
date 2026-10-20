# mai

Personal AI shell (spec: `docs/SPEC.md`, working name there is Helm). Decisions: `docs/DECISIONS.md`
— add an entry for every non-obvious choice.

## Architecture

- `apps/shell` — Tauri 2 host (`src-tauri/src/lib.rs`) + React 19 UI (`src/`). The host spawns the
  daemon sidecar, generates the WebSocket token, owns tray + global hotkey, and passes
  `{url, token}` to the UI (`daemon_info` command, `daemon-ready` / `daemon-exit` events).
- `apps/daemon` — Node 24 process. WebSocket server on `127.0.0.1`, token-checked. Bundled by
  esbuild to `dist/daemon.mjs`, which Tauri ships as a resource next to the bundled `node` binary.
- `packages/protocol` — versioned JSON message types (`PROTOCOL_VERSION`), consumed as TS source.
- Planned: `packages/agent` (front desk + workers, Agent SDK), `packages/voice` (whisper-server).

All model calls go through `@anthropic-ai/claude-agent-sdk`. Never read, store or proxy OAuth
tokens; never call the Messages API directly.

## Commands

```sh
pnpm install            # also fetches the Node sidecar binary
pnpm dev                # build daemon, open the Tauri window
pnpm lint | typecheck | test
pnpm test:e2e           # Playwright: real daemon + Vite in Chromium
cd apps/shell/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

In Claude Code's Bash on the owner's Mac, `node`/`npm` are broken nvm shell functions. Prefix:
`unset -f node npm npx nvm; export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH`.

## Conventions

- Biome for lint/format (single quotes, 2 spaces, width 100). rustfmt + clippy `-D warnings`.
- Conventional commits. Commit at the end of each milestone. Never push.
- Work milestone by milestone (M0–M4 in the spec); stop after each for review.
- Comments only for non-obvious why.
