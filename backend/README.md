# backend

Your umbral app.

It starts with one model (`Post`), an admin, a JSON API and an OpenAPI browser, so there
is something running from the first `cargo run`. All of it is ordinary code in this
repository — rename it, gut it, replace it.

## What's in the project

| File | What it shows |
|---|---|
| `src/main.rs` | App wiring: models, plugins, routes, auto-migrate |
| `Post` model | `ForeignKey<AuthUser>`, ORM QuerySet, `#[derive(Model)]` |
| `/` route | Template rendering with context |
| `/api/posts` | JSON endpoint via the ORM |
| `/dashboard` | `login_required_html("/login")` layer, `LoggedIn<AuthUser>` extractor, transaction |
| `RestPlugin` | JSON CRUD at `/api/post/` with query-string filtering (`?published=true`) |
| `AdminPlugin` | Auto CRUD UI at `/admin/` |
| `OpenApiPlugin` | Swagger UI at `/openapi/` |
| `SecurityPlugin` | CSRF middleware + hardening headers, with `/api` exempt for token clients |

## Running

```bash
# First run — a bare `cargo run` (no subcommand) auto-migrates the
# database and then starts the server. Passing an explicit subcommand
# (like `serve`) SKIPS the auto-migrate, so `serve` alone assumes the
# schema already exists.
cargo run

# Separate steps (production pattern) — migrate explicitly, then serve:
cargo run -- migrate
cargo run -- serve

# Create a superuser to log in to the admin:
cargo run -- createsuperuser

# Inspect the schema:
cargo run -- showmigrations
cargo run -- makemigrations
```

### Create a superuser in Docker (on the server)

The Dockerfile's `ENTRYPOINT` is the `backend` binary, so management commands
run as subcommands of the `web` service. SSH in and `cd` to the deploy directory
(where `docker-compose.yml` lives), then:

```bash
# Interactive — prompts for username, email, then password (no echo, twice):
docker compose run --rm web createsuperuser

# Non-interactive (CI / scripted) — password comes from the env var:
docker compose run --rm \
  -e UMBRAL_SUPERUSER_PASSWORD='your-strong-password' \
  web createsuperuser --username admin --email admin@example.com --noinput

# Reusing the already-running container instead of a throwaway one.
# NOTE: `exec` bypasses CMD but still runs under the ENTRYPOINT, so the
# `backend` before `createsuperuser` is REQUIRED here:
docker compose exec web backend createsuperuser
```

`docker compose run` keeps the `backend` entrypoint and appends the subcommand,
brings up the `postgres` dependency if it isn't running, and (with `--rm`) cleans
up afterward. It does not publish port 10002, so it won't collide with the live
`web`. The new account lands with `is_active = is_staff = is_superuser = true`.

## Styling

The pages use Tailwind, compiled to `static/css/app.css` and served by the
StoragePlugin at `/static`. That bundle ships **prebuilt**, so this project renders
correctly with no `npm install`.

You only need Node once you edit a template and reach for a utility class that is not
already in the bundle:

```bash
cd styles
npm install
npm run build      # or: npm run watch
```

The palette lives in `styles/input.css` as CSS variables (`--accent` is the violet).
Change them there and every page follows. There is deliberately no `cdn.tailwindcss.com`
script: it is versionless, it pulls a third party into every page load, and it is the
first thing a `default-src 'self'` Content-Security-Policy blocks.

## Where to go next

- Add a plugin: `umbral startapp posts`
- Your first app: https://dalmasonto.github.io/umbral/docs/v0.0.1/getting-started/your-first-app
- Models & the ORM: https://dalmasonto.github.io/umbral/docs/v0.0.1/orm/models
- Migrations: https://dalmasonto.github.io/umbral/docs/v0.0.1/migrations/managed-migrations
- Admin: https://dalmasonto.github.io/umbral/docs/v0.0.1/plugins/admin
- REST: https://dalmasonto.github.io/umbral/docs/v0.0.1/rest/index
- Login & signup pages: https://dalmasonto.github.io/umbral/docs/v0.0.1/auth/login-and-signup-pages
- The Plugin trait: https://dalmasonto.github.io/umbral/docs/v0.0.1/plugins/the-plugin-trait
