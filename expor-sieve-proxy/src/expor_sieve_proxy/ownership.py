"""Проверка владельца ресурсов (ТЗ §5.2)."""

from __future__ import annotations

from typing import Any

from .upstream import MailcowClient, UpstreamError


def usernames_match(auth_user: str, body_user: str) -> bool:
    """Case-insensitive equality + базовый sanitize.

    Также защищаем от ALLOW_ADMIN_EMAIL_LOGIN-кейса (юзер логинится как
    `admin*user@example.com`): любая `*` в auth_user не подменяется на body_user.
    Сравнение строгое.
    """
    if not auth_user or not body_user:
        return False
    return auth_user.lower().strip() == body_user.lower().strip()


def has_admin_login_marker(auth_user: str) -> bool:
    """ALLOW_ADMIN_EMAIL_LOGIN использует `*` как разделитель admin*mailbox.

    Если такой логин прилетел — это не сам мейлбокс, а mailcow-admin
    залогинился как юзер. Мы это разрешаем, но логируем warning в audit (ТЗ §8).
    """
    return "*" in (auth_user or "")


async def filter_belongs_to_user(
    client: MailcowClient, auth_user: str, filter_id: int
) -> bool:
    """Проверить, что filter_id числится среди фильтров auth_user'а.

    Используется для delete-by-id, где в body нет username.
    """
    try:
        body: Any = await client.list_filters(auth_user)
    except UpstreamError:
        # Fail-closed: если не можем проверить — значит нельзя.
        return False

    if not isinstance(body, list):
        return False

    target = int(filter_id)
    for item in body:
        if not isinstance(item, dict):
            continue
        try:
            item_id = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        if item_id != target:
            continue
        # Подстраховка: даже если mailcow вернул чужой по ошибке,
        # сверим username в самом item, если он есть.
        item_user = item.get("username") or auth_user
        if usernames_match(auth_user, str(item_user)):
            return True
        return False
    return False
