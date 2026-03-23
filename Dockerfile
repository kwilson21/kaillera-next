FROM python:3.13-slim

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

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -s /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app
USER appuser

# Default env — override ALLOWED_ORIGIN in production (e.g. "https://yourdomain.com")
ENV ALLOWED_ORIGIN=""

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

WORKDIR /app/server
CMD ["python", "-c", "from src.main import run; run()"]
