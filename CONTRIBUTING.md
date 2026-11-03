# Contributing

mai is a proof of concept and is no longer actively developed, so pull requests may not get a
review. Forks are welcome.

1. `pnpm install`
2. Make the change. Keep it small and focused.
3. Run the checks:
   ```sh
   pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
   (cd apps/shell/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
   ```
4. Commit with [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`,
   `chore:`, `docs:`, `test:`, `refactor:`).

Architecture decisions go in [docs/DECISIONS.md](docs/DECISIONS.md).
