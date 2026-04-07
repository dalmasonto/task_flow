## Environment Encryption (sops + age)

Used for encrypting `.env` files before committing or deploying.

### Setup

```bash
# Generate age key pair (one-time)
age-keygen -o keys.txt

# Store private key where sops expects it
mkdir -p ~/.config/sops/age
cp keys.txt ~/.config/sops/age/keys.txt
```

### Encrypt all .envs

```bash
bash scripts/encrypt_envs.sh <your-age-public-key>
```

Encrypts `backend/.env`, `frontend/.env`, and `.env` into `secret.env` files safe to commit.

### Decrypt

```bash
sops --decrypt secret.env > .env
sops --decrypt backend/secret.env > backend/.env
sops --decrypt frontend/secret.env > frontend/.env
```