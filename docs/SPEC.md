# AI OS — Claude Code build prompt

Oct 19, 2026 · @Roman Žydyk

## Decisions and how to use this

The prompt below builds a full-screen shell on top of macOS and Linux, from scratch, for you alone, with shell/files/browser as the agent's hands in v1. Working name: **Helm** (rename anywhere).

| Decision | Choice | Why it matters for the build |
| --- | --- | --- |
| Platform | macOS + Linux (Ubuntu) | Tauri 2 ships both from one codebase; no Windows work in v1 |
| Codebase | Greenfield, MIT | No T3 Code / Paperclip fork; those are reference points only |
| Agent hands | Shell, files, web (Playwright) | GUI-app driving via computer use is phase 2 |
| Users | Just you | Sign-in is Claude Code's own `claude login`; the app never stores tokens |
| Models | Haiku 5.5 front desk, Opus 5.5 workers | Instant acknowledgement, heavy work in the background |
| Billing | Your Claude subscription | Agent SDK use signed in with your plan draws from plan limits; API-key mode (Max credits $100/$200 per month) is a config switch |

&#91;embedded content: Helm architecture · front desk, queue, workers, inbox\]

The front desk only talks and dispatches; workers run in the background with real tools; anything risky or finished lands in the inbox and comes back to you.

**How to use it**

1. `mkdir helm && cd helm && git init && claude`
2. Paste the whole section "The prompt" as the first message (export this doc as Markdown if easier).
3. Claude Code will ask the questions marked **ASK ME** before scaffolding, then work milestone by milestone. Review after each milestone; don't let it run all five unattended.
4. Expect M0–M2 in one evening, M3–M4 in a second one. Watch your plan limits during M4 (parallel workers burn fast).

