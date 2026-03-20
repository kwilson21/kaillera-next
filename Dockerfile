FROM python:3.13-slim

WORKDIR /app

# Install dependencies
COPY server/pyproject.toml server/
RUN pip install --no-cache-dir -e server/

# Copy application
COPY server/ server/
COPY web/ web/

# Default env
ENV ALLOWED_ORIGIN="*"

EXPOSE 8000

WORKDIR /app/server
CMD ["python", "-c", "from src.main import run; run()"]
