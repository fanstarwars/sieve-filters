"""Federation провалов аутентификации в mailcow Fail2Ban.

Mailcow поднимает netfilter-контейнер (data/Dockerfiles/netfilter/main.py),
который подписан на Redis pub/sub-канал ``F2B_CHANNEL`` и матчит входящие
сообщения по фиксированному набору regex'ов. Среди них:

    f2bregex[1] = r'mailcow UI: Invalid password for .+ by ([0-9a-f\\.:]+)'

— ровно эту форму и использует наш middleware: «mailcow UI: Invalid password
for {USER} by {IP}». IP — это IP клиента (XFF/X-Real-IP/peer); регистрация
бана на стороне netfilter гарантирует, что атакующий, прошедший мимо nginx
к /sieve-proxy/, не остаётся иммунным к F2B mailcow.

Дизайн:

* connect-on-first-publish (lazy). На init только сохраняем URL — это даёт
  middleware подняться даже когда Redis ещё не доступен.
* publish — best-effort. Любая ошибка → warning-лог, ответ юзеру не
  блокируется.
* Singleton через FastAPI dependency (см. ``get_f2b_publisher``).
"""

from __future__ import annotations

import asyncio
from typing import Any

from .config import Settings, get_settings
from .logging import get_logger

log = get_logger("f2b")

# redis импортируется лениво — это позволяет юнит-тестам подменять модуль и
# не падает при импорте middleware на машине без redis-py (хотя deps его
# требуют, тестам он не нужен в memory-fake-сценариях).
try:  # pragma: no cover - тривиальный import-guard
    import redis.asyncio as aioredis  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    aioredis = None  # type: ignore[assignment]


class F2BPublisher:
    """Публикатор сообщений в F2B_CHANNEL.

    Один экземпляр на процесс (re-используется через FastAPI dependency).
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._client: Any | None = None
        self._lock = asyncio.Lock()
        # Failure-flag: после первой неудачи init'а — суммируем warnings,
        # чтобы не спамить лог по запросу.
        self._init_failed: bool = False

    # ------------------------------------------------------------------ #

    async def _get_client(self) -> Any | None:
        """Лениво создать redis.asyncio клиент. Возвращает None если нельзя."""
        if self._client is not None:
            return self._client
        if not self.settings.f2b_enabled:
            return None
        if aioredis is None:
            if not self._init_failed:
                log.warning("f2b.no_redis_module")
                self._init_failed = True
            return None
        async with self._lock:
            if self._client is not None:
                return self._client
            try:
                # docs: https://redis.readthedocs.io/en/stable/connections.html
                #   redis.asyncio.from_url возвращает Redis-клиент со всеми
                #   defaults (decode_responses=False; для publish нам всё
                #   равно — мы публикуем уже-encoded UTF-8 строки).
                client = aioredis.from_url(
                    self.settings.redis_url,
                    socket_connect_timeout=2.0,
                    socket_timeout=2.0,
                )
                self._client = client
                self._init_failed = False
                return client
            except Exception as e:
                if not self._init_failed:
                    log.warning(
                        "f2b.redis_connect_failed",
                        url=self.settings.redis_url,
                        err=str(e),
                    )
                    self._init_failed = True
                return None

    async def publish_fail(self, ip: str, user: str) -> bool:
        """Опубликовать факт провала auth для IP/user.

        Формат сообщения захардкожен под mailcow netfilter regex #1
        (mailcow UI: Invalid password for .+ by IP). Возвращает True если
        publish завершился успешно (best-effort: при любой ошибке — False
        и тихий warning).
        """
        if not self.settings.f2b_enabled:
            return False
        if not ip or ip == "unknown":
            # Без валидного IP F2B всё равно не сможет ничего сделать.
            return False

        client = await self._get_client()
        if client is None:
            return False

        # Формат: совпадает с f2bregex[1].
        # docs: https://github.com/mailcow/mailcow-dockerized/blob/master/data/Dockerfiles/netfilter/main.py
        message = f"mailcow UI: Invalid password for {user or '?'} by {ip}"
        try:
            await client.publish(self.settings.f2b_channel, message)
            log.info("f2b.published", ip=ip, user=user)
            return True
        except Exception as e:
            log.warning(
                "f2b.publish_failed",
                ip=ip,
                user=user,
                err=str(e),
            )
            return False

    async def aclose(self) -> None:
        if self._client is not None:
            try:
                # redis.asyncio.Redis.aclose в 5.x — корректное закрытие пула.
                close = getattr(self._client, "aclose", None) or getattr(
                    self._client, "close", None
                )
                if close is not None:
                    res = close()
                    if asyncio.iscoroutine(res):
                        await res
            except Exception:
                pass
            self._client = None


# ---------------------------------------------------------------- #
#  Singleton accessor (FastAPI dependency)
# ---------------------------------------------------------------- #


_default_publisher: F2BPublisher | None = None


def get_f2b_publisher() -> F2BPublisher:
    global _default_publisher
    if _default_publisher is None:
        _default_publisher = F2BPublisher()
    return _default_publisher


def reset_f2b_publisher() -> None:
    """Помощь тестам: пересоздать publisher с актуальными settings."""
    global _default_publisher
    _default_publisher = None
