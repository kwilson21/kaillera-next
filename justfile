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

# Start dev server (Redis + HTTPS via Let's Encrypt certs)
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

# Deploy: bump version (one chore commit summarising all unpushed feat/fix
# commits since origin/main), then push main with the new tag. Idempotent
# — running it twice in a row is a no-op the second time. Refuses to run
# on dirty trees or off main.
deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    scripts/bump-version.sh
    echo ""
    echo "Pushing main + tags to origin..."
    git push origin main --follow-tags

# Dry-run of deploy: shows what would be bumped + pushed without doing it.
deploy-dry:
    #!/usr/bin/env bash
    set -euo pipefail
    git fetch --quiet origin main
    range="origin/main..HEAD"
    count=$(git rev-list --count "$range")
    if [ "$count" -eq 0 ]; then
        echo "Nothing to deploy — HEAD is at origin/main."
        exit 0
    fi
    echo "Unpushed commits ($count):"
    git log --oneline "$range"
    echo ""
    # Mirror bump-version.sh: only count feat/fix commits since the most
    # recent unpushed chore(version) commit (if any).
    last_version=$(git log --format=%H --grep='^chore(version):' "$range" -1 || true)
    if [ -n "$last_version" ]; then
        scan_range="${last_version}..HEAD"
        echo "(skipping commits at or before $(git log -1 --format=%h "$last_version") — already version-bumped)"
    else
        scan_range="$range"
    fi
    echo "Would bump:"
    msgs=$(git log --format=%s "$scan_range")
    bump=""
    while IFS= read -r line; do
        case "$line" in
            feat:*|feat\(*) bump="minor"; break ;;
            fix:*|fix\(*)   bump="patch" ;;
        esac
    done <<< "$msgs"
    if [ -z "$bump" ]; then
        echo "  (no feat/fix commits — no version bump, plain push only)"
    else
        current=$(grep -o '"version": *"[^"]*"' web/static/version.json | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
        IFS='.' read -r major minor patch <<< "$current"
        if [ "$bump" = "minor" ]; then
            minor=$((minor + 1)); patch=0
        else
            patch=$((patch + 1))
        fi
        echo "  $current → $major.$minor.$patch ($bump)"
    fi
