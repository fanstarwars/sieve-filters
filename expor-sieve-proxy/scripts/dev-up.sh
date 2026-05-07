#!/usr/bin/env bash
# Локальный dev-режим: поднять mock-mailcow + middleware с подменой IMAP-bind.
#
# Юзер для bind: test@example.com / secret  (захардкожено в dev-stub).
# После запуска можно делать:
#   curl -u test@example.com:secret http://localhost:8000/v1/auth/check
#
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Установить пакет в venv (если ещё нет).
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  . .venv/bin/activate
  pip install -e ".[dev]" >/dev/null
else
  . .venv/bin/activate
fi

PIDS=()
cleanup() {
  echo "stopping ${#PIDS[@]} processes…"
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

# 2. Стартовать mock-mailcow на :9000.
echo "→ starting mock-mailcow on http://127.0.0.1:9000"
python3 -m tests.integration.mock_mailcow --host 127.0.0.1 --port 9000 &
PIDS+=($!)

# 3. Стартовать middleware с подменой IMAP-bind через monkeypatch-stub.
#    Используем PYTHONPATH-инжектор: грузим stub-модуль перед main.
export MAILCOW_API_URL="http://127.0.0.1:9000"
export MAILCOW_API_KEY="dev-rw-key"
export DOVECOT_HOST="dummy"
export DOVECOT_USE_SSL="false"
export LOG_LEVEL="DEBUG"
export ALLOWED_ORIGINS="*"

cat > /tmp/dev_imap_stub.py <<'PY'
"""Подменяет imap_bind так, чтобы успех давал только пара test@example.com/secret."""
import expor_sieve_proxy.auth as _a

_orig = _a.imap_bind
async def _stub(host, port, user, password, **kw):
    return user.lower() == "test@example.com" and password == "secret"
_a.imap_bind = _stub
PY

PYTHONSTARTUP="" python3 -c "
import importlib, runpy, sys
runpy.run_path('/tmp/dev_imap_stub.py', run_name='__main__')
import uvicorn
uvicorn.run('expor_sieve_proxy.main:app', host='0.0.0.0', port=8000, reload=False, log_level='info')
" &
PIDS+=($!)

echo
echo "READY."
echo "  mock-mailcow:  http://127.0.0.1:9000"
echo "  middleware:    http://127.0.0.1:8000"
echo "  test creds:    test@example.com / secret"
echo
echo "Try:  curl -u test@example.com:secret http://127.0.0.1:8000/v1/auth/check"
echo "Press Ctrl+C to stop."
wait
