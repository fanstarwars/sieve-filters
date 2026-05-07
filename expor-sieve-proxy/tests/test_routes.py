"""Тесты HTTP-эндпоинтов через FastAPI TestClient + respx-мок upstream."""

from __future__ import annotations

import json

import httpx
import respx

VALID_SCRIPT = "# expor-sieve v1 managed\nrequire [\"fileinto\"];\n"


# -------- /health & /v1/auth/check -------- #


def test_health_no_auth(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "version" in body


def test_auth_check_no_basic_returns_401(client):
    r = client.get("/v1/auth/check")
    assert r.status_code == 401
    assert r.json()["type"] == "error"
    assert "WWW-Authenticate" in r.headers


def test_auth_check_bad_password(client):
    import base64
    token = base64.b64encode(b"test@example.com:wrong").decode()
    r = client.get("/v1/auth/check", headers={"Authorization": f"Basic {token}"})
    assert r.status_code == 401


def test_auth_check_malformed_basic(client):
    r = client.get("/v1/auth/check", headers={"Authorization": "NotBasic stuff"})
    assert r.status_code == 401


def test_auth_check_invalid_base64(client):
    r = client.get("/v1/auth/check", headers={"Authorization": "Basic !!!not-base64!!!"})
    assert r.status_code == 401


def test_auth_check_no_colon_in_decoded(client):
    import base64
    token = base64.b64encode(b"nocolonhere").decode()
    r = client.get("/v1/auth/check", headers={"Authorization": f"Basic {token}"})
    assert r.status_code == 401


def test_auth_check_ok(client, basic_auth):
    r = client.get("/v1/auth/check", headers=basic_auth)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["user"].lower() == "test@example.com"


# -------- /v1/mailbox/{username} -------- #


@respx.mock
def test_get_mailbox_ok(client, basic_auth):
    respx.get("http://mailcow.test/api/v1/get/mailbox/test@example.com").mock(
        return_value=httpx.Response(200, json=[{"username": "test@example.com", "active": 1}])
    )
    r = client.get("/v1/mailbox/test@example.com", headers=basic_auth)
    assert r.status_code == 200
    assert r.json()[0]["username"] == "test@example.com"


@respx.mock
def test_get_mailbox_forwards_x_api_key(client, basic_auth):
    route = respx.get("http://mailcow.test/api/v1/get/mailbox/test@example.com").mock(
        return_value=httpx.Response(200, json=[{}])
    )
    client.get("/v1/mailbox/test@example.com", headers=basic_auth)
    assert route.called
    sent = route.calls.last.request
    assert sent.headers.get("x-api-key") == "test-key"


def test_get_mailbox_other_user_forbidden(client, basic_auth):
    r = client.get("/v1/mailbox/other@example.com", headers=basic_auth)
    assert r.status_code == 403
    assert r.json()["msg"] == "forbidden"


@respx.mock
def test_get_mailbox_upstream_502(client, basic_auth):
    respx.get("http://mailcow.test/api/v1/get/mailbox/test@example.com").mock(
        return_value=httpx.Response(500)
    )
    r = client.get("/v1/mailbox/test@example.com", headers=basic_auth)
    assert r.status_code == 502


@respx.mock
def test_get_mailbox_upstream_timeout(client, basic_auth):
    respx.get("http://mailcow.test/api/v1/get/mailbox/test@example.com").mock(
        side_effect=httpx.TimeoutException("slow")
    )
    r = client.get("/v1/mailbox/test@example.com", headers=basic_auth)
    assert r.status_code == 504


# -------- /v1/filters/{username} -------- #


@respx.mock
def test_list_filters_ok(client, basic_auth):
    respx.get("http://mailcow.test/api/v1/get/filters/test@example.com").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"id": 1, "username": "test@example.com", "script_desc": "x", "active": 1}
            ],
        )
    )
    r = client.get("/v1/filters/test@example.com", headers=basic_auth)
    assert r.status_code == 200
    assert len(r.json()) == 1


def test_list_filters_other_user_forbidden(client, basic_auth):
    r = client.get("/v1/filters/other@example.com", headers=basic_auth)
    assert r.status_code == 403


# -------- POST /v1/filters (add) -------- #


@respx.mock
def test_add_filter_ok_json_body(client, basic_auth):
    # mailcow при Content-Type=application/json кладёт raw JSON в $_POST['attr']
    # (json_api.php:80-82). Поэтому для add upstream-вызов — JSON, не form.
    route = respx.post("http://mailcow.test/api/v1/add/filter").mock(
        return_value=httpx.Response(200, json=[{"type": "success", "msg": ["filter_added", 42]}])
    )
    r = client.post(
        "/v1/filters",
        headers=basic_auth,
        json={
            "active": 1,
            "username": "test@example.com",
            "script_desc": "test",
            "script_data": VALID_SCRIPT,
            "filter_type": "prefilter",
        },
    )
    assert r.status_code == 200, r.text
    assert route.called
    sent = route.calls.last.request
    assert sent.headers.get("content-type", "").startswith("application/json")
    body = json.loads(sent.content.decode())
    assert body["active"] == 1
    assert body["username"] == "test@example.com"
    assert body["filter_type"] == "prefilter"
    assert body["script_data"] == VALID_SCRIPT


