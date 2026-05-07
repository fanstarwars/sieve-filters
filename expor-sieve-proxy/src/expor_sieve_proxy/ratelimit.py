"""Per-IP token bucket rate-limiter (ТЗ §4.5)."""

from __future__ import annotations

import time
from dataclasses import dataclass

from .config import Settings, get_settings


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


class TokenBucketLimiter:
    """Простой in-memory token-bucket per ключ.

    rate = `per_min` запросов в минуту, capacity = `per_min` (burst <= rate).
    Ключ — обычно client IP. Очищаем «протухшие» бакеты лениво при превышении лимита.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._buckets: dict[str, _Bucket] = {}
        self._now = time.monotonic
        self.max_buckets = 10_000

    def _refill_rate(self) -> float:
        # tokens per second
        return self.settings.rate_limit_per_min / 60.0

    def _capacity(self) -> int:
        return self.settings.rate_limit_per_min

    def check(self, key: str) -> tuple[bool, float]:
        """Вернуть (allowed, retry_after_sec).

        retry_after — сек до момента, когда станет доступен 1 токен (если нет).
        """
        now = self._now()
        cap = self._capacity()
        rate = self._refill_rate()

        b = self._buckets.get(key)
        if b is None:
            if len(self._buckets) >= self.max_buckets:
                # eviction: выбросим случайный (простой подход для MVP)
                self._buckets.pop(next(iter(self._buckets)))
            b = _Bucket(tokens=cap, last_refill=now)
            self._buckets[key] = b

        # Refill
        elapsed = now - b.last_refill
        if elapsed > 0:
            b.tokens = min(cap, b.tokens + elapsed * rate)
            b.last_refill = now

        if b.tokens >= 1.0:
            b.tokens -= 1.0
            return True, 0.0

        # Сколько ждать до 1 токена
        deficit = 1.0 - b.tokens
        retry = deficit / rate if rate > 0 else float("inf")
        return False, retry


_default_limiter: TokenBucketLimiter | None = None


def get_rate_limiter() -> TokenBucketLimiter:
    global _default_limiter
    if _default_limiter is None:
        _default_limiter = TokenBucketLimiter()
    return _default_limiter


def reset_rate_limiter() -> None:
    global _default_limiter
    _default_limiter = None
