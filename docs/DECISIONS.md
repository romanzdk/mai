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

## 017 — M2 (voice) skipped (2026-10-20)

The owner dictates with Wispr Flow, which types into the focused input bar. Decisions 003 and
the `packages/voice` plan are parked; the spec's `voice` extension point stays unbuilt.

## 018 — Approvals: the hook waits (2026-10-20)

A risky tool call creates an `approvals` row and an `approval_requested` event, sets the job to
`waiting_approval`, and the worker's `PreToolUse` hook simply awaits the decision (matcher
timeout one week). Approve → the call runs and the job goes back to `running`. Deny → the hook
returns `deny` with `continue: false`, the session stops, a report is still written, and the
job fails with `you denied: <command>`. On daemon restart, pending approvals become `expired`
and their jobs fail. "Remember" covers the same rule in the same job folder until mai
restarts; it never persists.

## 019 — Deletes inside the job folder (2026-10-20)

Free only when every target is an absolute or `~/` path that resolves, after symlinks, strictly
inside the job's own folder, and the segment has no quotes, globs, braces, variables or
substitutions. Relative paths always ask: the Bash tool keeps its own working directory
between calls and the hook's `cwd` does not follow `cd` (measured). Project jobs (M4) have no
free deletes. Known ceiling: this is a regex screen, not a shell parser; `mv x /dev/null`,
`> file` truncation and similar are not caught.

## 020 — Cancel and retry (2026-10-20)

Cancel aborts the SDK query (the worker's Claude process and its child commands exit — measured),
denies its pending approvals, and marks the job `cancelled` without a report. Retry creates a new
job with the same spec and `retryOf`, in a fresh workspace folder. The desk can cancel by id via
`<cancel>["id"]</cancel>`; it cannot approve anything — approvals are UI-only.

## 021 — Login via the system terminal (2026-10-20)

Auth is read with the SDK's bundled binary: `claude auth status --json`. "Sign in" opens the
system terminal (Terminal.app / `x-terminal-emulator`) running `claude auth login` and polls
status every 3 s for up to 10 min. No in-app terminal emulator, no native pty module.

## 022 — Workers get the login shell's PATH (2026-10-20)

Started from Finder or the dock, the app inherits launchd's short PATH. The daemon reads
`$SHELL -ilc` once at start (5 s timeout) and uses that PATH, so workers find Homebrew, nvm,
cargo and the like.

## 023 — Browser hands: Playwright MCP, isolated, headed (2026-10-20)

Each worker gets its own `@playwright/mcp` server (Chromium, `--isolated` in-memory profile, so
no cookies or logins of the user's). It runs headless by default (owner's choice, 2026-10-20). Known cost:
headless Chromium got a Cloudflare 403 on alza.cz where a headed one passed;
`MAI_BROWSER_HEADED=1` shows the browser.
`pnpm install` downloads the matching Chromium (skipped in CI).

## 024 — Web actions that need approval (2026-10-20)

`browser_click/type/fill_form/select_option/check` ask when the worker's own element
description looks like buying, sending, submitting, confirming or deleting (English and Czech
stems), or when typed text is submitted outside a search box. `browser_evaluate`,
`browser_run_code_unsafe` (arbitrary page code) and `browser_file_upload` always ask. Workers are
told to read pages with `browser_snapshot`. Ceiling: judged from descriptions, not the page.

## 025 — Git project jobs run in a worktree on `mai/<job id>` (2026-10-20)

A job whose `cwd` is a git repo gets `git worktree add -b mai/<id> ~/mai/jobs/<id>/<repo> HEAD`.
The user's checkout is never touched, uncommitted local changes are not included, and jobs on
the same repo run side by side. The worker commits there and never pushes (push needs
approval). A follow-up job on that job's folder branches from the previous job's branch.
The worktree is removed (never forced, so uncommitted work keeps it) when the
job is dismissed, or when its branch is merged into the project's HEAD (checked at start and
every 10 min). The branch itself is never deleted. Workers must not disable
commit signing: if signing fails they leave changes uncommitted.

## 026 — Follow-ups and history search (2026-10-20)

"Ask follow-up" sends the next input with `aboutJobId`; the desk then sees that job's
instructions, folder, branch, report and last 15 steps, and dispatches more work into the same
folder. History search filters all jobs client-side (title, instructions, folder, branch,
report). ponytail: the UI loads every event on connect; page by job when that gets slow.

## 027 — UX review pass (2026-10-20)

Four review agents (keyboard flow, visual hierarchy, trust and states, accessibility) looked at
screenshots of every state plus the code; their merged findings were implemented:

- Focus rests in the input (dictation types into whatever is focused): it returns after
  mouse clicks, Esc and view changes; typing anywhere lands in it. Requests typed while
  disconnected are queued and sent on connect; approvals and other actions never queue.
- Shortcuts are Cmd (macOS) / Ctrl (Linux) chords, shown next to their buttons: Y approve,
  N deny, I inbox, F history, `.` cancel, R retry, O open folder, D dismiss, 1–9 open a
  row. Single letters are avoided because dictation types plain characters. Esc goes back one
  view (or clears a history search first).
- Approval cards show what the user asked, what the agent said before asking, the job
  folder, paths outside it, and the consequence; Approve is disabled for 1 s and shows
  progress; Deny reads "Deny and stop job". "Remember" is only offered (and only honoured by
  the daemon) for `REMEMBERABLE_RULES` (git push, page code), scoped to the job — one
  remembered delete would otherwise allow every later delete in that job.
- Home is bottom-anchored like a terminal: recent → active (approval cards replace their
  row) → conversation → input. Rows show status in colour, "needs you", elapsed time and a
  stale warning after 90 s. Failed jobs the user did not deny go to the inbox.
- The tray shows the waiting count, the window title carries it, and the dock/taskbar asks
  for attention when something new waits while mai is hidden or unfocused. A Restart button
  appears when the daemon exits.
- Tokens: a mono stack that does not fall back to Courier, `--text-2`, `--muted` raised to
  6:1, `--edge` for control borders (3:1), size scale, 1200 px max width, a global focus ring,
  a polite live region, and zoom hotkeys.

## 028 — Visual design "Violet Glass", status bar, inbox sidebar (2026-10-20)

Three designers built competing directions in separate worktrees (glass, terminal, calm);
the owner picked glass. The other two are kept on the `design/terminal` and `design/calm`
branches, unmerged.

The top bar doubles as the status bar: job counts (running, queued, needs you), Claude plan
usage (5-hour and weekly percentage with reset time; amber at 80 %, red at 95 %; per-model
buckets in the tooltip; paid extra credits only when they have a real limit) and a 24-hour
clock with the date. Plan usage comes from the Agent SDK's `/usage` data on the warm desk
session, polled every 5 minutes and after each job. The SDK marks that call experimental,
so a failure keeps the last known numbers and never breaks anything; it is null in API-key
mode. Home gets an always-visible inbox sidebar (approvals and needs-you items) that stacks
above the board on windows narrower than 1180 px.

The view stays pinned to the bottom unless the user scrolls up themselves: only wheel, touch,
scrollbar drag and PageUp unpin it, because the browser's own scroll adjustments during
reflow were unpinning it on resize.
