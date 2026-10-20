# Contributing

1. `pnpm install`
2. Make the change. Keep it small and inside the current milestone.
3. Run the checks:
   ```sh
   pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
   (cd apps/shell/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
   ```
4. Commit with [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`,
   `chore:`, `docs:`, `test:`, `refactor:`).

Architecture decisions go in [docs/DECISIONS.md](docs/DECISIONS.md).
