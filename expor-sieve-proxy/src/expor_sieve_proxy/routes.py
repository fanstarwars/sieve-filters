"""5 эндпоинтов + /health + /v1/auth/check (ТЗ §5)."""

from __future__ import annotations

import base64
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.responses import JSONResponse

from . import __version__
from .auth import AuthService, get_auth_service
from .f2b import F2BPublisher, get_f2b_publisher
from .models import (
    SCRIPT_WARN_THRESHOLD,
    AddFilterReq,
    AuthCheckResp,
    DeleteFilterReq,
    EditFilterReq,
    HealthResp,
)
from .ownership import (
    filter_belongs_to_user,
    has_admin_login_marker,
    usernames_match,
)
from .ratelimit import TokenBucketLimiter, get_rate_limiter
from .upstream import MailcowClient, UpstreamError, get_mailcow_client

log = structlog.get_logger("routes")

router = APIRouter()


# ---------------------------------------------------------------- #
#  Helpers
# ---------------------------------------------------------------- #


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    if request.client:
        return request.client.host
    return "unknown"


def _parse_basic(header: str | None) -> tuple[str, str] | None:
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "basic":
        return None
    try:
        decoded = base64.b64decode(parts[1].strip(), validate=True).decode("utf-8")
    except Exception:
        return None
    if ":" not in decoded:
        return None
    user, password = decoded.split(":", 1)
    return user, password


def _err(status_code: int, msg: str, **extra: Any) -> JSONResponse:
    body: dict[str, Any] = {"type": "error", "msg": msg}
    body.update(extra)
    headers: dict[str, str] = {}
    if status_code == 401:
        headers["WWW-Authenticate"] = 'Basic realm="expor-sieve-proxy", charset="UTF-8"'
    return JSONResponse(status_code=status_code, content=body, headers=headers)


# ---------------------------------------------------------------- #
#  Auth dependency
# ---------------------------------------------------------------- #


async def require_auth(
    request: Request,
    auth: Annotated[AuthService, Depends(get_auth_service)],
    limiter: Annotated[TokenBucketLimiter, Depends(get_rate_limiter)],
    f2b: Annotated[F2BPublisher, Depends(get_f2b_publisher)],
) -> str:
    """Вернуть аутентифицированного юзера или поднять HTTPException.

    Делает per-IP rate-limit, парсит Basic, IMAP-bind с кэшем, lockout.
    При провале IMAP-bind публикует событие в Redis F2B_CHANNEL чтобы
    netfilter mailcow забанил IP атакующего.
    """
    ip = _client_ip(request)
    structlog.contextvars.bind_contextvars(remote_addr=ip)

    allowed, retry_after = limiter.check(ip)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={"type": "error", "msg": "rate limited", "retry_after": int(retry_after) + 1},
        )

    creds = _parse_basic(request.headers.get("authorization"))
    if not creds:
        raise HTTPException(
            status_code=401,
            detail={"type": "error", "msg": "unauthorized"},
            headers={"WWW-Authenticate": 'Basic realm="expor-sieve-proxy"'},
        )

    user, password = creds
    if has_admin_login_marker(user):
        log.warning("auth.admin_login_marker", user=user)

    ok, lockout_retry = await auth.authenticate(user, password)
    if not ok:
        detail: dict[str, Any] = {"type": "error", "msg": "unauthorized"}
        if lockout_retry > 0:
            detail["retry_after"] = int(lockout_retry) + 1
        else:
            # Реальный bind-fail (а не наш per-user lockout). Публикуем для
            # F2B mailcow — best-effort, не блокирует ответ юзеру.
            # При lockout не публикуем: пользователь УЖЕ заблокирован
            # на нашей стороне, бомбить F2B повторами на тот же IP смысла нет.
            try:
                await f2b.publish_fail(ip=ip, user=user)
            except Exception as e:  # pragma: no cover - defensive
                log.warning("f2b.publish_unhandled", err=str(e))
        raise HTTPException(
            status_code=401,
            detail=detail,
            headers={"WWW-Authenticate": 'Basic realm="expor-sieve-proxy"'},
        )

    structlog.contextvars.bind_contextvars(user=user.lower())
    return user


# ---------------------------------------------------------------- #
#  Endpoints
# ---------------------------------------------------------------- #


@router.get("/health", response_model=HealthResp, include_in_schema=True)
async def health() -> HealthResp:
    return HealthResp(version=__version__)


@router.get("/v1/auth/check", response_model=AuthCheckResp)
async def auth_check(user: Annotated[str, Depends(require_auth)]) -> AuthCheckResp:
    return AuthCheckResp(ok=True, user=user)


