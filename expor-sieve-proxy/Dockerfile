# expor-sieve-proxy — runtime image
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Системные зависимости — минимум (httpx + aioimaplib работают на чистом python)
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Сначала зависимости — для лучшего кэша слоёв
COPY pyproject.toml README.md ./
COPY src ./src

# Устанавливаем сам пакет с runtime-deps (без [dev]).
RUN pip install --no-cache-dir .

# Безопасность: не root.
RUN groupadd --system --gid 65532 app \
 && useradd --system --uid 65532 --gid app --no-create-home app

USER app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

CMD ["uvicorn", "expor_sieve_proxy.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
