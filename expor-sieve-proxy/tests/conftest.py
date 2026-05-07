"""Shared fixtures: подменяем env, IMAP-bind, upstream-клиент."""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest

from expor_sieve_proxy import auth as auth_mod
from expor_sieve_proxy import config as config_mod
from expor_sieve_proxy import f2b as f2b_mod
from expor_sieve_proxy import ratelimit as rl_mod
from expor_sieve_proxy import upstream as upstream_mod
from expor_sieve_proxy.auth import AuthService
from expor_sieve_proxy.upstream import MailcowClient


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    """Базовые env vars: маленький rate-limit, маленький cache, фиксированный pepper."""
    monkeypatch.setenv("MAILCOW_API_KEY", "test-key")
    monkeypatch.setenv("MAILCOW_API_URL", "http://mailcow.test")
    monkeypatch.setenv("DOVECOT_HOST", "dovecot.test")
    monkeypatch.setenv("DOVECOT_PORT", "993")
    monkeypatch.setenv("DOVECOT_USE_SSL", "true")
    monkeypatch.setenv("AUTH_CACHE_TTL", "300")
    monkeypatch.setenv("AUTH_CACHE_MAX", "5")
    monkeypatch.setenv("AUTH_BRUTEFORCE_THRESHOLD", "3")
    monkeypatch.setenv("AUTH_BRUTEFORCE_WINDOW", "60")
    monkeypatch.setenv("RATE_LIMIT_PER_MIN", "100")
    monkeypatch.setenv("AUTH_PEPPER", "test-pepper")
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    # F2B по умолчанию выключен в юнит-тестах — отдельный test_f2b
    # включает его явно через monkeypatch + мок redis.
    monkeypatch.setenv("F2B_ENABLED", "false")
    config_mod.reset_settings_cache()
    auth_mod.reset_auth_service()
    upstream_mod.reset_mailcow_client()
    rl_mod.reset_rate_limiter()
    f2b_mod.reset_f2b_publisher()
    yield
    config_mod.reset_settings_cache()
    auth_mod.reset_auth_service()
    upstream_mod.reset_mailcow_client()
    rl_mod.reset_rate_limiter()
    f2b_mod.reset_f2b_publisher()


@pytest.fixture
def settings():
    return config_mod.get_settings()


@pytest.fixture
def auth_service(settings) -> AuthService:
    return AuthService(settings=settings)


@pytest.fixture
def mailcow_client(settings) -> MailcowClient:
    return MailcowClient(settings=settings)


@pytest.fixture
def fake_imap_ok(monkeypatch):
    """Подменить imap_bind на функцию, возвращающую True для test@example.com/secret."""

    async def _bind(host, port, user, password, **kwargs):
        return user.lower() == "test@example.com" and password == "secret"

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    monkeypatch.setattr("expor_sieve_proxy.routes.get_auth_service", auth_mod.get_auth_service)
    return _bind


@pytest.fixture
def fake_imap_fail(monkeypatch):
    """Подменить imap_bind на функцию, всегда возвращающую False."""

    async def _bind(host, port, user, password, **kwargs):
        return False

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    return _bind


@pytest.fixture
def app(fake_imap_ok):
    """FastAPI app с подменённым IMAP."""
    from expor_sieve_proxy.main import create_app

    return create_app()


@pytest.fixture
def client(app) -> Iterator[httpx.Client]:
    """Sync TestClient через httpx (FastAPI TestClient = httpx.Client под капотом)."""
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


@pytest.fixture
def basic_auth():
    """Готовый Basic-заголовок для test@example.com:secret."""
    import base64

    token = base64.b64encode(b"test@example.com:secret").decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture
def basic_auth_other():
    import base64

    token = base64.b64encode(b"other@example.com:secret").decode()
    return {"Authorization": f"Basic {token}"}