@router.get("/v1/mailbox/{username}")
async def get_mailbox(
    username: Annotated[str, Path(min_length=3, max_length=255)],
    auth_user: Annotated[str, Depends(require_auth)],
    mailcow: Annotated[MailcowClient, Depends(get_mailcow_client)],
) -> Any:
    if not usernames_match(auth_user, username):
        log.warning("ownership.deny", auth_user=auth_user, target=username, where="path")
        return _err(403, "forbidden")
    try:
        return await mailcow.get_mailbox(username)
    except UpstreamError as e:
        return _err(e.status, e.msg)


@router.get("/v1/filters/{username}")
async def list_filters(
    username: Annotated[str, Path(min_length=3, max_length=255)],
    auth_user: Annotated[str, Depends(require_auth)],
    mailcow: Annotated[MailcowClient, Depends(get_mailcow_client)],
) -> Any:
    if not usernames_match(auth_user, username):
        log.warning("ownership.deny", auth_user=auth_user, target=username, where="path")
        return _err(403, "forbidden")
    try:
        return await mailcow.list_filters(username)
    except UpstreamError as e:
        return _err(e.status, e.msg)


@router.post("/v1/filters")
async def add_filter(
    payload: AddFilterReq,
    auth_user: Annotated[str, Depends(require_auth)],
    mailcow: Annotated[MailcowClient, Depends(get_mailcow_client)],
) -> Any:
    if not usernames_match(auth_user, payload.username):
        log.warning(
            "ownership.deny",
            auth_user=auth_user,
            target=payload.username,
            where="body",
        )
        return _err(403, "forbidden")
    script_size = len(payload.script_data.encode("utf-8"))
    if script_size > SCRIPT_WARN_THRESHOLD:
        log.warning(
            "script.size_warn",
            user=auth_user,
            op="add",
            size=script_size,
            threshold=SCRIPT_WARN_THRESHOLD,
        )
    try:
        body = await mailcow.add_filter(payload.model_dump())
    except UpstreamError as e:
        return _err(e.status, e.msg)
    log.info(
        "audit.filter_added",
        user=auth_user,
        script_desc=payload.script_desc,
        filter_type=payload.filter_type,
        active=payload.active,
        script_size=script_size,
    )
    return body


@router.post("/v1/filters/edit")
async def edit_filter(
    payload: EditFilterReq,
    auth_user: Annotated[str, Depends(require_auth)],
    mailcow: Annotated[MailcowClient, Depends(get_mailcow_client)],
) -> Any:
    filter_id = payload.items[0]
    # Edit-by-id: подтверждаем владение через GET filters
    owns = await filter_belongs_to_user(mailcow, auth_user, filter_id)
    if not owns:
        log.warning("ownership.deny_edit", auth_user=auth_user, filter_id=filter_id)
        return _err(403, "forbidden")
    attr_dict = payload.attr.model_dump(exclude_none=True)
    script_size: int | None = None
    if "script_data" in attr_dict:
        script_size = len(attr_dict["script_data"].encode("utf-8"))
        if script_size > SCRIPT_WARN_THRESHOLD:
            log.warning(
                "script.size_warn",
                user=auth_user,
                op="edit",
                filter_id=filter_id,
                size=script_size,
                threshold=SCRIPT_WARN_THRESHOLD,
            )
    try:
        body = await mailcow.edit_filter(filter_id, attr_dict)
    except UpstreamError as e:
        return _err(e.status, e.msg)
    # Логируем какие именно поля плагин просит изменить — критично для дебага
    # «новое правило выключает остальные»: если active присылается в edit чужого
    # правила, это сразу видно в audit.
    log.info(
        "audit.filter_edited",
        user=auth_user,
        filter_id=filter_id,
        attr_keys=sorted(attr_dict.keys()),
        active=attr_dict.get("active"),
        script_size=script_size,
    )
    return body


@router.post("/v1/filters/delete")
async def delete_filter(
    payload: DeleteFilterReq,
    auth_user: Annotated[str, Depends(require_auth)],
    mailcow: Annotated[MailcowClient, Depends(get_mailcow_client)],
) -> Any:
    filter_id = payload.root[0]
    owns = await filter_belongs_to_user(mailcow, auth_user, filter_id)
    if not owns:
        log.warning("ownership.deny_delete", auth_user=auth_user, filter_id=filter_id)
        return _err(403, "forbidden")
    try:
        body = await mailcow.delete_filter(filter_id)
    except UpstreamError as e:
        return _err(e.status, e.msg)
    log.info("audit.filter_deleted", user=auth_user, filter_id=filter_id)
    return body
