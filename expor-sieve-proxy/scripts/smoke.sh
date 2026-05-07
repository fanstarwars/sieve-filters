#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Smoke-тест для админа после деплоя.
# Использование:  scripts/smoke.sh https://mail.example.com/sieve-proxy user@example.com password
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <base_url> <user> <password>" >&2
  exit 2
fi

BASE_URL="${1%/}"
USER="$2"
PASS="$3"

red() { printf "\e[31m%s\e[0m\n" "$1"; }
green() { printf "\e[32m%s\e[0m\n" "$1"; }

# 1. health (без auth)
echo "→ GET $BASE_URL/health"
status=$(curl -sS -o /tmp/smoke.body -w "%{http_code}" "$BASE_URL/health" || echo "000")
if [[ "$status" != "200" ]]; then
  red "FAIL: /health вернул $status (ожидали 200)"
  cat /tmp/smoke.body; echo
  exit 1
fi
green "OK: /health = 200"

# 2. /v1/auth/check (Basic)
echo "→ GET $BASE_URL/v1/auth/check"
status=$(curl -sS -o /tmp/smoke.body -w "%{http_code}" -u "$USER:$PASS" "$BASE_URL/v1/auth/check" || echo "000")
if [[ "$status" != "200" ]]; then
  red "FAIL: /v1/auth/check вернул $status"
  cat /tmp/smoke.body; echo
  exit 1
fi
green "OK: /v1/auth/check = 200"

# 3. /v1/mailbox/<user>
echo "→ GET $BASE_URL/v1/mailbox/$USER"
status=$(curl -sS -o /tmp/smoke.body -w "%{http_code}" -u "$USER:$PASS" "$BASE_URL/v1/mailbox/$USER" || echo "000")
if [[ "$status" != "200" ]]; then
  red "FAIL: /v1/mailbox/$USER вернул $status"
  cat /tmp/smoke.body; echo
  exit 1
fi
green "OK: /v1/mailbox/$USER = 200"

# 4. /v1/filters/<user>
echo "→ GET $BASE_URL/v1/filters/$USER"
status=$(curl -sS -o /tmp/smoke.body -w "%{http_code}" -u "$USER:$PASS" "$BASE_URL/v1/filters/$USER" || echo "000")
if [[ "$status" != "200" ]]; then
  red "FAIL: /v1/filters/$USER вернул $status"
  cat /tmp/smoke.body; echo
  exit 1
fi
green "OK: /v1/filters/$USER = 200"

# 5. add minimal filter
SCRIPT='# expor-sieve v1 managed
require ["fileinto"];
# smoke-test created by scripts/smoke.sh — safe to delete
'
ADD_BODY=$(cat <<EOF
{"active":1,"username":"$USER","script_desc":"smoke-test","script_data":$(printf '%s' "$SCRIPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),"filter_type":"prefilter"}
EOF
)
echo "→ POST $BASE_URL/v1/filters"
status=$(curl -sS -o /tmp/smoke.body -w "%{http_code}" -u "$USER:$PASS" \
  -H 'Content-Type: application/json' \
  -d "$ADD_BODY" \
  "$BASE_URL/v1/filters" || echo "000")
if [[ "$status" != "200" ]]; then
  red "FAIL: POST /v1/filters вернул $status"
  cat /tmp/smoke.body; echo
  exit 1
fi
green "OK: POST /v1/filters = 200"

# (опционально) удалить созданный фильтр — нужно сначала вытащить id
NEW_ID=$(curl -sS -u "$USER:$PASS" "$BASE_URL/v1/filters/$USER" \
  | python3 -c 'import json,sys
data=json.load(sys.stdin)
ids=[x["id"] for x in data if isinstance(x,dict) and x.get("script_desc")=="smoke-test"]
print(ids[-1] if ids else "")' || true)
if [[ -n "$NEW_ID" ]]; then
  echo "→ POST $BASE_URL/v1/filters/delete (id=$NEW_ID)"
  status=$(curl -sS -o /tmp/smoke.body -w "%{http_code}" -u "$USER:$PASS" \
    -H 'Content-Type: application/json' \
    -d "[$NEW_ID]" \
    "$BASE_URL/v1/filters/delete" || echo "000")
  if [[ "$status" != "200" ]]; then
    red "WARN: cleanup delete вернул $status (фильтр id=$NEW_ID остался)"
  else
    green "OK: cleanup delete (id=$NEW_ID) = 200"
  fi
fi

green "ALL OK"
