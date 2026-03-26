# kaillera-next dev commands
# Usage: just <command>

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

# Run the server
serve:
    cd server && python -c "from src.main import run; run()"

# Start local Redis for dev (run once, stays running in background)
redis:
    docker compose -f docker-compose.dev.yml up -d

# Stop local Redis
redis-stop:
    docker compose -f docker-compose.dev.yml down

# Run the server with Redis (for testing deploy resilience)
serve-redis:
    docker compose -f docker-compose.dev.yml up -d
    cd server && REDIS_URL=redis://localhost:6379/0 python -c "from src.main import run; run()"
