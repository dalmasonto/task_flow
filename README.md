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
