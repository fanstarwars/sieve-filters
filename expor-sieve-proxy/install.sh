#!/usr/bin/env bash
# install.sh — one-shot installer for expor-sieve-proxy on a mailcow-dockerized host.
#
# Usage (from cloned source):
#     sudo MAILCOW_API_KEY="<key>" ./install.sh
#
# Usage (curl-pipe; once the repo is published):
#     curl -fsSL https://raw.githubusercontent.com/fanstarwars/expor-sieve-proxy/main/install.sh \
#       | sudo MAILCOW_API_KEY="<key>" bash
#
# Env vars:
#     MAILCOW_API_KEY    REQUIRED. RW API key created in mailcow UI (see README).
#                        If unset and a TTY is attached, prompted interactively.
#     MAILCOW_DIR        Path to mailcow-dockerized clone. Default: /docker/mailcow-dockerized.
#     MAILCOW_NETWORK    Docker subnet of mailcow-network. Default: 172.22.1.0/24.
#                        This subnet is whitelisted in F2B (otherwise mailcow's netfilter
#                        bans our middleware container for outgoing IMAP-bind to dovecot).
#     NONINTERACTIVE     Set to 1 to fail fast instead of prompting. Default: 0.
#     REPO_URL           Git URL used when running curl-pipe (no Dockerfile next to script).
#     REPO_REF           Git ref to check out for curl-pipe install. Default: main.
#     IMAGE_NAME         Docker image name. Default: expor-sieve-proxy.
#     SKIP_PUBLIC_SMOKE  Set to 1 to skip the curl https://<host>/sieve-proxy/health step.
#
# Idempotent: re-running rebuilds the image, re-applies the override block via markers,
# refreshes nginx-snippet/env-file, and restarts only our service. Existing override
# content is preserved (markers fence our block).

set -euo pipefail

# ---- Configuration --------------------------------------------------------

REPO_URL="${REPO_URL:-https://github.com/fanstarwars/sieve-filters.git}"
REPO_REF="${REPO_REF:-main}"
# Middleware живёт в subdir монорепо sieve-filters/expor-sieve-proxy/.
# Если репо изменится — поправь REPO_SUBDIR; для standalone-репо ставь "".
REPO_SUBDIR="${REPO_SUBDIR:-expor-sieve-proxy}"
IMAGE_NAME="${IMAGE_NAME:-expor-sieve-proxy}"
MAILCOW_DIR="${MAILCOW_DIR:-/docker/mailcow-dockerized}"
MAILCOW_NETWORK="${MAILCOW_NETWORK:-172.22.1.0/24}"
NONINTERACTIVE="${NONINTERACTIVE:-0}"
SKIP_PUBLIC_SMOKE="${SKIP_PUBLIC_SMOKE:-0}"

MARK_BEGIN="# >>> EXPOR-SIEVE-PROXY (managed by install.sh) >>>"
MARK_END="# <<< EXPOR-SIEVE-PROXY <<<"

# ---- Logging --------------------------------------------------------------

log()  { printf '[install] %s\n' "$*" >&2; }
step() { printf '[install] step: %s\n' "$*" >&2; }
fail() { printf '[install][FAIL] %s\n' "$*" >&2; exit 1; }

# ---- Self-elevate to root -------------------------------------------------

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    log "Re-executing under sudo..."
    # Forward env vars sudo wipes by default.
    exec sudo -E \
      MAILCOW_API_KEY="${MAILCOW_API_KEY:-}" \
      MAILCOW_DIR="$MAILCOW_DIR" \
      MAILCOW_NETWORK="$MAILCOW_NETWORK" \
      NONINTERACTIVE="$NONINTERACTIVE" \
      REPO_URL="$REPO_URL" \
      REPO_REF="$REPO_REF" \
      IMAGE_NAME="$IMAGE_NAME" \
      SKIP_PUBLIC_SMOKE="$SKIP_PUBLIC_SMOKE" \
      bash "$0" "$@"
  else
    fail "must run as root (no sudo found)"
  fi
fi

# ---- Pre-flight checks ----------------------------------------------------

