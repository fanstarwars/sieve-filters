#!/usr/bin/env bash
# uninstall.sh — remove expor-sieve-proxy from a mailcow-dockerized host.
#
# Usage:
#     sudo ./uninstall.sh
#
# Env vars:
#     MAILCOW_DIR        Default: /docker/mailcow-dockerized.
#     RESTORE_BACKUP     If "1" (default), restore most recent docker-compose.override.yml.bak-*
#                        instead of stripping our marker block in-place. Set to "0" to keep
#                        any other manual edits made since install.
#     REMOVE_IMAGE       If "1", run `docker rmi expor-sieve-proxy:latest` after stop. Default: 0.
#     IMAGE_NAME         Default: expor-sieve-proxy.
#     NONINTERACTIVE     Set to 1 to skip confirmation prompts.

set -euo pipefail

MAILCOW_DIR="${MAILCOW_DIR:-/docker/mailcow-dockerized}"
RESTORE_BACKUP="${RESTORE_BACKUP:-1}"
REMOVE_IMAGE="${REMOVE_IMAGE:-0}"
IMAGE_NAME="${IMAGE_NAME:-expor-sieve-proxy}"
NONINTERACTIVE="${NONINTERACTIVE:-0}"

MARK_BEGIN="# >>> EXPOR-SIEVE-PROXY (managed by install.sh) >>>"
MARK_END="# <<< EXPOR-SIEVE-PROXY <<<"
# Older installs used a slightly different marker — strip both.
LEGACY_MARK_BEGIN="# >>> EXPOR-SIEVE-PROXY (managed by deploy-to-mail-vps.sh) >>>"

log()  { printf '[uninstall] %s\n' "$*" >&2; }
step() { printf '[uninstall] step: %s\n' "$*" >&2; }
fail() { printf '[uninstall][FAIL] %s\n' "$*" >&2; exit 1; }

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    log "Re-executing under sudo..."
    exec sudo -E \
      MAILCOW_DIR="$MAILCOW_DIR" \
      RESTORE_BACKUP="$RESTORE_BACKUP" \
      REMOVE_IMAGE="$REMOVE_IMAGE" \
      IMAGE_NAME="$IMAGE_NAME" \
      NONINTERACTIVE="$NONINTERACTIVE" \
      bash "$0" "$@"
  else
    fail "must run as root (no sudo found)"
  fi
fi

[[ -d "$MAILCOW_DIR" ]] || fail "mailcow not found at $MAILCOW_DIR"

OVERRIDE="${MAILCOW_DIR}/docker-compose.override.yml"
ENV_FILE="${MAILCOW_DIR}/.expor-sieve-proxy.env"
NGINX_SITE_DST="${MAILCOW_DIR}/data/conf/nginx/site.sieve-proxy.custom"

# ---- Stop & remove container --------------------------------------------

step "stop & remove container"
( cd "$MAILCOW_DIR" && docker compose stop expor-sieve-proxy ) 2>/dev/null || true
( cd "$MAILCOW_DIR" && docker compose rm -f expor-sieve-proxy ) 2>/dev/null || true

# ---- Restore / strip override block --------------------------------------

if [[ -f "$OVERRIDE" ]]; then
  if [[ "$RESTORE_BACKUP" == "1" ]]; then
    LATEST_BAK="$(ls -1t "${OVERRIDE}".bak-* 2>/dev/null | head -1 || true)"
    if [[ -n "$LATEST_BAK" ]]; then
      step "restore latest backup → $LATEST_BAK"
      cp -a "$LATEST_BAK" "$OVERRIDE"
    else
      step "no backup found — stripping marker block in-place"
      RESTORE_BACKUP=0
    fi
  fi
  if [[ "$RESTORE_BACKUP" != "1" ]]; then
    step "strip EXPOR-SIEVE-PROXY block from $OVERRIDE"
    TMP="$(mktemp)"
    awk -v b1="$MARK_BEGIN" -v b2="$LEGACY_MARK_BEGIN" -v e="$MARK_END" '
      $0 == b1 || $0 == b2 { skip=1; next }
      $0 == e              { skip=0; next }
      !skip                { print }
    ' "$OVERRIDE" > "$TMP"
    mv "$TMP" "$OVERRIDE"
    chown root:root "$OVERRIDE"
    chmod 644 "$OVERRIDE"
  fi
else
  log "no override file present"
fi

# ---- Remove env file -----------------------------------------------------

if [[ -f "$ENV_FILE" ]]; then
  step "remove $ENV_FILE"
  rm -f "$ENV_FILE"
else
  log "no env file present"
fi

# ---- Remove nginx snippet ------------------------------------------------

if [[ -f "$NGINX_SITE_DST" ]]; then
  step "remove $NGINX_SITE_DST"
  rm -f "$NGINX_SITE_DST"
else
  log "no nginx snippet present"
fi

# ---- Reload nginx --------------------------------------------------------

NGINX_CONTAINER="$(docker ps --filter 'name=nginx-mailcow' --format '{{.Names}}' | head -1 || true)"
if [[ -n "$NGINX_CONTAINER" ]]; then
  step "reload nginx"
  docker exec "$NGINX_CONTAINER" nginx -t 2>&1 | tail -3 || true
  docker exec "$NGINX_CONTAINER" nginx -s reload || true
else
  log "nginx-mailcow not running — skipped reload"
fi

# ---- Optionally remove image --------------------------------------------

if [[ "$REMOVE_IMAGE" == "1" ]]; then
  if [[ "$NONINTERACTIVE" != "1" && -t 0 ]]; then
    printf '[uninstall] Remove docker image %s:* ? [y/N] ' "$IMAGE_NAME" >&2
    read -r ANS
    [[ "$ANS" =~ ^[Yy]$ ]] || REMOVE_IMAGE=0
  fi
  if [[ "$REMOVE_IMAGE" == "1" ]]; then
    step "remove docker image"
    docker images --format '{{.Repository}}:{{.Tag}}' \
      | grep -E "^${IMAGE_NAME}:" \
      | xargs -r docker rmi -f \
      || log "WARN: image removal had errors"
  fi
fi

cat <<EOF

================================================================
[uninstall] Removed.

  To remove the F2B whitelist entry for the middleware subnet:
    docker exec \$(docker ps --filter name=redis-mailcow --format '{{.Names}}' | head -1) \\
      redis-cli HDEL F2B_WHITELIST 172.22.1.0/24

  Old override backups are kept at:
    ${OVERRIDE}.bak-*

  To remove the docker image as well, re-run with REMOVE_IMAGE=1.
================================================================
EOF
