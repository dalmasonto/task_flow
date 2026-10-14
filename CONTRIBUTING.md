# Contributing to TaskFlow

Thanks for your interest in improving TaskFlow. This guide covers how to set up the project, what a good change looks like, and how it gets merged.

## Before you start

- **Bugs**: open an issue with steps to reproduce, what you expected, what happened, and your environment (OS, browser, agent client, MCP version from `taskflow-mcp --version`).
- **Features**: open an issue to discuss the idea before writing code. A short conversation up front saves rework on both sides.
- **Small fixes** (typos, docs, obvious one-line bugs) can go straight to a pull request.
- **Security issues**: do not open a public issue. Contact the maintainer privately through the GitHub profile at <https://github.com/dalmasonto>.

Current product work is v2: `backend/`, `v2_fe/`, `mcp/`, and `documentation/`. The legacy v1 app in `task_flow/` is kept for history and does not take new features.

## Local setup

You need Rust (stable, edition 2024), Node.js 20+, npm, and pnpm (for the docs site only).

Backend (SQLite by default, listens on `127.0.0.1:8000`):

```bash
cd backend
cargo run -- migrate   # the app does not migrate on boot; rerun after schema changes
cargo run
```

Frontend (Vite proxies `/api`, `/oauth`, `/media`, `/openapi`, and `/realtime` to the backend):

```bash
cd v2_fe
npm install
npm run dev
```

MCP package:

```bash
cd mcp
npm install
npm run build
```

Docs site:

```bash
cd documentation
pnpm install
pnpm dev
```

## Checks to run before opening a PR

Run the checks for every area you touched:

| Area | Commands |
| --- | --- |
| `backend/` | `cargo test --workspace` (plain `cargo test` skips the plugin crates in `backend/plugins/`) |
| `v2_fe/` | `npm run lint`, `npm test`, `npm run build` |
| `mcp/` | `npm run typecheck`, `npm test`, `npm run build` |
| `documentation/` | `pnpm build` |

If a schema change is involved, add a new migration. Never edit or regenerate a migration that has already been merged: databases that already applied it will never run the new version.

Do not patch files under `backend/vendor/`. If the framework needs a fix, work around it in this repo and describe the gap in your PR.

## Making a change

1. Fork the repository and create a branch from `main` (for example `fix/sidebar-counts` or `feat/design-compare`).
2. Keep each PR to one concern. Unrelated cleanups belong in their own PR.
3. Add or update tests for behavior you change. Bug fixes should come with a test that fails without the fix.
4. Update `documentation/` and the relevant README when you change user-facing behavior, an API, or an MCP tool.
5. Never commit secrets: `.prod.env` files, `.taskflow.json` profiles, API keys, or `age` keys. Production config is committed only in its `sops`-encrypted `secret.env` form.

### Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope, written in the imperative or as a plain statement of the outcome:

```
fix(sidebar): a counts failure must not take the dashboard with it (#706)
perf(db): index the reads that scan the whole table to serve one page (#701)
feat(agents): per-key capability toggles (#700)
```

Common types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`. Reference the issue number when there is one.

### Pull requests

Describe what changed and why, how you tested it, and include screenshots or a short recording for UI changes. A maintainer will review it; please respond to review comments with further commits rather than force-pushing over the discussion.

## Licensing of contributions

TaskFlow is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). It is free for noncommercial use, and the copyright holder offers commercial licenses separately.

To keep that possible, by submitting a contribution you agree that:

1. You wrote it, or otherwise have the right to submit it under these terms.
2. Your contribution is licensed to the public under the project's license (PolyForm Noncommercial 1.0.0).
3. You also grant Dalmas Ogembo, the project's copyright holder, a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, modify, sublicense, and distribute your contribution under any terms, including commercial licenses.

You keep the copyright to your contribution. If you cannot agree to these terms (for example, because your employer owns your work), say so in the PR before it is merged.

## Code of conduct

Be respectful and constructive. Critique code, not people. Maintainers may close issues, PRs, or discussions that are abusive or off-topic.