step "pre-flight checks"
command -v docker >/dev/null 2>&1 || fail "docker not found in PATH"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 not available"
[[ -d "$MAILCOW_DIR" ]] || fail "mailcow not found at $MAILCOW_DIR (set MAILCOW_DIR=...)"
[[ -f "$MAILCOW_DIR/docker-compose.yml" ]] || fail "no docker-compose.yml in $MAILCOW_DIR"
[[ -f "$MAILCOW_DIR/mailcow.conf" ]] || fail "no mailcow.conf in $MAILCOW_DIR"

OVERRIDE="${MAILCOW_DIR}/docker-compose.override.yml"
ENV_FILE="${MAILCOW_DIR}/.expor-sieve-proxy.env"
NGINX_SITE_DST="${MAILCOW_DIR}/data/conf/nginx/site.sieve-proxy.custom"

# ---- Resolve API key ------------------------------------------------------

step "resolve API key"
if [[ -z "${MAILCOW_API_KEY:-}" ]]; then
  if [[ "$NONINTERACTIVE" == "1" ]]; then
    fail "MAILCOW_API_KEY is not set and NONINTERACTIVE=1"
  fi
  if [[ ! -t 0 ]]; then
    fail "MAILCOW_API_KEY is not set and stdin is not a TTY (cannot prompt). Set the env var explicitly."
  fi
  printf '[install] Enter mailcow RW API key (input hidden): ' >&2
  read -rs MAILCOW_API_KEY
  printf '\n' >&2
