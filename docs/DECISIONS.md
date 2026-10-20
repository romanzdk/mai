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
