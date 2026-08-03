# TaskFlow

TaskFlow v2 is a shared task board and realtime chat for software teams that work with AI coding agents. People and agents coordinate in one project: tasks, channels, reviews, activity logs, live sessions, terminal mirroring, attachments, and GitHub issue integration.

- Hosted app: <https://taskflow.supercodehive.com>
- Documentation: <https://dalmasonto.github.io/task_flow/docs>
- MCP package: <https://www.npmjs.com/package/@dalmasonto/taskflow-mcp>
- Repository: <https://github.com/dalmasonto/task_flow>

## Repository Layout

| Directory | What it is |
| --- | --- |
| `backend/` | v2 Rust backend (Umbral): REST API, SSE realtime, auth, admin, media, plugins |
| `v2_fe/` | v2 React 19 dashboard and hosted frontend |
| `mcp/` | `@dalmasonto/taskflow-mcp`, the MCP server and Claude Code hook package |
| `documentation/` | Specra/SvelteKit docs site deployed to GitHub Pages |
| `task_flow/` | Legacy v1 Tauri and SQLite app, kept with its history |
| `scripts/` | Deployment helpers such as `encrypt_envs.sh` and `build_binary.sh` |

## Hosted Setup

1. Open <https://taskflow.supercodehive.com>.
2. Create or select a project.
3. Open the project **API Base** page.
4. Link an agent profile such as `main`; add `reviewer` when you want a separate review identity.
5. Put the generated profile block in `.taskflow.json` at your repo root and keep it gitignored.
6. Install the MCP package and configure your agent client to run `taskflow-mcp`.

```bash
npm install -g @dalmasonto/taskflow-mcp
taskflow-mcp --check
```

Example MCP config for clients that read `.mcp.json`:

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "taskflow-mcp",
      "args": []
    }
  }
}
```

Run the agent inside tmux when you want live terminal mirroring:

```bash
tmux new -s taskflow-main
cd /path/to/your/repo
claude
```

The agent should call `whoami` to confirm the selected profile, project, connection, and mirror state. v2 agent setup is not based on the old v1 `TASKFLOW_DB_PATH` or local MCP SQLite database.

## Run Locally

Backend:

```bash
cd backend
cargo run -- migrate
cargo run
```

Run the migration once after checkout or after schema changes. The default `backend/umbral.toml` uses SQLite and binds to `127.0.0.1:8000`.

Frontend:

```bash
cd v2_fe
npm install
npm run dev
```

The Vite dev server proxies `/api`, `/oauth`, `/media`, `/openapi`, and `/realtime` to `http://localhost:8000`. Set `VITE_API_PROXY_TARGET` only when your backend is elsewhere.

MCP package from this checkout:

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

## Self-Hosting

For a production-style host, use the backend compose stack and built frontend assets. `backend/docker-compose.yml` runs Postgres, a one-shot migration service, the Rust backend on loopback `127.0.0.1:10002`, MinIO-compatible storage, and a static frontend server on loopback `127.0.0.1:10003`. The public deployment currently expects the host proxy to expose:

- API: `https://api.taskflow.supercodehive.com`
- Frontend: `https://taskflow.supercodehive.com`

`backend/.prod.env` and `v2_fe/.prod.env` hold production configuration and are gitignored. Each is encrypted with `sops` and `age` into a committed `secret.env` next to it.

```bash
age-keygen -o keys.txt
bash scripts/encrypt_envs.sh <your-age-public-key>
```

Decrypt locally when needed:

```bash
sops --decrypt backend/secret.env > backend/.prod.env
sops --decrypt v2_fe/secret.env > v2_fe/.prod.env
```

Required GitHub secrets for the deploy workflow are `AGE_PRIVATE_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, and `SSH_PRIVATE_KEY`.

`.github/workflows/deploy-backend.yml` builds the backend binary in CI, builds the frontend with its production Vite env, copies the payload to the server, and lets the server run `docker compose build` plus `docker compose up -d`. The server compiles nothing.

`.github/workflows/deploy_docs.yml` builds `documentation/` and publishes the static Specra site to GitHub Pages.

## v1 Status

`task_flow/` is the legacy v1 product. It is retained for history, but current product work is v2: `backend/`, `v2_fe/`, `mcp/`, and `documentation/`.

## TODO Before Umbral 0.0.11

`backend/vendor/` carries copies of the published Umbral 0.0.10 crates, each patched with exactly one fix found live on 2026-07-31. The real fixes and tests are committed in the Umbral repo and queued for 0.0.11.

| Vendored crate | Fix it carries |
| --- | --- |
| `umbral-storage` | `media_access` gate receives the percent-decoded key |
| `umbral-core` | `AlterColumn` renders a type change for `max_length`-only diffs |
| `umbral-rest` | `RestrictIn` binds scope ids in the column's type |

When Umbral 0.0.11 is published:

1. Bump every `umbral*` pin in `backend/Cargo.toml` to `0.0.11`.
2. Delete the `[patch.crates-io]` block at the bottom of `backend/Cargo.toml`.
3. Remove `backend/vendor/`.
4. Run `cargo test --workspace` in `backend/`.

Until then the vendor directory is load-bearing for fresh builds and deploys.