fi
[[ -n "${MAILCOW_API_KEY:-}" ]] || fail "API key is empty"
[[ ${#MAILCOW_API_KEY} -ge 20 ]] || fail "API key looks too short (${#MAILCOW_API_KEY} chars)"

# ---- Resolve source directory --------------------------------------------

step "resolve source"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
SOURCE_DIR=""
SOURCE_IS_TEMP=0

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/Dockerfile" && -d "$SCRIPT_DIR/src" ]]; then
  SOURCE_DIR="$SCRIPT_DIR"
  log "using local source: $SOURCE_DIR"
else
  command -v git >/dev/null 2>&1 || fail "git is required for curl-pipe install (or run from a clone)"
  CLONE_DIR="/tmp/esp-build"
  SOURCE_IS_TEMP=1
  if [[ -d "$CLONE_DIR/.git" ]]; then
    log "refreshing existing clone at $CLONE_DIR"
    git -C "$CLONE_DIR" fetch --depth=1 origin "$REPO_REF" >/dev/null
    git -C "$CLONE_DIR" checkout -q "$REPO_REF"
    git -C "$CLONE_DIR" reset --hard "origin/$REPO_REF" >/dev/null
  else
    rm -rf "$CLONE_DIR"
    log "cloning $REPO_URL ($REPO_REF) → $CLONE_DIR"
    git clone --depth=1 --branch "$REPO_REF" "$REPO_URL" "$CLONE_DIR" >/dev/null \
      || fail "git clone failed (set REPO_URL/REPO_REF or run from a checkout)"
  fi
  # Если monorepo — берём подкаталог как build-context.
  SOURCE_DIR="$CLONE_DIR${REPO_SUBDIR:+/$REPO_SUBDIR}"
  [[ -f "$SOURCE_DIR/Dockerfile" ]] || fail "Dockerfile missing in $SOURCE_DIR (REPO_SUBDIR=$REPO_SUBDIR)"
fi

# ---- Resolve version ------------------------------------------------------

VERSION="$(grep -E '^version' "$SOURCE_DIR/pyproject.toml" 2>/dev/null \
  | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)"
[[ -n "$VERSION" ]] || VERSION="latest"
log "image: ${IMAGE_NAME}:latest (also tagged :${VERSION})"

# ---- Build image ----------------------------------------------------------

step "build docker image"
docker build \
  -t "${IMAGE_NAME}:latest" \
  -t "${IMAGE_NAME}:${VERSION}" \
  "$SOURCE_DIR"

# ---- Sanity-check API key from inside docker network ---------------------

step "verify API key via docker network"
NGINX_CONTAINER="$(docker ps --filter 'name=nginx-mailcow' --format '{{.Names}}' | head -1)"
[[ -n "$NGINX_CONTAINER" ]] || fail "nginx-mailcow container is not running"
PROBE="$(docker exec "$NGINX_CONTAINER" \
  wget -q -O- --header="X-API-Key: $MAILCOW_API_KEY" \
  http://nginx/api/v1/get/status/version 2>&1)" \
  || fail "API probe request failed: $PROBE"
echo "$PROBE" | grep -q '"version"' \
  || fail "API key rejected by mailcow. Response: $PROBE
Hint: ensure the key is RW and IP-allowlists $MAILCOW_NETWORK (or 'Skip IP check')."
log "API key OK ($PROBE)"

# ---- Backup override.yml -------------------------------------------------

step "backup docker-compose.override.yml"
TS="$(date -u +%Y%m%d-%H%M%S)"
if [[ -f "$OVERRIDE" ]]; then
  cp -a "$OVERRIDE" "${OVERRIDE}.bak-${TS}"
  log "backup → ${OVERRIDE}.bak-${TS}"
else
  printf 'services: {}\n' > "$OVERRIDE"
  log "created empty override (no prior file)"
fi

# ---- Patch override (idempotent via markers) -----------------------------

step "patch override.yml"
TMP="$(mktemp)"
awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
  $0 == b { skip=1; next }
  $0 == e { skip=0; next }
  !skip   { print }
' "$OVERRIDE" > "$TMP"

# Strip trailing blank lines.
sed -i -E ':a; /^[[:space:]]*$/ { $d; N; ba; }' "$TMP" || true

# Ensure file has a top-level `services:` key.
if ! grep -qE '^services:' "$TMP"; then
  printf 'services:\n' >> "$TMP"
fi

cat >> "$TMP" <<EOF
$MARK_BEGIN
  expor-sieve-proxy:
    image: ${IMAGE_NAME}:latest
    restart: always
    networks:
      mailcow-network:
        aliases:
          - sieve-proxy
    env_file:
      - ./.expor-sieve-proxy.env
    environment:
      MAILCOW_API_URL: "http://nginx"
      DOVECOT_HOST: "dovecot"
      DOVECOT_PORT: "993"
      DOVECOT_USE_SSL: "true"
      LOG_LEVEL: "INFO"
      ALLOWED_ORIGINS: "moz-extension://*"
      F2B_ENABLED: "true"
      # MAILCOW_API_KEY and REDIS_URL come from env_file (root:600).
    depends_on:
      - dovecot-mailcow
      - nginx-mailcow
      - redis-mailcow
$MARK_END
EOF

mv "$TMP" "$OVERRIDE"
chown root:root "$OVERRIDE"
chmod 644 "$OVERRIDE"
log "patched $OVERRIDE"

# ---- Write env file (root:600) -------------------------------------------

step "write env file"
REDISPASS="$(grep -E '^REDISPASS=' "${MAILCOW_DIR}/mailcow.conf" | head -1 | cut -d= -f2- || true)"
if [[ -z "$REDISPASS" ]]; then
  log "WARN: REDISPASS not found in mailcow.conf — F2B publish will be a no-op"
  REDIS_URL="redis://redis:6379/0"
else
  REDIS_URL="redis://:${REDISPASS}@redis:6379/0"
fi

umask 077
{
  printf 'MAILCOW_API_KEY=%s\n' "$MAILCOW_API_KEY"
  printf 'REDIS_URL=%s\n' "$REDIS_URL"
} > "$ENV_FILE"
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
log "wrote $ENV_FILE (mode 600)"

# ---- Install nginx site snippet ------------------------------------------

step "install nginx snippet"
[[ -f "$SOURCE_DIR/conf/nginx-site.sieve-proxy.custom" ]] \
  || fail "nginx snippet missing at $SOURCE_DIR/conf/nginx-site.sieve-proxy.custom"
mkdir -p "$(dirname "$NGINX_SITE_DST")"
cp "$SOURCE_DIR/conf/nginx-site.sieve-proxy.custom" "$NGINX_SITE_DST"
chown root:root "$NGINX_SITE_DST"
chmod 644 "$NGINX_SITE_DST"
log "installed $NGINX_SITE_DST"

# ---- F2B whitelist (idempotent) ------------------------------------------

step "whitelist $MAILCOW_NETWORK in F2B"
REDIS_CONTAINER="$(docker ps --filter 'name=redis-mailcow' --format '{{.Names}}' | head -1)"
NETFILTER_CONTAINER="$(docker ps --filter 'name=netfilter-mailcow' --format '{{.Names}}' | head -1)"
if [[ -n "$REDIS_CONTAINER" ]]; then
  docker exec "$REDIS_CONTAINER" redis-cli HSET F2B_WHITELIST "$MAILCOW_NETWORK" "1" >/dev/null \
    || log "WARN: failed to set F2B_WHITELIST (continuing)"
  if [[ -n "$NETFILTER_CONTAINER" ]]; then
    docker exec "$NETFILTER_CONTAINER" pkill -HUP -f main.py 2>/dev/null || true
  fi
  log "F2B_WHITELIST updated"
else
  log "WARN: redis-mailcow not running — skipped F2B whitelist"
fi

# ---- Bring up service ----------------------------------------------------

step "start expor-sieve-proxy"
( cd "$MAILCOW_DIR" && docker compose up -d expor-sieve-proxy ) 2>&1 | tail -10

# ---- Wait for healthy ----------------------------------------------------

step "wait for /health"
HEALTHY=0
for i in $(seq 1 15); do
  if docker exec "$NGINX_CONTAINER" \
       wget -q -O- http://sieve-proxy:8000/health 2>/dev/null | grep -q '"status":"ok"'; then
    HEALTHY=1
    log "container healthy"
    break
  fi
  sleep 2
done
if [[ "$HEALTHY" != "1" ]]; then
  ESP_CONTAINER="$(docker ps -a --filter 'name=expor-sieve-proxy' --format '{{.Names}}' | head -1)"
  fail "container did not become healthy in 30s. Logs: docker logs ${ESP_CONTAINER:-expor-sieve-proxy}"
fi

# ---- nginx -t && reload --------------------------------------------------

step "validate & reload nginx"
docker exec "$NGINX_CONTAINER" nginx -t 2>&1 | tail -5
docker exec "$NGINX_CONTAINER" nginx -s reload
sleep 1

# ---- Public smoke --------------------------------------------------------

MAILCOW_HOSTNAME="$(grep -E '^MAILCOW_HOSTNAME=' "${MAILCOW_DIR}/mailcow.conf" | head -1 | cut -d= -f2- || true)"
if [[ "$SKIP_PUBLIC_SMOKE" == "1" || -z "$MAILCOW_HOSTNAME" ]]; then
  log "skipping public smoke (SKIP_PUBLIC_SMOKE=$SKIP_PUBLIC_SMOKE, hostname='$MAILCOW_HOSTNAME')"
else
  step "public smoke https://${MAILCOW_HOSTNAME}/sieve-proxy/health"
  SMOKE_BODY="$(mktemp)"
  SMOKE_CODE="$(curl -sk -o "$SMOKE_BODY" -w '%{http_code}' \
    "https://${MAILCOW_HOSTNAME}/sieve-proxy/health" || echo "000")"
  if [[ "$SMOKE_CODE" != "200" ]]; then
    log "WARN: public smoke returned HTTP $SMOKE_CODE"
    log "Body: $(cat "$SMOKE_BODY" 2>/dev/null || echo '(empty)')"
    log "This may be normal if your mailcow hostname is not yet reachable from this host."
  else
    log "public smoke OK ($(cat "$SMOKE_BODY"))"
  fi
  rm -f "$SMOKE_BODY"
fi

# ---- Summary -------------------------------------------------------------

cat <<EOF

================================================================
[install] Install OK.

  Image:           ${IMAGE_NAME}:latest (also :${VERSION})
  Mailcow dir:     ${MAILCOW_DIR}
  Override block:  ${OVERRIDE} (between EXPOR-SIEVE-PROXY markers)
  Env file:        ${ENV_FILE} (root:600)
  Nginx snippet:   ${NGINX_SITE_DST}
  F2B whitelist:   ${MAILCOW_NETWORK}

  Health (internal):
    docker exec ${NGINX_CONTAINER} wget -q -O- http://sieve-proxy:8000/health
  Health (public):
    curl https://${MAILCOW_HOSTNAME:-<MAILCOW_HOSTNAME>}/sieve-proxy/health

  Logs:
    docker logs -f \$(docker ps --filter name=expor-sieve-proxy --format '{{.Names}}')

  Re-run installer to update:  sudo MAILCOW_API_KEY=... ./install.sh
  Roll back:                   sudo ./uninstall.sh
================================================================
EOF

# ---- Cleanup -------------------------------------------------------------

if [[ "$SOURCE_IS_TEMP" == "1" ]]; then
  log "leaving cloned source at $SOURCE_DIR (delete manually if not needed)"
fi