def test_add_filter_other_username_forbidden(client, basic_auth):
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


def test_add_filter_no_marker_400(client, basic_auth):
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


@respx.mock
def test_add_filter_upstream_semantic_error_400(client, basic_auth):
    respx.post("http://mailcow.test/api/v1/add/filter").mock(
        return_value=httpx.Response(200, json={"type": "danger", "msg": "filter exists"})
    )
    r = client.post(
        "/v1/filters",
        headers=basic_auth,
        json={
            "active": 1,
            "username": "test@example.com",
            "script_desc": "x",
            "script_data": VALID_SCRIPT,
        },
    )
    assert r.status_code == 400
    assert "filter exists" in r.json()["msg"]


# -------- POST /v1/filters/edit -------- #


@respx.mock
def test_edit_filter_ok(client, basic_auth):
    # Сначала middleware вызовет list_filters для ownership-check
    respx.get("http://mailcow.test/api/v1/get/filters/test@example.com").mock(
        return_value=httpx.Response(
            200,
            json=[{"id": 5, "username": "test@example.com", "active": 1}],
        )
    )
    route = respx.post("http://mailcow.test/api/v1/edit/filter").mock(
        return_value=httpx.Response(200, json=[{"type": "success", "msg": "ok"}])
    )
    r = client.post(
        "/v1/filters/edit",
        headers=basic_auth,
        json={"items": [5], "attr": {"active": 0}},
    )
    assert r.status_code == 200, r.text
    sent = route.calls.last.request
    assert sent.headers.get("content-type", "").startswith("application/json")
    body = json.loads(sent.content.decode())
    # mailcow для edit при JSON ожидает {"items":[id], "attr":{...}}
    assert body == {"items": [5], "attr": {"active": 0}}


@respx.mock
def test_edit_filter_not_owned_403(client, basic_auth):
    # Юзер просит id=99, но в его filters такого нет
    respx.get("http://mailcow.test/api/v1/get/filters/test@example.com").mock(
        return_value=httpx.Response(200, json=[{"id": 5, "username": "test@example.com"}])
    )
    r = client.post(
        "/v1/filters/edit",
        headers=basic_auth,
        json={"items": [99], "attr": {"active": 0}},
    )
    assert r.status_code == 403


# -------- POST /v1/filters/delete -------- #


@respx.mock
def test_delete_filter_ok(client, basic_auth):
    respx.get("http://mailcow.test/api/v1/get/filters/test@example.com").mock(
        return_value=httpx.Response(200, json=[{"id": 5, "username": "test@example.com"}])
    )
    route = respx.post("http://mailcow.test/api/v1/delete/filter").mock(
        return_value=httpx.Response(200, json=[{"type": "success", "msg": "removed"}])
    )
    r = client.post("/v1/filters/delete", headers=basic_auth, json=[5])
    assert r.status_code == 200
    sent = route.calls.last.request
    assert sent.headers.get("content-type", "").startswith("application/json")
    # mailcow для delete при JSON ожидает body = массив [id]
    assert json.loads(sent.content.decode()) == [5]


@respx.mock
def test_delete_filter_not_owned_403(client, basic_auth):
    respx.get("http://mailcow.test/api/v1/get/filters/test@example.com").mock(
        return_value=httpx.Response(200, json=[{"id": 5, "username": "test@example.com"}])
    )
    r = client.post("/v1/filters/delete", headers=basic_auth, json=[99])
    assert r.status_code == 403


# -------- 404 / unknown paths -------- #


def test_unknown_path_returns_404(client, basic_auth):
    r = client.get("/v1/unknown/route", headers=basic_auth)
    assert r.status_code == 404


def test_get_method_not_allowed_on_post_endpoint(client, basic_auth):
    r = client.get("/v1/filters", headers=basic_auth)
    assert r.status_code in (404, 405)


# -------- Sieve validation на add -------- #


def test_add_filter_control_char_400(client, basic_auth):
    bad = "# expor-sieve v1 managed\nrequire \x00 evil;"
    r = client.post(
        "/v1/filters",
        headers=basic_auth,
        json={
            "active": 1,
            "username": "test@example.com",
            "script_desc": "x",
            "script_data": bad,
        },
    )
    assert r.status_code == 400


def test_add_filter_too_large_400(client, basic_auth):
    big = "# expor-sieve v1 managed\n" + "x" * 65_000
    r = client.post(
        "/v1/filters",
        headers=basic_auth,
        json={
            "active": 1,
            "username": "test@example.com",
            "script_desc": "x",
            "script_data": big,
        },
    )
    assert r.status_code == 400


# -------- CORS preflight -------- #


def test_cors_preflight(client):
    r = client.options(
        "/v1/auth/check",
        headers={
            "Origin": "moz-extension://abc",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    # FastAPI CORSMiddleware с allow_origins=* — отвечает на preflight
    assert r.status_code in (200, 204)
    assert "access-control-allow-origin" in {k.lower() for k in r.headers.keys()}


# -------- Request-ID -------- #


def test_request_id_echoed(client):
    r = client.get("/health", headers={"X-Request-ID": "trace-abc-123"})
    assert r.status_code == 200
    assert r.headers.get("x-request-id") == "trace-abc-123"


def test_request_id_generated_when_missing(client):
    r = client.get("/health")
    assert r.headers.get("x-request-id")
