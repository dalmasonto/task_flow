#!/usr/bin/bash

# Encrypt all .env files using sops + age
# Usage: bash scripts/encrypt_envs.sh <age-public-key>
# Example: bash scripts/encrypt_envs.sh age1abc123...

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."

PUBLIC_KEY="$1"

if [ -z "$PUBLIC_KEY" ]; then
    echo "Usage: bash scripts/encrypt_envs.sh <age-public-key>"
    echo ""
    echo "Example:"
    echo "  bash scripts/encrypt_envs.sh age1ql3z7hj5y54pw3hysww5ayyfg7zqgvdc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
    echo ""
    echo "Generate a key pair with: age-keygen -o keys.txt"
    exit 1
fi

# Check sops is installed
if ! command -v sops &> /dev/null; then
    echo "ERROR: sops is not installed."
    echo "Install it: https://github.com/mozilla/sops/releases"
    exit 1
fi

# .env files to encrypt (path relative to project root)
ENV_FILES=(
    "relay-server/.prod.env"
)

ENCRYPTED=0
SKIPPED=0

for ENV_REL in "${ENV_FILES[@]}"; do
    ENV_PATH="$PROJECT_ROOT/$ENV_REL"
    ENV_DIR="$(dirname "$ENV_PATH")"
    SECRET_PATH="$ENV_DIR/secret.env"

    if [ ! -f "$ENV_PATH" ]; then
        echo "SKIP  $ENV_REL (not found)"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Check for blank lines — sops chokes on them
    if grep -qP '^\s*$' "$ENV_PATH"; then
        echo "WARN  $ENV_REL has blank lines — removing them before encryption"
        sed -i '/^\s*$/d' "$ENV_PATH"
    fi

    echo "ENCRYPT  $ENV_REL -> $(dirname "$ENV_REL")/secret.env"
    sops --encrypt --age "$PUBLIC_KEY" "$ENV_PATH" > "$SECRET_PATH"
    ENCRYPTED=$((ENCRYPTED + 1))
done

echo ""
echo "Done! Encrypted $ENCRYPTED file(s), skipped $SKIPPED."
echo ""
echo "Encrypted files:"
for ENV_REL in "${ENV_FILES[@]}"; do
    ENV_DIR="$(dirname "$PROJECT_ROOT/$ENV_REL")"
    [ -f "$ENV_DIR/secret.env" ] && echo "  $ENV_DIR/secret.env"
done
echo ""
echo "These secret.env files are safe to commit. The .env files are not."
