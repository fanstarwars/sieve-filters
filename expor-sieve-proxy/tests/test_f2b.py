"""Тесты F2B-publisher: формат сообщения, best-effort при недоступности
Redis, интеграция в require_auth (publish при unauthorized, НЕ при lockout)."""

from __future__ import annotations

import base64
import re
from types import SimpleNamespace

import pytest

from expor_sieve_proxy import auth as auth_mod
from expor_sieve_proxy import config as config_mod
from expor_sieve_proxy import f2b as f2b_mod
from expor_sieve_proxy.f2b import F2BPublisher

# Точно тот же regex, что использует mailcow netfilter (f2bregex[1]):
# https://github.com/mailcow/mailcow-dockerized/blob/master/data/Dockerfiles/netfilter/main.py
MAILCOW_F2B_REGEX_1 = re.compile(
    r"mailcow UI: Invalid password for .+ by ([0-9a-f\.:]+)"
)


# ---------------------------------------------------------------- #
#  Фейковый redis.asyncio клиент
# ---------------------------------------------------------------- #


class _FakeRedis:
    def __init__(self, raise_on_publish: Exception | None = None):
        self.published: list[tuple[str, str]] = []  # (channel, message)
        self._raise_on_publish = raise_on_publish

    async def publish(self, channel, message):
        if self._raise_on_publish is not None:
            raise self._raise_on_publish
        self.published.append((channel, message))
        return 1

    async def aclose(self):
        pass


def _install_fake_redis(monkeypatch, instance: _FakeRedis):
    """Подменить redis.asyncio.from_url на фабрику нашего фейка."""
    fake_module = SimpleNamespace(from_url=lambda *a, **kw: instance)
    monkeypatch.setattr(f2b_mod, "aioredis", fake_module)


# ---------------------------------------------------------------- #
#  Юнит: F2BPublisher.publish_fail
# ---------------------------------------------------------------- #


@pytest.fixture
def f2b_on(monkeypatch):
    monkeypatch.setenv("F2B_ENABLED", "true")
    monkeypatch.setenv("REDIS_URL", "redis://test:6379/0")
    config_mod.reset_settings_cache()
    f2b_mod.reset_f2b_publisher()
    yield
    config_mod.reset_settings_cache()
    f2b_mod.reset_f2b_publisher()


async def test_publish_fail_message_format_matches_mailcow_regex(monkeypatch, f2b_on):
    """Формат сообщения должен матчить f2bregex[1] mailcow netfilter."""
    fake = _FakeRedis()
    _install_fake_redis(monkeypatch, fake)

    pub = F2BPublisher()
    ok = await pub.publish_fail(ip="203.0.113.42", user="bob@example.com")
    assert ok is True
    assert len(fake.published) == 1
    channel, msg = fake.published[0]
    assert channel == "F2B_CHANNEL"
    m = MAILCOW_F2B_REGEX_1.match(msg)
    assert m is not None, f"netfilter regex не матчит сообщение: {msg!r}"
    assert m.group(1) == "203.0.113.42"
    # Username должен быть в сообщении (для логов и регекс'а .+).
    assert "bob@example.com" in msg


async def test_publish_fail_disabled_returns_false(monkeypatch):
    """F2B_ENABLED=false → publish_fail no-op, без обращения к redis."""
    monkeypatch.setenv("F2B_ENABLED", "false")
    config_mod.reset_settings_cache()
    f2b_mod.reset_f2b_publisher()

    fake = _FakeRedis()
    _install_fake_redis(monkeypatch, fake)
    pub = F2BPublisher()
    ok = await pub.publish_fail(ip="1.2.3.4", user="x@y.z")
    assert ok is False
    assert fake.published == []


async def test_publish_fail_no_ip_skipped(monkeypatch, f2b_on):
    """Без валидного IP F2B бесполезен — не публикуем."""
    fake = _FakeRedis()
    _install_fake_redis(monkeypatch, fake)
    pub = F2BPublisher()
    assert await pub.publish_fail(ip="", user="u@x.z") is False
    assert await pub.publish_fail(ip="unknown", user="u@x.z") is False
    assert fake.published == []


async def test_publish_fail_redis_error_is_swallowed(monkeypatch, f2b_on):
    """Любой error в publish() → False + warning, НЕ исключение наружу."""
    fake = _FakeRedis(raise_on_publish=ConnectionError("redis down"))
    _install_fake_redis(monkeypatch, fake)
    pub = F2BPublisher()
    ok = await pub.publish_fail(ip="1.2.3.4", user="u@x.z")
    assert ok is False


async def test_publish_fail_when_redis_module_missing(monkeypatch, f2b_on):
    """Если redis-py не установлен (aioredis is None) — publish тихо False."""
    monkeypatch.setattr(f2b_mod, "aioredis", None)
    pub = F2BPublisher()
    ok = await pub.publish_fail(ip="1.2.3.4", user="u@x.z")
    assert ok is False


async def test_publish_fail_init_failure_swallowed(monkeypatch, f2b_on):
    """from_url бросает исключение → init_failed, publish False."""
    def _boom(*a, **kw):
        raise OSError("connection refused")

    fake_module = SimpleNamespace(from_url=_boom)
    monkeypatch.setattr(f2b_mod, "aioredis", fake_module)
    pub = F2BPublisher()
    ok = await pub.publish_fail(ip="1.2.3.4", user="u@x.z")
    assert ok is False
    assert pub._init_failed is True


async def test_publisher_singleton(monkeypatch):
    """get_f2b_publisher возвращает одну инстанцию до reset'а."""
    f2b_mod.reset_f2b_publisher()
    p1 = f2b_mod.get_f2b_publisher()
    p2 = f2b_mod.get_f2b_publisher()
    assert p1 is p2
    f2b_mod.reset_f2b_publisher()
    p3 = f2b_mod.get_f2b_publisher()
    assert p3 is not p1


