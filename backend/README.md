# TaskFlow backend

The Rust API behind TaskFlow, built on the [Umbral](https://dalmasonto.github.io/umbral/docs/v0.0.1/getting-started/your-first-app) framework. It serves the REST API, the realtime event stream, auth, media, and an admin site.

Most of the product lives in plugins under `plugins/`:

| Plugin | Responsibility |
| --- | --- |
| `taskflow-projects` | Projects, members, invites, API bases |
| `taskflow-tasks` | Tasks, board state, activity |
| `taskflow-agents` | Agent identities, sessions, chat, terminal streams |
| `taskflow-design` | Design pages, components, tokens, themes, and rendering |
| `taskflow-github` | GitHub linking and issue sync |
| `taskflow-toolbox` | The project's shared scripts and notes |

`renderer/` is a separate sidecar that takes design screenshots in headless Chromium. It holds no secrets or database access, so a page that escapes the browser has nothing to reach.

## Run

The app does not migrate on boot, so run migrations after checkout and after any schema change:

```bash
cargo run -- migrate
cargo run                     # serves on 127.0.0.1:8000 (see umbral.toml)
cargo run -- createsuperuser  # admin account for /admin/
```

Test every crate, including the plugins:

```bash
cargo test --workspace
```

## Deploy

`docker-compose.yml` runs Postgres, a one-shot migration, the API on `127.0.0.1:10002`, MinIO storage, the static frontend on `127.0.0.1:10003`, and the renderer. A reverse proxy on the host exposes the API and frontend.

Production settings live in `.prod.env`, which is gitignored. A `sops` and `age` encrypted copy is committed as `secret.env`:

```bash
bash ../scripts/encrypt_envs.sh <age-public-key>
sops --decrypt secret.env > .prod.env
```

The `deploy-backend` workflow builds the binary and frontend in CI, copies them to the server, and restarts the stack. It needs the `AGE_PRIVATE_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, and `SSH_PRIVATE_KEY` repository secrets.

To create an admin on the server, run the command through the `web` service:

```bash
docker compose run --rm web createsuperuser
```

## Vendored Umbral crates

`vendor/` holds patched copies of three Umbral 0.0.10 crates (`umbral-core`, `umbral-rest`, `umbral-storage`), wired in through `[patch.crates-io]` in `Cargo.toml`. The fixes are upstream and ship in Umbral 0.0.11. Do not edit these copies. When 0.0.11 is released, bump every `umbral*` version, delete the patch block and `vendor/`, and run `cargo test --workspace`.