Sources: [Claude Agent SDK with your plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) · [Monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans) · [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

## The prompt

Paste everything from here to the end of this section into Claude Code.

**Project: Helm — a personal AI operating-system shell**

You are building Helm, an open-source (MIT) desktop shell that replaces the normal way of using a computer for one person: me. I say or type what I want; Helm makes it happen and reports back. There are no app icons, no settings menus to hunt through, no window juggling. Helm runs full-screen on macOS and Ubuntu Linux on top of the existing OS; it is not a kernel or a distro.

This is a solo, personal project. I use my own Claude subscription through Claude Code's own login. I am a data/platform engineer comfortable with TypeScript, Python, Kubernetes and Linux; explain decisions briefly, not basics.

**Non-negotiable product rules**

1. Responsive: every input gets a visible acknowledgement within 300 ms and a first model reply within about 1 s. Heavy work never blocks the input bar.
2. Two-speed brain: a fast "front desk" model (claude-haiku-5-5) answers, clarifies and dispatches; strong "worker" models (claude-opus-5-5 by default, configurable per job) do the real work in the background and report when done.
3. Chat or dictate: text input and push-to-talk voice are equal citizens from milestone 2 on.
4. Report back: every job ends with a short structured report (what was done, what changed, what needs me). Jobs that need a decision pause and ask instead of guessing.
5. Easy setup: one command installs and launches; first run checks for the `claude` CLI, runs `claude login` if needed, downloads the speech model, and shows a working screen. No Docker, no cloud account, no config files to hand-edit.
6. Safe by default: destructive or irreversible actions (deleting outside the job workspace, `sudo`, sending messages, payments, pushing to remotes) require an explicit approval card in the UI.
7. Open source hygiene: README, LICENSE (MIT), CONTRIBUTING, conventional commits, CI that runs tests and lint on both platforms.

**Authentication (do not deviate)**

- Use `@anthropic-ai/claude-agent-sdk` (TypeScript). It bundles the Claude Code binary and inherits the login state of `claude login`. Helm never reads, stores, proxies or displays OAuth tokens or session keys. If the CLI is not logged in, Helm opens a terminal-style panel that runs `claude login` and waits.
- Provide an optional `ANTHROPIC_API_KEY` mode (env var or settings toggle) that routes the same SDK calls through an API key. Default is subscription mode.
- Do not call the Messages API directly anywhere in v1; all model calls go through the Agent SDK so one auth path exists.

**Stack (use exactly this unless you have a strong reason, then ASK ME)**

- Shell: Tauri 2 (Rust host) + React 19 + TypeScript + Vite. Full-screen/kiosk window, global hotkey to summon/hide, tray icon. No Electron.
- Daemon: Node 22 + TypeScript, started by the Tauri host as a sidecar, talking to the UI over a local WebSocket (JSON messages, versioned schema in `packages/protocol`).
- Agent runtime: `@anthropic-ai/claude-agent-sdk`, one SDK session per job, `systemPrompt: { type: 'preset', preset: 'claude_code' }` for workers, a short custom system prompt for the front desk.
- Persistence: SQLite via `better-sqlite3` (jobs, events, reports, approvals, settings). One file in the user data dir.
- Voice: push-to-talk with `whisper.cpp` (via `whisper-node` or a thin native binding you justify), model `ggml-base` by default, downloaded on first run; streaming partial transcript into the input bar. On macOS you may use Apple's on-device speech as an alternative backend behind the same interface.
- Browser hands: Playwright MCP server attached to workers. Shell/file hands: the SDK's built-in Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch.
- Monorepo: pnpm workspaces — `apps/shell` (Tauri+React), `apps/daemon`, `packages/protocol`, `packages/agent` (front desk + worker wrappers), `packages/voice`.
- Tests: Vitest for TypeScript, Rust tests for the host, Playwright e2e for the shell. CI via GitHub Actions on macos-latest and ubuntu-latest.

**Architecture**

- Front desk: one long-lived SDK session on claude-haiku-5-5 with a system prompt that knows Helm's capabilities and the current job list. Uses structured output: `{ reply: string, action: 'answer' | 'clarify' | 'dispatch' | 'cancel' | 'status', jobs?: JobSpec[] }`. It answers trivial things itself (time, arithmetic, status of jobs), asks one clarifying question when the request is ambiguous, otherwise dispatches one or more JobSpecs. It must respond within one turn; it never calls tools except reading the job list.
- Job queue: SQLite table `jobs` (id, title, spec, status: queued | running | waiting\_approval | waiting\_input | done | failed | cancelled, model, cwd, created\_at, finished\_at). A scheduler runs up to N workers in parallel (default 2, setting).
- Workers: one SDK `query()` per job with streaming output. `cwd` is a per-job workspace under `~/Helm/jobs/<id>` unless the spec names a project path. Hooks: `PreToolUse` enforces the approval policy (pattern list in `packages/agent/policy.ts`) and emits events; `PostToolUse` and assistant messages become timeline events; `SessionEnd` triggers the report step. Workers can spawn SDK subagents for parallel sub-tasks.
- Report: when a worker finishes, a cheap claude-haiku-5-5 call turns the session transcript into `{ summary, changes: string[], artifacts: string[], needs_you: string[] }`. The report is stored, shown in the UI, and the front desk gets it as context so I can ask follow-ups.
- Approvals: a `PreToolUse` hook returns `deny` unless an approval row exists; the UI shows a card with the exact command/path; approve/deny resumes or fails the job. Approvals can be remembered per pattern for the session.
- Events: everything the UI shows is an append-only `events` table streamed over the WebSocket, so a reload or a second window never loses state.

**UI (keep it stark, fast, keyboard-first)**

- Home: one input bar at the bottom, large; above it the live job board (running jobs with latest timeline line, waiting-for-me jobs highlighted), then recent reports. Hold Space (or the hotkey) to dictate; the transcript streams into the bar; release to send.
- Job view: timeline (tool calls, messages, approvals), files touched, final report, buttons: open folder, retry, cancel, ask follow-up (goes to the front desk with the job as context).
- Inbox: everything waiting for me (approvals, clarifying questions).
- Settings: a single page — models, parallelism, mic device, speech model, workspace root, API-key mode. Nothing else.
- Visual: dark by default, one accent colour, system font, no icons grid, no windows. Think terminal meets kanban. Design tokens in one CSS file.

**Milestones (stop after each, show me, wait for my go)**

- M0 — Skeleton: monorepo, Tauri window launching the daemon sidecar, WebSocket ping, CI green on both platforms, README with the one-line install. Acceptance: `pnpm dev` opens a full-screen window that shows daemon status.
- M1 — Text loop: input bar → front desk → answer or dispatch → one worker on Opus → report card. Acceptance: "create a folder `notes` on my desktop with a README listing today's date" works end to end with the timeline visible while it runs; "what time is it" is answered by the front desk in under 1 s.
- M2 — Voice: push-to-talk, streaming transcript, first-run model download, mic picker. Acceptance: I dictate the M1 task and it runs; latency from release to dispatch under 1.5 s on an M-series Mac.
- M3 — Safety and parallelism: approval policy and cards, two concurrent workers, cancel, retry, inbox. Acceptance: a job that tries `rm -rf` outside its workspace pauses for approval; denying it fails the job with a clear report.
- M4 — Hands: Playwright MCP for web tasks, project-scoped jobs (`cwd` = an existing repo), follow-up questions on reports, job history search. Acceptance: "find the cheapest 1 TB NVMe on alza.cz and put a comparison table in a file" produces a file and a report; "in \~/code/foo, add a GitHub Action that runs tests" produces a branch, never a push.

**ASK ME before scaffolding**

1. Daemon packaging: bundle Node with Tauri's sidecar feature, or require a system Node 22? (My default: bundle.)
2. whisper.cpp binding choice and whether to ship the model in the installer or download on first run. (My default: download.)
3. Default workspace root (`~/Helm`) and whether jobs may touch `~` outside it without approval. (My default: no.)

**Working rules for you**

- Start by writing `CLAUDE.md` (architecture summary, commands, conventions) and a `docs/DECISIONS.md` ADR log; keep both current.
- Plan each milestone in a short checklist first, then implement, then run the tests, then summarise what changed and what you are unsure about. Prefer boring, well-maintained libraries. Do not add features outside the milestone.
- When a choice is ambiguous and not listed above, ask one concise question rather than assuming. If I am away, pick the reversible option and record it in `DECISIONS.md`.
- Commit at the end of each milestone with a conventional-commit message. Never push.
- Out of scope for v1: Windows, multi-user, cloud sync, driving GUI apps via computer use, TTS replies, mobile remote. Leave clean extension points for them (a `hands` interface, a `voice` interface).

## After the vertical slice

Once M4 works for a week of real use, these are the additions that turn a shell into something OS-like, roughly in order of payoff.

1. **Memory**: mount your `~/context` markdown repo into every worker's `settingSources` / CLAUDE.md so jobs know your projects, machines and conventions without being told each time.
2. **Heartbeat jobs**: recurring jobs on a schedule (the Paperclip pattern) — morning brief, inbox triage, stock monitor checks — reported into the same inbox.
3. **Computer use**: a `hands` backend that drives GUI apps (Anthropic's computer-use tool, or Agent S3 / UI-TARS) behind the same approval policy. This is the "never open an app again" step and the riskiest; keep it opt-in per job.
4. **Boot into Helm**: autologin plus a kiosk session on Ubuntu (a `helm.desktop` session file) and Login Items on macOS, so the full-screen shell is the first thing you see.
5. **Skills library**: let workers save a reusable `SKILL.md` after a task that worked (the Hermes pattern), reviewed by you before it becomes default.
6. **Spoken replies and remote**: TTS for reports when you are away from the screen; a phone view of the job board over Tailscale.

If you later open it to others, revisit auth first: the shell must keep delegating sign-in to `claude login` and offer API-key mode, never collect or proxy anyone's Claude credentials.
