"""Аутентификация: IMAP bind + LRU кэш + per-user lockout (ТЗ §4)."""

from __future__ import annotations

import asyncio
import hashlib
import ssl
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field

import aioimaplib

from .config import Settings, get_settings
from .logging import get_logger

log = get_logger("auth")


# ---------------------------------------------------------------- #
#  IMAP bind
# ---------------------------------------------------------------- #


async def imap_bind(
    host: str,
    port: int,
    user: str,
    password: str,
    *,
    use_ssl: bool = True,
    timeout: float = 5.0,
) -> bool:
    """Проверка пары user/password через Dovecot IMAP LOGIN.

    True — успешный bind, False — любая ошибка (timeout, NO, BAD, network).
    Никогда не пробрасывает исключения наружу.
    """
    client: aioimaplib.IMAP4 | aioimaplib.IMAP4_SSL | None = None
    try:
        if use_ssl:
            ctx = ssl._create_unverified_context()
            client = aioimaplib.IMAP4_SSL(
                host=host, port=port, ssl_context=ctx, timeout=timeout
            )
        else:
            client = aioimaplib.IMAP4(host=host, port=port, timeout=timeout)

        await asyncio.wait_for(client.wait_hello_from_server(), timeout=timeout)
        resp = await asyncio.wait_for(client.login(user, password), timeout=timeout)
        ok = bool(resp and getattr(resp, "result", "").upper() == "OK")
        return ok
    except TimeoutError:
        log.warning("imap_bind.timeout", user=user, host=host)
        return False
    except Exception as e:
        log.warning("imap_bind.fail", user=user, host=host, err=str(e))
        return False
    finally:
        if client is not None:
            try:
                await asyncio.wait_for(client.logout(), timeout=2.0)
            except Exception:
                pass


# ---------------------------------------------------------------- #
#  In-memory LRU cache + bruteforce tracker
# ---------------------------------------------------------------- #


def _hash_password(password: str, pepper: str) -> str:
    digest = hashlib.sha256((password + pepper).encode("utf-8")).hexdigest()
    return digest[:16]


@dataclass
class _BruteState:
    failures: deque = field(default_factory=deque)  # timestamps
    locked_until: float = 0.0


class AuthService:
    """Кэш-обёртка над `imap_bind` + tracker неудач для lockout."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        # OrderedDict даёт нам LRU-семантику через move_to_end.
        self._cache: OrderedDict[tuple[str, str], float] = OrderedDict()
        self._brute: dict[str, _BruteState] = {}
        self._lock = asyncio.Lock()
        self._now = time.monotonic  # подменяемо в тестах

    # --- Публичные методы ------------------------------------------------

    async def authenticate(self, user: str, password: str) -> tuple[bool, float]:
        """Вернуть (ok, retry_after).

        retry_after > 0, если юзер залочен — middleware ответит 401 с подсказкой,
        когда снова можно пробовать.

        Поведение кэша:

        * Ключ кэша — `(user_lc, peppered_hash(password))`. Иной пароль того же
          юзера даёт иной ключ → промах → реальный bind в Dovecot. Это и есть
          неявный invalidation при смене пароля.
        * При успешном bind после миссы мы дополнительно очищаем все остальные
          (старые) записи этого юзера из кэша. Так старый пароль перестаёт
          работать СРАЗУ, не дожидаясь TTL. Без этого после ротации
          атакующий мог бы какое-то время спекулировать ещё-валидным cache-hit
          (TTL длиной до 60с — см. config.py).
        """
        if not user or not password:
            return False, 0.0

        user_key = user.lower().strip()

        # 1. Проверить lockout
        retry_after = self._check_lockout(user_key)
        if retry_after > 0:
            log.warning("auth.locked", user=user_key, retry_after=retry_after)
            return False, retry_after

        # 2. Проверить кэш
        cache_key = (user_key, _hash_password(password, self.settings.auth_pepper))
        if self._cache_get(cache_key):
            log.debug("auth.cache_hit", user=user_key)
            return True, 0.0

        # 3. Bind в Dovecot
        ok = await imap_bind(
            host=self.settings.dovecot_host,
            port=self.settings.dovecot_port,
            user=user,
            password=password,
            use_ssl=self.settings.dovecot_use_ssl,
            timeout=self.settings.dovecot_timeout,
        )

        if ok:
            # Eager invalidation: новый успешный пароль выселяет все
            # старые записи этого юзера, чтобы старый пароль не пережил
            # ротацию даже на оставшийся TTL.
            self._invalidate_other_entries(user_key, cache_key)
            self._cache_put(cache_key)
            self._reset_failures(user_key)
            log.info("auth.bind_ok", user=user_key)
            return True, 0.0

        # 4. Зарегистрировать неудачу
        self._record_failure(user_key)
        log.warning("auth.bind_fail", user=user_key)
        return False, 0.0

    def invalidate(self, user: str) -> None:
        """Удалить все кэш-записи юзера (например, на сигнал смены пароля)."""
        ukey = user.lower().strip()
        for key in list(self._cache.keys()):
            if key[0] == ukey:
                self._cache.pop(key, None)

    def _invalidate_other_entries(
        self, user_key: str, keep: tuple[str, str]
    ) -> None:
        """Стереть все кэш-записи `user_key`, кроме `keep`.

        Используется при успешном bind с новым паролем — старая (валидная по
        TTL) запись со старым паролем должна быть выкинута немедленно.
        """
        for key in list(self._cache.keys()):
            if key[0] == user_key and key != keep:
                self._cache.pop(key, None)

    # --- Внутренние методы кэша ------------------------------------------

    def _cache_get(self, key: tuple[str, str]) -> bool:
        ts = self._cache.get(key)
        if ts is None:
            return False
        if self._now() - ts > self.settings.auth_cache_ttl:
            self._cache.pop(key, None)
            return False
        # LRU: пометить как недавно использованный
        self._cache.move_to_end(key)
        return True

    def _cache_put(self, key: tuple[str, str]) -> None:
        self._cache[key] = self._now()
        self._cache.move_to_end(key)
        # Evict oldest, если превысили лимит
        while len(self._cache) > self.settings.auth_cache_max:
            self._cache.popitem(last=False)

    # --- Внутренние методы lockout ---------------------------------------

    def _check_lockout(self, user_key: str) -> float:
        st = self._brute.get(user_key)
        if not st:
            return 0.0
        now = self._now()
        if st.locked_until > now:
            return st.locked_until - now
        return 0.0

    def _record_failure(self, user_key: str) -> None:
        st = self._brute.setdefault(user_key, _BruteState())
        now = self._now()
        st.failures.append(now)
        # вычистить старые из окна
        window = self.settings.auth_bruteforce_window
        while st.failures and now - st.failures[0] > window:
            st.failures.popleft()
        if len(st.failures) >= self.settings.auth_bruteforce_threshold:
            st.locked_until = now + window
            log.warning(
                "auth.lockout_triggered",
                user=user_key,
                failures=len(st.failures),
                window=window,
            )

    def _reset_failures(self, user_key: str) -> None:
        self._brute.pop(user_key, None)


# Глобальный синглтон-инстанс (используется в FastAPI dependency)
_default_service: AuthService | None = None


def get_auth_service() -> AuthService:
    global _default_service
    if _default_service is None:
        _default_service = AuthService()
    return _default_service


def reset_auth_service() -> None:
    """Помощь тестам: пересоздать сервис с актуальными settings."""
    global _default_service
    _default_service = None
