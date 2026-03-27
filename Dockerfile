FROM python:3.13-slim-bookworm

# Prevent .pyc files and enable unbuffered output for logging
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first (layer caching)
COPY server/pyproject.toml server/
RUN pip install --no-cache-dir server/

# Copy application code
COPY server/ server/
COPY web/ web/

# Create non-root user and logs directory
RUN groupadd -r appuser && useradd -r -g appuser -s /usr/sbin/nologin appuser \
    && mkdir -p /app/server/logs/sync \
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
    LOG_RETENTION_DAYS=14 \
    REDIS_URL=""

EXPOSE 27888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen('http://localhost:'+os.environ.get('PORT','27888')+'/health')"

WORKDIR /app/server
CMD ["python", "-c", "from src.main import run; run()"]
