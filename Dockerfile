# The TypeScript bundles (web/static/dist), built from web/src at the versions
# in package-lock.json. Only production dependencies are installed: the three
# libraries the bundle contains and esbuild.
FROM node:24.22.3-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY tsconfig.json ./
COPY scripts/build-web.mjs scripts/build-web.mjs
COPY web/src web/src
RUN node scripts/build-web.mjs

FROM python:3.13.16-slim-bookworm

# Prevent .pyc files and enable unbuffered output for logging
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first (layer caching), at the exact versions in
# server/uv.lock: the versions the tests ran against (--locked fails the
# build if the lock is out of date with pyproject.toml). Resolving from
# pyproject.toml alone picked up whatever was newest on build day.
COPY server/pyproject.toml server/uv.lock server/
RUN pip install --no-cache-dir uv==0.13.1 \
    && uv export --quiet --project server --locked --no-dev --no-emit-project --no-hashes -o /tmp/requirements.txt \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && pip uninstall -y uv && rm /tmp/requirements.txt

# Copy application code
COPY server/ server/
COPY web/ web/
COPY --from=web /build/web/static/dist web/static/dist

# Create non-root user and logs directory
RUN groupadd -r appuser && useradd -r -g appuser -s /usr/sbin/nologin appuser \
    && mkdir -p /app/server/logs/sync /app/server/data \
    && chown -R appuser:appuser /app
USER appuser

# Default env — override in production
# ALLOWED_ORIGIN: empty defaults to "*" at runtime; set "REQUIRED" to force explicit config
# ADMIN_KEY: required — server refuses to start if unset (no open admin by default)
# Mount /app/server/logs as a volume to persist logs across restarts
ENV ALLOWED_ORIGIN="" \
    PORT=27888 \
    MAX_ROOMS=100 \
    MAX_SPECTATORS=20 \
    ADMIN_KEY="" \
    REDIS_URL=""

EXPOSE 27888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen('http://localhost:'+os.environ.get('PORT','27888')+'/health')"

WORKDIR /app/server
CMD ["python", "-c", "from src.main import run; run()"]
