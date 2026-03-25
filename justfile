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
