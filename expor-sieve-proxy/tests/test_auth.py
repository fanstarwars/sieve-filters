"""Юнит-тесты auth.py: IMAP моки, кэш, lockout, LRU eviction."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from expor_sieve_proxy import auth as auth_mod
from expor_sieve_proxy.auth import _hash_password, imap_bind

# -------- imap_bind: моки aioimaplib -------- #


class _FakeImap:
    """Минимальный фейк aioimaplib.IMAP4_SSL."""

    def __init__(self, login_result="OK", raise_on=None):
        self._login_result = login_result
        self._raise_on = raise_on or set()

    async def wait_hello_from_server(self):
        if "hello" in self._raise_on:
            raise OSError("no greeting")

    async def login(self, user, password):
        if "login" in self._raise_on:
            raise OSError("connection lost")
        if self._login_result == "TIMEOUT":
            await asyncio.sleep(10)  # должно прерваться wait_for'ом
        return SimpleNamespace(result=self._login_result)

    async def logout(self):
        return SimpleNamespace(result="OK")


async def test_imap_bind_success(monkeypatch):
    monkeypatch.setattr(auth_mod.aioimaplib, "IMAP4_SSL", lambda **kw: _FakeImap("OK"))
    ok = await imap_bind("h", 993, "u@x.ru", "p", use_ssl=True, timeout=1.0)
    assert ok is True


async def test_imap_bind_login_no(monkeypatch):
    monkeypatch.setattr(auth_mod.aioimaplib, "IMAP4_SSL", lambda **kw: _FakeImap("NO"))
    ok = await imap_bind("h", 993, "u@x.ru", "wrong", use_ssl=True, timeout=1.0)
    assert ok is False


async def test_imap_bind_bad(monkeypatch):
    monkeypatch.setattr(auth_mod.aioimaplib, "IMAP4_SSL", lambda **kw: _FakeImap("BAD"))
    ok = await imap_bind("h", 993, "u@x.ru", "p", use_ssl=True, timeout=1.0)
    assert ok is False


async def test_imap_bind_timeout(monkeypatch):
    monkeypatch.setattr(auth_mod.aioimaplib, "IMAP4_SSL", lambda **kw: _FakeImap("TIMEOUT"))
    ok = await imap_bind("h", 993, "u@x.ru", "p", use_ssl=True, timeout=0.05)
    assert ok is False


async def test_imap_bind_network_error(monkeypatch):
    monkeypatch.setattr(
        auth_mod.aioimaplib, "IMAP4_SSL", lambda **kw: _FakeImap(raise_on={"login"})
    )
    ok = await imap_bind("h", 993, "u@x.ru", "p", use_ssl=True, timeout=1.0)
    assert ok is False


async def test_imap_bind_plaintext_path(monkeypatch):
    """use_ssl=False должен использовать IMAP4 (а не IMAP4_SSL)."""
    called = {}

    def _factory(**kw):
        called["yes"] = True
        return _FakeImap("OK")

    monkeypatch.setattr(auth_mod.aioimaplib, "IMAP4", _factory)
    ok = await imap_bind("h", 143, "u@x.ru", "p", use_ssl=False, timeout=1.0)
    assert ok is True
    assert called.get("yes")


# -------- AuthService: cache, lockout -------- #


async def test_authenticate_cache_miss_then_hit(auth_service, monkeypatch):
    calls = {"n": 0}

    async def _bind(host, port, user, password, **kw):
        calls["n"] += 1
        return True

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    ok, _ = await auth_service.authenticate("u@x.ru", "p")
    assert ok
    ok, _ = await auth_service.authenticate("u@x.ru", "p")
    assert ok
    assert calls["n"] == 1, "второй вызов должен быть из кэша"


async def test_authenticate_cache_expiry(auth_service, monkeypatch):
    """Подменяем _now чтобы проверить TTL без time.sleep."""
    fake_time = [1000.0]
    auth_service._now = lambda: fake_time[0]

    calls = {"n": 0}

    async def _bind(host, port, user, password, **kw):
        calls["n"] += 1
        return True

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    await auth_service.authenticate("u@x.ru", "p")
    fake_time[0] += auth_service.settings.auth_cache_ttl + 1
    await auth_service.authenticate("u@x.ru", "p")
    assert calls["n"] == 2


async def test_authenticate_lockout(auth_service, monkeypatch):
    """3 неудачи подряд (threshold=3) → 4-я попытка возвращает retry_after>0."""

    async def _bind(host, port, user, password, **kw):
        return False

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    for _ in range(3):
        ok, retry = await auth_service.authenticate("u@x.ru", "wrong")
        assert not ok
        assert retry == 0
    ok, retry = await auth_service.authenticate("u@x.ru", "wrong")
    assert not ok
    assert retry > 0


async def test_lockout_resets_on_success(auth_service, monkeypatch):
    state = {"ok": False}

    async def _bind(host, port, user, password, **kw):
        return state["ok"]

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    await auth_service.authenticate("u@x.ru", "wrong")
    await auth_service.authenticate("u@x.ru", "wrong")
    state["ok"] = True
    ok, _ = await auth_service.authenticate("u@x.ru", "right")
    assert ok
    # Теперь снова неудачи — счётчик должен начаться с нуля
    state["ok"] = False
    for _ in range(2):
        ok, retry = await auth_service.authenticate("u@x.ru", "wrong")
        assert retry == 0


async def test_cache_is_case_insensitive_on_user(auth_service, monkeypatch):
    calls = {"n": 0}

    async def _bind(host, port, user, password, **kw):
        calls["n"] += 1
        return True

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    await auth_service.authenticate("Ivan@X.RU", "p")
    await auth_service.authenticate("ivan@x.ru", "p")
    assert calls["n"] == 1


async def test_cache_lru_eviction(auth_service, monkeypatch):
    """auth_cache_max=5 в conftest. После 6 разных юзеров первый должен быть выселен."""

    async def _bind(host, port, user, password, **kw):
        return True

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    for i in range(5):
        await auth_service.authenticate(f"u{i}@x.ru", "p")
    assert len(auth_service._cache) == 5
    await auth_service.authenticate("u5@x.ru", "p")
    assert len(auth_service._cache) == 5
    # u0 должен быть удалён
    keys = [k[0] for k in auth_service._cache.keys()]
    assert "u0@x.ru" not in keys
    assert "u5@x.ru" in keys


async def test_invalidate_user(auth_service, monkeypatch):
    async def _bind(host, port, user, password, **kw):
        return True

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    await auth_service.authenticate("u@x.ru", "p")
    assert any(k[0] == "u@x.ru" for k in auth_service._cache)
    auth_service.invalidate("u@x.ru")
    assert not any(k[0] == "u@x.ru" for k in auth_service._cache)


async def test_empty_credentials_rejected(auth_service):
    ok, _ = await auth_service.authenticate("", "p")
    assert not ok
    ok, _ = await auth_service.authenticate("u@x.ru", "")
    assert not ok


def test_password_hash_stable():
    h1 = _hash_password("secret", "pepper")
    h2 = _hash_password("secret", "pepper")
    h3 = _hash_password("secret2", "pepper")
    assert h1 == h2
    assert h1 != h3
    assert len(h1) == 16
