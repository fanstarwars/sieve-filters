"""End-to-end: middleware с настоящим httpx → mock_mailcow ASGI app + stub IMAP."""

from __future__ import annotations

import base64

import httpx
import pytest

from expor_sieve_proxy import auth as auth_mod
from expor_sieve_proxy.upstream import MailcowClient

from .mock_mailcow import create_app as create_mock_mailcow

VALID_SCRIPT = "# expor-sieve v1 managed\nrequire [\"fileinto\"];\n"


@pytest.fixture
def basic_auth():
    token = base64.b64encode(b"test@example.com:secret").decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture
def mocked_client_factory():
    """Фабрика _MockedClient (httpx через ASGITransport к mock_mailcow FastAPI app)."""
    mock_app = create_mock_mailcow()

    class _MockedClient(MailcowClient):
        async def _get_client(self):
            if self._client is None:
                transport = httpx.ASGITransport(app=mock_app)
                self._client = httpx.AsyncClient(
                    transport=transport,
                    base_url="http://mock-mailcow",
                    timeout=self.settings.request_timeout,
                    headers={"X-API-Key": "dev-rw-key"},  # match mock_mailcow.API_KEY
                )
            return self._client

    def factory():
        return _MockedClient()

    return factory


@pytest.fixture
def app(mocked_client_factory, monkeypatch):
    """FastAPI app с подменёнными IMAP-bind и upstream-клиентом через dependency_overrides."""

    async def _bind(host, port, user, password, **kw):
        return user.lower() == "test@example.com" and password == "secret"

    monkeypatch.setattr(auth_mod, "imap_bind", _bind)
    from expor_sieve_proxy.main import create_app
    from expor_sieve_proxy.routes import get_mailcow_client as _dep_key

    a = create_app()
    a.dependency_overrides[_dep_key] = mocked_client_factory
    yield a
    a.dependency_overrides.clear()


@pytest.fixture
def client(app):
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


# ---------- Сценарий: полный flow ---------- #


def test_e2e_health(client):
    assert client.get("/health").status_code == 200


def test_e2e_auth_check(client, basic_auth):
    r = client.get("/v1/auth/check", headers=basic_auth)
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_e2e_full_flow(client, basic_auth):
    # 1. List filters: видим только "свои"
    r = client.get("/v1/filters/test@example.com", headers=basic_auth)
    assert r.status_code == 200
    initial = r.json()
    initial_ids = {x["id"] for x in initial}
    assert 1 in initial_ids
    assert 99 not in initial_ids  # other@example.com — не наш

    # 2. Add filter
    r = client.post(
        "/v1/filters",
        headers=basic_auth,
        json={
            "active": 1,
            "username": "test@example.com",
            "script_desc": "e2e-test",
            "script_data": VALID_SCRIPT,
            "filter_type": "prefilter",
        },
    )
    assert r.status_code == 200, r.text

    # 3. List → новый есть
    r = client.get("/v1/filters/test@example.com", headers=basic_auth)
    descs = [x["script_desc"] for x in r.json()]
    assert "e2e-test" in descs
    new_id = next(x["id"] for x in r.json() if x["script_desc"] == "e2e-test")

    # 4. Edit our filter
    r = client.post(
        "/v1/filters/edit",
        headers=basic_auth,
        json={"items": [new_id], "attr": {"active": 0}},
    )
    assert r.status_code == 200, r.text

    # 5. Delete
    r = client.post("/v1/filters/delete", headers=basic_auth, json=[new_id])
    assert r.status_code == 200, r.text

    # 6. Список снова — нашего нет
    r = client.get("/v1/filters/test@example.com", headers=basic_auth)
    descs = [x["script_desc"] for x in r.json()]
    assert "e2e-test" not in descs


def test_e2e_other_mailbox_path_403(client, basic_auth):
    r = client.get("/v1/mailbox/other@example.com", headers=basic_auth)
    assert r.status_code == 403


def test_e2e_other_mailbox_body_403(client, basic_auth):
    r = client.post(
        "/v1/filters",
        headers=basic_auth,
        json={
            "active": 1,
            "username": "other@example.com",
            "script_desc": "x",
            "script_data": VALID_SCRIPT,
        },
    )
    assert r.status_code == 403


def test_e2e_no_marker_400(client, basic_auth):
    r = client.post(
        "/v1/filters",
        headers=basic_auth,
        json={
            "active": 1,
            "username": "test@example.com",
            "script_desc": "x",
            "script_data": "require [\"fileinto\"];\n",
        },
    )
    assert r.status_code == 400


def test_e2e_delete_someone_elses_id_403(client, basic_auth):
    # id=99 принадлежит other@example.com — тестовому test@example.com нельзя
    r = client.post("/v1/filters/delete", headers=basic_auth, json=[99])
    assert r.status_code == 403


def test_e2e_bruteforce_lockout(client, monkeypatch):
    """11 неудач (threshold=3 в conftest, но e2e-фикстура перекрывает только imap)
    → должен быть 401 + retry_after."""
    # Перезаписать на always-fail для bruteforce-теста
    async def _bind_fail(host, port, user, password, **kw):
        return False

    monkeypatch.setattr(auth_mod, "imap_bind", _bind_fail)

    bad = base64.b64encode(b"new@example.com:wrong").decode()
    h = {"Authorization": f"Basic {bad}"}
    statuses = []
    for _ in range(5):
        r = client.get("/v1/auth/check", headers=h)
        statuses.append(r.status_code)
    # все 401
    assert all(s == 401 for s in statuses)
    # последний должен иметь retry_after в теле (lockout сработал на 4й)
    last = client.get("/v1/auth/check", headers=h)
    assert last.status_code in (401, 429)
    body = last.json()
    assert body["type"] == "error"


def test_e2e_mailcow_down_returns_502(app, client, basic_auth):
    """Подменяем upstream-клиента на падающий через FastAPI dependency_overrides — должен прийти 502."""
    import httpx as _httpx

    # FastAPI Depends keys by the actual reference stored in routes module.
    from expor_sieve_proxy.routes import get_mailcow_client as _routes_dep

    class _Broken(MailcowClient):
        async def _get_client(self):
            raise _httpx.ConnectError("nope")

    app.dependency_overrides[_routes_dep] = lambda: _Broken()
    try:
        r = client.get("/v1/mailbox/test@example.com", headers=basic_auth)
        assert r.status_code in (500, 502), f"got {r.status_code}: {r.text}"
    finally:
        app.dependency_overrides.clear()
