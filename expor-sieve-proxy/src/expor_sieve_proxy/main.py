# SPDX-License-Identifier: GPL-3.0-or-later
"""FastAPI app entrypoint."""

from __future__ import annotations

import contextlib
import secrets
import sys

import structlog
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .config import get_settings
from .f2b import get_f2b_publisher
from .logging import configure_logging
from .routes import router
from .upstream import get_mailcow_client


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    log = structlog.get_logger("startup")
    if not settings.mailcow_api_key:
        log.error("config.missing_api_key", msg="MAILCOW_API_KEY is required")
        # Не падаем при импорте (тесты), но в проде это всё равно ошибка.
        # uvicorn запустит приложение, но любой upstream-запрос отдаст 502.
    log.info(
        "startup",
        version=__version__,
        mailcow_url=settings.mailcow_api_url,
        dovecot=f"{settings.dovecot_host}:{settings.dovecot_port}",
        ssl=settings.dovecot_use_ssl,
    )
    yield
    client = get_mailcow_client()
    await client.aclose()
    try:
        await get_f2b_publisher().aclose()
    except Exception:  # pragma: no cover - best-effort shutdown
        pass
    log.info("shutdown")


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="expor-sieve-proxy",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,  # никаких swagger в проде, ТЗ §5: только whitelist
        redoc_url=None,
        openapi_url=None,
    )

    # CORS. Starlette wildcard ("*") матчит любой Origin; точные origins
    # типа "moz-extension://abc-..." матчат substring; **literal "moz-extension://*"
    # НЕ работает** (Starlette wildcard'ы только для allow_origin_regex).
    # Поэтому: если в env стоит литерал с "*", переводим его в regex.
    origins = settings.origins_list()
    has_wildcard_pattern = any("*" in o and o != "*" for o in origins)
    if has_wildcard_pattern:
        # "moz-extension://*" → regex "moz-extension://.*", через | объединяем все.
        regex_parts = []
        plain_origins = []
        for o in origins:
            if "*" in o and o != "*":
                regex_parts.append(o.replace(".", r"\.").replace("*", ".*"))
            elif o == "*":
                regex_parts.append(".*")
            else:
                plain_origins.append(o)
        app.add_middleware(
            CORSMiddleware,
            allow_origins=plain_origins,
            allow_origin_regex="^(" + "|".join(regex_parts) + ")$",
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
            max_age=600,
        )
    else:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
            max_age=600,
        )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        rid = request.headers.get("x-request-id") or secrets.token_hex(8)
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=rid,
            method=request.method,
            path=request.url.path,
        )
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        return response

    # Унифицированный handler для HTTPException, чтобы тело всегда было {type,msg}.
    @app.exception_handler(HTTPException)
    async def _http_exc(request: Request, exc: HTTPException):
        detail = exc.detail
        if isinstance(detail, dict):
            body = detail
        else:
            body = {"type": "error", "msg": str(detail)}
        headers = exc.headers or {}
        return JSONResponse(status_code=exc.status_code, content=body, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _val_exc(request: Request, exc: RequestValidationError):
        # Не льём подробности (в них может быть кусок body — потенциально script_data).
        # Достаточно списка полей. В лог пишем для дебага.
        fields = []
        for err in exc.errors():
            loc = ".".join(str(x) for x in err.get("loc", []))
            fields.append(f"{loc}: {err.get('msg')}")
        import structlog as _sl
        _sl.get_logger("validation").warning(
            "request.validation_error",
            path=str(request.url.path),
            method=request.method,
            fields=fields[:10],
        )
        return JSONResponse(
            status_code=400,
            content={"type": "error", "msg": "validation failed", "details": fields[:10]},
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        log = structlog.get_logger("unhandled")
        log.error("internal_error", err=str(exc), err_type=type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content={"type": "error", "msg": "internal server error"},
        )

    app.include_router(router)
    return app


app = create_app()


def main() -> int:
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "expor_sieve_proxy.main:app",
        host="0.0.0.0",
        port=settings.listen_port,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
