# kaillera-next dev commands
# Usage: just <command>

set dotenv-load

# Format all code (Python + JS)
fmt:
    uvx ruff format server/src/ --config server/pyproject.toml
    uvx ruff check server/src/ --config server/pyproject.toml --fix
    npm run --silent fmt

# Lint without fixing
lint:
    uvx ruff check server/src/ --config server/pyproject.toml
    npm run --silent fmt:check
    npm run --silent lint

# Format Python only
fmt-py:
    uvx ruff format server/src/ --config server/pyproject.toml
    uvx ruff check server/src/ --config server/pyproject.toml --fix

# Format JS only
fmt-js:
    npm run --silent fmt

# Lint Python only
lint-py:
    uvx ruff check server/src/ --config server/pyproject.toml

# Lint JS only
lint-js:
    npm run --silent fmt:check
    npm run --silent lint

# Install dev dependencies
setup:
    uv sync --directory server --frozen --extra dev
    npm ci
    npm run --silent build

# Install Git hooks for contributors who use pre-commit.
hooks:
    uvx pre-commit install

# Type-check, test and bundle the TypeScript core (web/src -> web/static/dist)
build:
    npm run --silent typecheck
    npm run --silent test:ts
    npm run --silent build

# Flag placeholder, deferral and hedging comments (cargo install antislop --version 0.3.0 --locked)
slop:
    antislop --disable stub --no-filename-check .

# Model-check the Quint specs in specs/
spec:
    npm run --silent spec

# Run pre-commit on all files
check:
    uvx pre-commit run --all-files

# Start dev server (Redis + HTTPS via Let's Encrypt certs)
dev:
    docker compose -f docker-compose.dev.yml up -d
    REDIS_URL=redis://:${REDIS_PASSWORD:-devpass}@localhost:6379/0 uv run --directory server --frozen kaillera-server

# Run the server without Redis
serve:
    uv run --directory server --frozen kaillera-server

# Start local Redis (stays running in background)
redis:
    docker compose -f docker-compose.dev.yml up -d

# Alias for dev
serve-redis: dev

# Stop local Redis
redis-stop:
    docker compose -f docker-compose.dev.yml down

# Issue / renew Let's Encrypt HTTPS certs via lego (Cloudflare DNS-01)
# Requires LEGO_EMAIL, LEGO_DOMAIN, CLOUDFLARE_DNS_API_TOKEN in server/.env
# Idempotent: issues if missing, renews if within 30 days of expiry, no-op otherwise.
certs:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v lego >/dev/null 2>&1; then
        echo "Error: lego not found. Install with: brew install lego"
        exit 1
    fi
    # Load server/.env
    set -a
    # shellcheck disable=SC1091
    source server/.env
    set +a
    : "${LEGO_EMAIL:?LEGO_EMAIL must be set in server/.env}"
    : "${LEGO_DOMAIN:?LEGO_DOMAIN must be set in server/.env}"
    : "${CLOUDFLARE_DNS_API_TOKEN:?CLOUDFLARE_DNS_API_TOKEN must be set in server/.env}"
    mkdir -p certs/lego
    LEGO_PATH="$(pwd)/certs/lego"
    CRT="$LEGO_PATH/certificates/$LEGO_DOMAIN.crt"
    KEY="$LEGO_PATH/certificates/$LEGO_DOMAIN.key"
    if [ -f "$CRT" ] && [ -f "$KEY" ]; then
        echo "Renewing cert for $LEGO_DOMAIN (no-op if >30 days remain)..."
        lego --email "$LEGO_EMAIL" --dns cloudflare --domains "$LEGO_DOMAIN" \
             --path "$LEGO_PATH" --accept-tos renew --days 30
    else
        echo "Issuing new cert for $LEGO_DOMAIN..."
        lego --email "$LEGO_EMAIL" --dns cloudflare --domains "$LEGO_DOMAIN" \
             --path "$LEGO_PATH" --accept-tos run
    fi
    cp "$CRT" certs/cert.pem
    cp "$KEY" certs/key.pem
    echo "Certs written to certs/cert.pem and certs/key.pem"
    echo "Server will auto-detect HTTPS on next start"
    echo "Access at: https://$LEGO_DOMAIN:27888/"

# Open VGP design mode (multi-device visual layout editor)
design:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -L static ] || ln -sf web/static static
    echo "Serving on http://localhost:18888/tests/design-mode.html"
    echo "Press Ctrl+C to stop"
    open "http://localhost:18888/tests/design-mode.html"
    python3 -m http.server 18888 --bind 127.0.0.1

# Release the current verified main tip with a file of player-facing notes.
[positional-arguments]
deploy commit notes:
    #!/usr/bin/env bash
    set -euo pipefail
    gh workflow run version-bump.yml --ref main -f "commit=$1" -F "player_notes=@$2"

# Queue player-facing notes for the weekly release of this exact main commit.
[positional-arguments]
queue-release commit notes:
    #!/usr/bin/env bash
    set -euo pipefail
    git fetch --quiet origin main
    if [[ "$(git rev-parse origin/main)" != "$1" ]]; then
      echo "Use the full SHA of the current main commit." >&2
      exit 1
    fi
    batch=$(jq -ne --arg commit "$1" --rawfile player_notes "$2" \
      'select($player_notes | test("[^[:space:]]")) | {commit: $commit, player_notes: $player_notes}')
    printf '%s\n' "$batch" | gh variable set SCHEDULED_RELEASE

# Preview the commits in the next main release.
deploy-dry:
    #!/usr/bin/env bash
    set -euo pipefail
    git fetch --quiet origin main
    last_version=$(git log --first-parent --format=%H --grep='^chore(version):' -1 origin/main)
    if [ -z "$last_version" ]; then
      echo "Could not find the previous version commit." >&2
      exit 1
    fi
    echo "Main commit: $(git rev-parse origin/main)"
    git log --first-parent --oneline "$last_version..origin/main"

# Two-player rollback match in two local browsers against a running server
# (`just serve`). Needs the SSB64 US ROM; see tests/rb-two-player.mjs.
two-player-test rom latency="50" seconds="60":
    KN_ROM="{{rom}}" LAT={{latency}} BATTLE_SECONDS={{seconds}} node tests/rb-two-player.mjs
