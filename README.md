# TaskFlow

Local-first task board and realtime chat with MCP integration, built for
multi-agent collaboration.

| Directory | What it is |
|---|---|
| `backend/` | v2 Rust backend (Umbral): REST API, SSE realtime, admin, media |
| `v2_fe/` | v2 frontend: React 19 + Vite + TypeScript |
| `mcp/` | MCP server bridging agents into projects, channels and tasks |
| `task_flow/` | v1 app (Tauri + SQLite), kept with its full history |
| `scripts/` | `encrypt_envs.sh` (sops + age), `build_binary.sh` |

## Secrets (sops + age)

`backend/.prod.env` and `v2_fe/.prod.env` hold the production environments and
are gitignored. Each is encrypted with [sops](https://github.com/getsops/sops)
+ [age](https://github.com/FiloSottile/age) into a `secret.env` next to it,
which **is** committed, and decrypted by CI on deploy.

```bash
age-keygen -o keys.txt                              # one-time: generate a key pair
bash scripts/encrypt_envs.sh <your-age-public-key>  # both .prod.env -> secret.env
```

Decrypt locally with `sops --decrypt backend/secret.env > backend/.prod.env`
(same for `v2_fe/`). Put the private key from `keys.txt` into the
`AGE_PRIVATE_KEY` repo secret. `keys.txt` and both `.prod.env` files are
gitignored and excluded from the deploy payload and the Docker image.

The two envs differ in where they are consumed:

- **backend/.prod.env** travels to the server inside the deploy payload; the
  Dockerfile bakes it into the image as `/app/.env` on the box. It never
  passes through a CI artifact or a published image.
- **v2_fe/.prod.env** never leaves CI: Vite bakes `VITE_*` vars into the JS
  bundle at build time, so the workflow decrypts it, sources it around
  `npm run build`, and ships only the built `dist/`.

sops's dotenv parser rejects blank lines, so `.prod.env` uses `#` comment
lines as separators. `encrypt_envs.sh` strips blank lines if any reappear.

## Deploy

`.github/workflows/deploy-backend.yml` is manual (`workflow_dispatch`): CI
compiles the backend binary in `rust:1-bookworm` (same Debian 12 / glibc as
the runtime image), builds the frontend with its prod env, and ships both to
the server, where `docker compose build` assembles the runtime image from a
handful of COPY layers — the server compiles nothing. See
`backend/docker-compose.yml` for the stack (postgres → migrate → web on
:10002, plus a static file server for the frontend dist on :10003 — ports are
published directly, no reverse proxy).

Required GitHub secrets: `AGE_PRIVATE_KEY`, `CONTABO_HOST`, `CONTABO_USER`,
`SSH_PRIVATE_KEY`.

## TODO before/at umbral 0.0.11

`backend/vendor/` carries copies of the **published umbral 0.0.10** crates,
each patched with exactly one fix found live on 2026-07-31 (the real fixes +
tests are committed in the umbra repo, queued for 0.0.11 behind the open
gaps4.md items):

| Vendored crate | The one fix it carries |
|---|---|
| `umbral-storage` | media_access gate receives the percent-decoded key (spaced uploads 403'd as orphans) |
| `umbral-core` | `AlterColumn` renders a TYPE change for `max_length`-only diffs (widened models never reached Postgres DDL) |
| `umbral-rest` | `RestrictIn` binds scope ids in the column's type (`bigint = text` 500'd every scoped LIST on Postgres) |

**When umbral 0.0.11 is published:**

1. Bump every `umbral*` pin in `backend/Cargo.toml` to `0.0.11`.
2. Delete the `[patch.crates-io]` block at the bottom of `backend/Cargo.toml`.
3. `rm -rf backend/vendor/`.
4. `cargo test --workspace` in `backend/` — the media-access and scoped-REST
   suites prove the published crates carry the fixes.

Until then the vendor dir is load-bearing: removing it early reverts all
three bugs in any fresh build/deploy.
