#!/usr/bin/bash

# Build backend/dist/backend the same way CI does, so `docker compose build`
# works locally and produces a byte-for-byte-equivalent runtime image.
#
#   bash scripts/build_binary.sh
#
# Why this exists instead of a plain `cargo build --release`:
#
#   The binary must be compiled in rust:1-bookworm. The runtime image is
#   debian:bookworm-slim; both are Debian 12 (glibc 2.36, OpenSSL 3). A binary
#   built against another distro's glibc may load there by accident, or not.
#
# (No "compile at /app" rule here: unlike the umbral website, no taskflow
# plugin bakes env!("CARGO_MANIFEST_DIR") template paths into the binary.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
BACKEND_DIR="$PROJECT_ROOT/backend"

cd "$BACKEND_DIR"
mkdir -p dist

echo "Building backend in rust:1-bookworm ..."

# The source is copied to /build inside the container rather than bind-mounted,
# because cargo would otherwise write target/ straight into your checkout and
# the host/container UIDs differ. The cargo caches ARE mounted (named volumes)
# so repeat builds are incremental.
docker run --rm \
  -v "$BACKEND_DIR":/src:ro \
  -v taskflow_backend_cargo_registry:/usr/local/cargo/registry \
  -v taskflow_backend_build_target:/build/target \
  -v "$BACKEND_DIR/dist":/out \
  rust:1-bookworm \
  bash -euo pipefail -c '
    apt-get update -qq && apt-get install -y -qq --no-install-recommends pkg-config libssl-dev >/dev/null
    mkdir -p /build
    # -a preserves times so cargo fingerprints stay valid across runs.
    # target/ is a mount; dist/, dev DBs and env files are dead weight.
    cp -a /src/. /build/ 2>/dev/null || true
    rm -rf /build/dist /build/styles/node_modules
    rm -f /build/backend.db* /build/.env
    cd /build
    cargo build --release --locked
    strip target/release/backend
    cp target/release/backend /out/backend
  '

echo
ls -lh dist/backend
echo
echo "Now: cd backend && docker compose build && docker compose up -d"
