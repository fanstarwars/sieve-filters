"""Конфигурация из env vars (см. ТЗ §6)."""

from __future__ import annotations

import secrets
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Все настройки middleware. Читаются из env (без файлов)."""

    # Mailcow upstream
    mailcow_api_url: str = Field(default="http://nginx", description="base URL mailcow API")
    mailcow_api_key: str = Field(default="", description="admin RW X-API-Key")
    mailcow_api_verify_tls: bool = Field(default=False)

    # Dovecot IMAP bind
    dovecot_host: str = Field(default="dovecot")
    dovecot_port: int = Field(default=993, ge=1, le=65535)
    dovecot_use_ssl: bool = Field(default=True)
    dovecot_timeout: float = Field(default=5.0, gt=0)

    # Auth cache.
    #
    # TTL=60s: trade-off между нагрузкой на dovecot и окном, в течение
    # которого старый пароль продолжает работать после смены. Меньше нельзя —
    # активный листинг правил при открытом UI плагина успевает делать ≈3
    # запроса в минуту. Больше нельзя — security-аудит требует, чтобы
    # ротация пароля давала эффект «почти сразу».
    auth_cache_ttl: int = Field(default=60, ge=1)
    auth_cache_max: int = Field(default=5000, ge=1)
    auth_pepper: str = Field(
        default_factory=lambda: secrets.token_hex(16),
        description="random pepper for hashing passwords in cache key (per-process)",
    )

    # Bruteforce protection
    auth_bruteforce_threshold: int = Field(default=10, ge=1)
    auth_bruteforce_window: int = Field(default=600, ge=1)

    # Per-IP rate limit
    rate_limit_per_min: int = Field(default=30, ge=1)

    # Fail2Ban federation. Mailcow netfilter container слушает Redis-канал
    # F2B_CHANNEL и парсит сообщения по regex (data/Dockerfiles/netfilter/main.py
    # f2bregex[1] = "mailcow UI: Invalid password for .+ by ([0-9a-f\\.:]+)").
    # Чтобы атакующий через middleware не оставался иммунным к F2B mailcow,
    # мы при провале аутентификации публикуем сообщение в этот канал.
    redis_url: str = Field(
        default="redis://redis:6379/0",
        description="Redis URL для F2B-публикаций. Внутри сети mailcow alias = redis.",
    )
    f2b_channel: str = Field(
        default="F2B_CHANNEL",
        description="Имя pub/sub канала для F2B-сообщений (mailcow netfilter подписан на F2B_CHANNEL).",
    )
    f2b_enabled: bool = Field(
        default=True,
        description="Глобальный rubilnik. Если false — publish_fail no-op (юнит-тесты, dev).",
    )

    # CORS
    allowed_origins: str = Field(default="*", description="comma-separated CORS origins")

    # HTTP
    request_timeout: float = Field(default=10.0, gt=0)
    listen_port: int = Field(default=8000, ge=1, le=65535)

    # Logging
    log_level: str = Field(default="INFO")

    model_config = SettingsConfigDict(env_prefix="", case_sensitive=False, extra="ignore")

    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Помощь тестам: сбросить кэш настроек после monkeypatch env."""
    get_settings.cache_clear()
