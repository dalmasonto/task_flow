#!/usr/bin/bash

# Encrypt the production env files with sops + age.
#
#   bash scripts/encrypt_envs.sh <age-public-key>
#   bash scripts/encrypt_envs.sh age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
#
# Generate a key pair with: age-keygen -o keys.txt
#
# Two env files, one per deployable surface:
#
#   backend/.prod.env (plaintext, gitignored)  ->  backend/secret.env (encrypted, COMMITTED)
#   v2_fe/.prod.env   (plaintext, gitignored)  ->  v2_fe/secret.env   (encrypted, COMMITTED)
#
# The backend env travels to the server and is baked into the image there.
# The frontend env never leaves CI: Vite reads VITE_* vars at BUILD time and
# bakes them into the JS bundle, so the deploy workflow decrypts it only to
# source it around `npm run build`.
#
# The deploy workflow decrypts secret.env back to .prod.env using the
# AGE_PRIVATE_KEY repo secret. Put the private key from keys.txt there.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."

PUBLIC_KEY="$1"

if [ -z "$PUBLIC_KEY" ]; then
    echo "Usage: bash scripts/encrypt_envs.sh <age-public-key>"
    echo ""
    echo "Example:"
    echo "  bash scripts/encrypt_envs.sh age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
    echo ""
    echo "Generate a key pair with: age-keygen -o keys.txt"
    exit 1
fi

if ! command -v sops &> /dev/null; then
    echo "ERROR: sops is not installed."
    echo "Install it: https://github.com/getsops/sops/releases"
    exit 1
fi

# dir : plaintext -> encrypted, encrypted next to its plaintext so each
# surface stays self-contained.
ENV_DIRS=(
    "backend"
    "v2_fe"
)

for dir in "${ENV_DIRS[@]}"; do
    PLAINTEXT="$PROJECT_ROOT/$dir/.prod.env"
    ENCRYPTED="$PROJECT_ROOT/$dir/secret.env"

    if [ ! -f "$PLAINTEXT" ]; then
        echo "ERROR: $dir/.prod.env not found at $PLAINTEXT"
        echo "Create it first (see README -> Secrets)."
        exit 1
    fi

    # sops's dotenv parser dies on blank lines. Comments are fine, so .prod.env
    # uses `#` separators — this guard only fires if a blank line reappears.
    if grep -qP '^\s*$' "$PLAINTEXT"; then
        echo "WARN  $dir/.prod.env has blank lines - removing them before encryption"
        sed -i '/^\s*$/d' "$PLAINTEXT"
    fi

    echo "ENCRYPT  $dir/.prod.env -> $dir/secret.env"
    sops --encrypt --age "$PUBLIC_KEY" "$PLAINTEXT" > "$ENCRYPTED"
done

echo ""
echo "Done. Commit backend/secret.env and v2_fe/secret.env; never commit a .prod.env."
echo "Decrypt locally with: sops --decrypt <dir>/secret.env > <dir>/.prod.env"
