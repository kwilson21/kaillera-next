# kaillera-next dev commands
# Usage: just <command>

set dotenv-load

# Format all code (Python + JS)
fmt:
    uvx ruff format server/src/ --config server/pyproject.toml
    uvx ruff check server/src/ --config server/pyproject.toml --fix
    npx prettier --write "web/static/*.js" "web/static/*.css" "web/*.html"

# Lint without fixing
lint:
    uvx ruff check server/src/ --config server/pyproject.toml
    npx prettier --check "web/static/*.js" "web/static/*.css" "web/*.html"

# Format Python only
fmt-py:
    uvx ruff format server/src/ --config server/pyproject.toml
    uvx ruff check server/src/ --config server/pyproject.toml --fix

# Format JS only
fmt-js:
    npx prettier --write "web/static/*.js" "web/static/*.css" "web/*.html"

# Lint Python only
lint-py:
    uvx ruff check server/src/ --config server/pyproject.toml

# Lint JS only
lint-js:
    npx prettier --check "web/static/*.js" "web/static/*.css" "web/*.html"

# Install dev dependencies
setup:
    uv pip install -e "server/[dev]"
    npm install --save-dev prettier
    uv tool install pre-commit
    pre-commit install

# Run pre-commit on all files
check:
    pre-commit run --all-files

# Start dev server (Redis + HTTPS via Tailscale certs)
dev:
    docker compose -f docker-compose.dev.yml up -d
    REDIS_URL=redis://:${REDIS_PASSWORD:-devpass}@localhost:6379/0 uv run kaillera-server

# Run the server without Redis
serve:
    uv run kaillera-server

# Start local Redis (stays running in background)
redis:
    docker compose -f docker-compose.dev.yml up -d

# Alias for dev
serve-redis: dev

# Stop local Redis
redis-stop:
    docker compose -f docker-compose.dev.yml down

# Generate Tailscale HTTPS certs (run once, renew every ~90 days)
certs:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "${TAILSCALE_HOSTNAME:-}" ]; then
        echo "Error: Set TAILSCALE_HOSTNAME in .env (e.g. your-machine.tail1234.ts.net)"
        echo "Find yours at: https://login.tailscale.com/admin/machines"
        exit 1
    fi
    mkdir -p certs
    if [[ "$(uname)" == "Darwin" ]]; then
        TAILSCALE_BIN="/Applications/Tailscale.localized/Tailscale.app/Contents/MacOS/Tailscale"
        SANDBOX_DIR="$HOME/Library/Containers/io.tailscale.ipn.macos/Data"
        "$TAILSCALE_BIN" cert "$TAILSCALE_HOSTNAME"
        cp "$SANDBOX_DIR/$TAILSCALE_HOSTNAME.crt" certs/cert.pem
        cp "$SANDBOX_DIR/$TAILSCALE_HOSTNAME.key" certs/key.pem
    else
        tailscale cert "$TAILSCALE_HOSTNAME"
        mv "$TAILSCALE_HOSTNAME.crt" certs/cert.pem
        mv "$TAILSCALE_HOSTNAME.key" certs/key.pem
    fi
    echo "Certs written to certs/cert.pem and certs/key.pem"
    echo "Server will auto-detect HTTPS on next start"
