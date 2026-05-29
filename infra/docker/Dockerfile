# syntax=docker/dockerfile:1.7
# CPU multi-stage image for CodeClone serve + CLI.
# Default backend: peft (transformers); MLX is Apple Silicon native and not in
# this image. For CUDA, see Dockerfile.cuda.

ARG PY_VERSION=3.11

# ---------- builder ----------
FROM python:${PY_VERSION}-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_SYSTEM_PYTHON=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends git build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip uv

WORKDIR /app
COPY pyproject.toml /app/pyproject.toml
COPY README.md /app/README.md
COPY src /app/src
COPY packages /app/packages
COPY services /app/services
COPY recipes /app/recipes

RUN uv pip install --system --no-cache .

# ---------- runtime ----------
FROM python:${PY_VERSION}-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CODECLONE_SERVE_HOST=0.0.0.0 \
    CODECLONE_SERVE_PORT=7461

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /usr/sbin/nologin app

COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /app /app

WORKDIR /app
USER app

EXPOSE 7461

HEALTHCHECK --interval=20s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:7461/healthz', timeout=2)" \
      || exit 1

ENTRYPOINT ["tini", "--", "codeclone"]
CMD ["serve", "--host", "0.0.0.0", "--port", "7461"]
