"""Тесты ownership-чеков (ТЗ §5.2)."""

from __future__ import annotations

import httpx
import respx

from expor_sieve_proxy.ownership import (
    filter_belongs_to_user,
    has_admin_login_marker,
    usernames_match,
)


def test_usernames_match_case_insensitive():
    assert usernames_match("Ivan@Expor.RU", "ivan@expor.ru")
    assert usernames_match("u@x.ru", "U@X.RU")
    assert not usernames_match("ivan@expor.ru", "petr@expor.ru")


def test_usernames_match_trim():
    assert usernames_match("  ivan@expor.ru  ", "ivan@expor.ru")


def test_usernames_match_empty():
    assert not usernames_match("", "x@y.ru")
    assert not usernames_match("x@y.ru", "")


def test_admin_marker_detected():
    assert has_admin_login_marker("admin*ivan@expor.ru")
    assert not has_admin_login_marker("ivan@expor.ru")
    assert not has_admin_login_marker("")


@respx.mock
async def test_filter_belongs_to_user_true(mailcow_client):
    respx.get("http://mailcow.test/api/v1/get/filters/u@x.ru").mock(
        return_value=httpx.Response(
            200, json=[{"id": 1, "username": "u@x.ru"}, {"id": 2, "username": "u@x.ru"}]
        )
    )
    assert await filter_belongs_to_user(mailcow_client, "u@x.ru", 2)


@respx.mock
async def test_filter_belongs_to_user_false(mailcow_client):
    respx.get("http://mailcow.test/api/v1/get/filters/u@x.ru").mock(
        return_value=httpx.Response(200, json=[{"id": 1, "username": "u@x.ru"}])
    )
    assert not await filter_belongs_to_user(mailcow_client, "u@x.ru", 2)


@respx.mock
async def test_filter_belongs_to_user_username_mismatch(mailcow_client):
    """Mailcow по ошибке вернул чужой filter с указанным id — мы фильтруем."""
    respx.get("http://mailcow.test/api/v1/get/filters/u@x.ru").mock(
        return_value=httpx.Response(200, json=[{"id": 5, "username": "other@x.ru"}])
    )
    assert not await filter_belongs_to_user(mailcow_client, "u@x.ru", 5)


@respx.mock
async def test_filter_belongs_fail_closed_on_upstream_error(mailcow_client):
    respx.get("http://mailcow.test/api/v1/get/filters/u@x.ru").mock(
        return_value=httpx.Response(500)
    )
    assert not await filter_belongs_to_user(mailcow_client, "u@x.ru", 5)


@respx.mock
async def test_filter_belongs_fail_closed_on_garbage_body(mailcow_client):
    respx.get("http://mailcow.test/api/v1/get/filters/u@x.ru").mock(
        return_value=httpx.Response(200, json={"unexpected": "shape"})
    )
    assert not await filter_belongs_to_user(mailcow_client, "u@x.ru", 5)