async def test_aclose_idempotent(monkeypatch, f2b_on):
    fake = _FakeRedis()
    _install_fake_redis(monkeypatch, fake)
    pub = F2BPublisher()
    await pub.publish_fail(ip="1.2.3.4", user="u@x.z")
    await pub.aclose()
    # Повторный aclose не должен ронять
    await pub.aclose()


# ---------------------------------------------------------------- #
#  Интеграция через require_auth: 401 на bind-fail → publish
# ---------------------------------------------------------------- #


async def test_require_auth_publishes_on_bind_fail(monkeypatch):
    """Невалидный Basic → bind возвращает False → F2B publish."""
    monkeypatch.setenv("F2B_ENABLED", "true")
    monkeypatch.setenv("REDIS_URL", "redis://test:6379/0")
    config_mod.reset_settings_cache()
    auth_mod.reset_auth_service()
    f2b_mod.reset_f2b_publisher()

    fake = _FakeRedis()
    _install_fake_redis(monkeypatch, fake)

    async def _bind(host, port, user, password, **kw):
        return False

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)

    from fastapi.testclient import TestClient

    from expor_sieve_proxy.main import create_app

    app = create_app()
    with TestClient(app) as client:
        token = base64.b64encode(b"victim@x.ru:wrong").decode()
        r = client.get(
            "/v1/auth/check",
            headers={
                "Authorization": f"Basic {token}",
                "X-Forwarded-For": "198.51.100.7",
            },
        )
    assert r.status_code == 401
    # Publish мог быть выполнен в background — но FastAPI await'ит наш
    # publish_fail синхронно, так что к этому моменту он завершён.
    assert len(fake.published) == 1
    channel, msg = fake.published[0]
    assert channel == "F2B_CHANNEL"
    assert "198.51.100.7" in msg
    assert "victim@x.ru" in msg
    m = MAILCOW_F2B_REGEX_1.match(msg)
    assert m and m.group(1) == "198.51.100.7"


async def test_require_auth_does_not_publish_on_lockout(monkeypatch):
    """Если юзер УЖЕ залочен — НЕ дублируем F2B-events."""
    monkeypatch.setenv("F2B_ENABLED", "true")
    monkeypatch.setenv("REDIS_URL", "redis://test:6379/0")
    monkeypatch.setenv("AUTH_BRUTEFORCE_THRESHOLD", "2")
    monkeypatch.setenv("AUTH_BRUTEFORCE_WINDOW", "60")
    config_mod.reset_settings_cache()
    auth_mod.reset_auth_service()
    f2b_mod.reset_f2b_publisher()

    fake = _FakeRedis()
    _install_fake_redis(monkeypatch, fake)

    async def _bind(host, port, user, password, **kw):
        return False

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)

    from fastapi.testclient import TestClient

    from expor_sieve_proxy.main import create_app

    app = create_app()
    with TestClient(app) as client:
        token = base64.b64encode(b"victim@x.ru:wrong").decode()
        headers = {
            "Authorization": f"Basic {token}",
            "X-Forwarded-For": "198.51.100.8",
        }
        # Threshold=2: первые 2 попытки → bind-fail → F2B publish (×2).
        for _ in range(2):
            client.get("/v1/auth/check", headers=headers)
        published_before_lockout = len(fake.published)
        assert published_before_lockout == 2
        # 3-я → уже лочка, retry_after>0 → НЕ публикуем.
        r = client.get("/v1/auth/check", headers=headers)
    assert r.status_code == 401
    assert len(fake.published) == published_before_lockout, (
        "lockout не должен порождать F2B-events"
    )


async def test_require_auth_no_publish_on_success(monkeypatch):
    """Успешный bind → нечего публиковать."""
    monkeypatch.setenv("F2B_ENABLED", "true")
    monkeypatch.setenv("REDIS_URL", "redis://test:6379/0")
    config_mod.reset_settings_cache()
    auth_mod.reset_auth_service()
    f2b_mod.reset_f2b_publisher()

    fake = _FakeRedis()
    _install_fake_redis(monkeypatch, fake)

    async def _bind(host, port, user, password, **kw):
        return True

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)

    from fastapi.testclient import TestClient

    from expor_sieve_proxy.main import create_app

    app = create_app()
    with TestClient(app) as client:
        token = base64.b64encode(b"good@x.ru:right").decode()
        r = client.get(
            "/v1/auth/check",
            headers={
                "Authorization": f"Basic {token}",
                "X-Forwarded-For": "198.51.100.9",
            },
        )
    assert r.status_code == 200
    assert fake.published == []


async def test_require_auth_no_publish_on_missing_basic(monkeypatch):
    """Запрос без заголовка Authorization → publish не нужен (нет user/IP-context)."""
    monkeypatch.setenv("F2B_ENABLED", "true")
    monkeypatch.setenv("REDIS_URL", "redis://test:6379/0")
    config_mod.reset_settings_cache()
    auth_mod.reset_auth_service()
    f2b_mod.reset_f2b_publisher()

    fake = _FakeRedis()
    _install_fake_redis(monkeypatch, fake)

    from fastapi.testclient import TestClient

    from expor_sieve_proxy.main import create_app

    app = create_app()
    with TestClient(app) as client:
        r = client.get("/v1/auth/check", headers={"X-Forwarded-For": "198.51.100.10"})
    assert r.status_code == 401
    # No Basic = no user identifier → не публикуем (это вообще не bruteforce
    # IMAP, а кривой клиент). Регекс mailcow всё равно проматчит, но логика
    # «не сорить» работает на уровне require_auth.
    assert fake.published == []
