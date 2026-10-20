# Decisions

Short ADR log. Newest at the bottom. Status is `accepted` unless noted; `provisional` means picked
while the owner was away and can be reversed cheaply.

## 001 — Name: mai (2026-10-20)

The spec's working name was Helm. Renamed to **mai** everywhere (packages `@mai/*`, workspace
`~/mai`, app title).

## 002 — Daemon ships with a bundled Node 24 (2026-10-20)

Tauri `externalBin` sidecar `binaries/node-<triple>` plus the esbuild bundle
`apps/daemon/dist/daemon.mjs` as a resource. `scripts/fetch-node.mjs` (root `postinstall`)
downloads the pinned official Node binary and checks its SHA-256. Node 24 instead of the spec's
22: it is the current LTS and the only one installed locally.

The host passes a random 32-byte token in `MAI_TOKEN`; the daemon prints
`MAI_DAEMON_READY {"port":N}` on stdout; the host hands `{url, token}` to the UI via the
`daemon_info` command / `daemon-ready` event. Any local process or web page can reach
`127.0.0.1`, so the token is required on every WebSocket connection. The daemon exits on stdin EOF
so it never outlives the host.

## 003 — Speech: whisper.cpp `whisper-server` sidecar (2026-10-20)

Run whisper.cpp's prebuilt server as a local process; ggml-base downloaded on first run. Avoids
node-gyp native bindings. Implemented in M2.

## 004 — Approval scope outside the workspace (2026-10-20)

Workspace root `~/mai`. Jobs may read and write anywhere in `~` without approval. Approval cards
are required for deletes, `sudo`, pushing to remotes, sending messages and payments. This is
looser than the spec's default; implemented in M3.

## 005 — Lint/format with Biome (2026-10-20)

One dev dependency for lint and format instead of ESLint + Prettier + typescript-eslint.

## 006 — e2e drives the React UI in Chromium, not the Tauri WebView (2026-10-20)

There is no Playwright/WebDriver driver for WKWebView on macOS. Playwright starts the real daemon
and Vite, and the UI reads `VITE_MAI_DAEMON_URL` / `VITE_MAI_TOKEN` when not inside Tauri. The Rust
host has its own cargo tests.

## 007 — Toggle hotkey `Cmd/Ctrl+Shift+Space` (2026-10-20, provisional)

`Cmd+Space` is Spotlight/Raycast, `Option+Space` is often taken too. One constant in
`apps/shell/src-tauri/src/lib.rs`.

## 008 — App identifier `dev.mai.shell` (2026-10-20, provisional)

Decides the data dir (`~/Library/Application Support/dev.mai.shell`,
`~/.local/share/dev.mai.shell`). Change before any user data exists.

## 009 — Workspace packages created when first needed (2026-10-20)

The spec lists `packages/agent` and `packages/voice`. They are added in M1 and M2, not as empty
stubs in M0.

## 010 — SQLite via built-in `node:sqlite` (2026-10-20)

The daemon runs on the bundled Node 24, which has SQLite built in. No native module
(`better-sqlite3`) to build and ship per platform. One file: `<app data dir>/mai.db`.

## 011 — Front desk: one warm session, streamed text, `<dispatch>` block (2026-10-20)

Measured on an M-series Mac with Haiku 5.5 through the Agent SDK:

| Setup | First text | Whole turn |
| --- | --- | --- |
| New session per turn | — | +3.6 s spawn |
| Warm session + structured output | ~1.4–2.5 s | ~4.5–5 s |
| Warm session, streamed text, thinking off, effort low | ~0.65–1.25 s | ~1.0–1.8 s |

So the desk is one long-lived streaming-input session started at daemon boot. It writes plain
text; to dispatch it ends with `<dispatch>[{title, prompt, cwd?, model?}]</dispatch>`, which the
daemon parses and validates (`packages/agent/src/parse.ts`) and hides from the streamed text.
A bad block is reported as a `desk_error`, never half-dispatched. The spec's `action` field is
implied: dispatch block → dispatch, otherwise answer or clarify. Cancel/status actions come in M3.
Each user turn is prefixed with a `<context>` block: local time, job list, last 5 reports.

## 012 — Agent sessions are isolated from the user's Claude Code setup (2026-10-20)

Without options, SDK sessions load `~/.claude` settings, hooks, plugins, MCP servers and the
claude.ai connectors (Gmail, Slack, …). All sessions pass `strictMcpConfig`, empty `mcpServers`
and `disableClaudeAiConnectors`. Desk and report use `settingSources: []`; workers use
`['project']` so a project's own CLAUDE.md/settings apply in M4.

## 013 — Agent SDK stays outside the daemon bundle (2026-10-20, open)

The SDK resolves a per-platform Claude Code binary package at runtime, so esbuild marks it
external and the daemon depends on it directly. Dev builds run `apps/daemon/dist/daemon.mjs`
in place so `node_modules` resolves. **Open:** a release build (`pnpm build`) does not yet ship
the SDK and its binary package; solve with the installer work.

## 014 — Workers: `dontAsk` + allow-list + policy hook (2026-10-20)

Workers run with `permissionMode: 'dontAsk'`, an explicit tool allow-list, `additionalDirectories:
[~]` (decision 004), and a `PreToolUse` hook that checks `packages/agent/src/policy.ts`. Until
approval cards exist (M3), anything that needs approval is denied with a reason and the worker is
told not to work around it. Timeline events come from the SDK message stream, not
`PostToolUse` hooks: same data, plus assistant text, and tool output for the report transcript.

## 015 — Subscription mode strips `ANTHROPIC_API_KEY` (2026-10-20)

So a key in the environment never silently moves billing to the API. `MAI_API_KEY_MODE=1`
keeps it. The settings toggle comes with the settings page.

## 016 — Fake agent for tests and e2e (2026-10-20)

`MAI_FAKE_AGENT=1` swaps in `apps/daemon/src/fake-agent.ts`: no model calls, so CI needs no
login and spends nothing. Real-model checks are run by hand per milestone.
