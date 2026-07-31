# Runtime image for the TaskFlow backend. It COMPILES NOTHING.
# (No `# syntax=` directive on purpose: it makes BuildKit fetch the dockerfile
# frontend from the registry on every build, so a DNS hiccup fails a build
# that is otherwise fully local. Nothing here needs BuildKit extensions.)
#
# CI builds the release binary (see .github/workflows/deploy-backend.yml) and
# ships it as `dist/backend`. The server then assembles this image in seconds
# -- a handful of COPY layers -- instead of compiling the full registry
# dependency tree on a VPS.
#
# The binary MUST be built inside `rust:1-bookworm`: this image is
# debian:bookworm-slim, and both are Debian 12 (glibc 2.36, OpenSSL 3).
# Building on a plain ubuntu-22.04 runner would link glibc 2.35 and merely
# *happen* to run here. That is luck, not a contract.
#
# (Unlike the umbral website this project copies its deploy setup from, no
# plugin here bakes `env!("CARGO_MANIFEST_DIR")` template paths into the
# binary -- the taskflow plugins are API-only -- so there is no "must compile
# at /app" rule and no grep assertion on the binary. Only the distro match
# above is load-bearing.)
#
# To build the binary locally with the same guarantees: bash scripts/build_binary.sh

FROM debian:bookworm-slim

# ca-certificates: outbound TLS (GitHub API for the github-linking plugin, OAuth).
# libssl3: the OpenSSL runtime the binary links against.
# curl: the compose healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libssl3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY dist/backend /usr/local/bin/backend
RUN chmod +x /usr/local/bin/backend

# Site-level templates, resolved RELATIVE to WORKDIR.
COPY templates ./templates

# `migrate` reads ./migrations/<plugin>/ relative to WORKDIR.
COPY migrations ./migrations

# Static assets (built css is committed; styles/ tailwind source is not shipped).
COPY static ./static

# User uploads (attachments, avatars). Created empty and mounted over by the
# `media` named volume, so uploads survive a rebuild.
RUN mkdir -p ./media

# umbral.toml is deliberately NOT shipped: it declares `environment = "Dev"`
# and a dev secret key, which would override a release binary's secure Prod
# default. In the image, /app/.env is the single source of truth.
#
# .prod.env never leaves the server -- CI builds only the binary, so
# production secrets are baked here, on the box.
ARG ENV_FILE=.prod.env
COPY ${ENV_FILE} ./.env

EXPOSE 10002
ENTRYPOINT ["backend"]
CMD ["serve"]
