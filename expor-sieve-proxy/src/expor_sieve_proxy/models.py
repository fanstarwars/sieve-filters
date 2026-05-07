"""Pydantic-модели запросов/ответов (ТЗ §5.1)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, EmailStr, Field, RootModel, field_validator

# Маркеры плагина — без одного из них sieve-script не принимаем (ТЗ §5.3).
# v1 — legacy single-rule format (один Rule == один mailcow filter).
# v2 — combined-script format (все правила в одном фильтре, см. TZ.md §8).
SIEVE_MARKER_V1 = "# expor-sieve v1 managed"
SIEVE_MARKER_V2 = "# expor-sieve v2 managed"
ALLOWED_MARKERS = (SIEVE_MARKER_V1, SIEVE_MARKER_V2)
# Backward-compat alias.
SIEVE_MARKER = SIEVE_MARKER_V1

# MySQL TEXT — 65535 байт; оставляем небольшой запас под служебные поля
# mailcow (script_desc и пр.). См. TZ.md §8 / init_db.inc.php.
MAX_SCRIPT_BYTES = 65_000
# Порог предупреждения в audit-log: чтобы вовремя заметить, что combined
# script подбирается к лимиту — пора просить юзера почистить правила.
SCRIPT_WARN_THRESHOLD = 55_000


def _validate_script(value: str) -> str:
    """Маркер + лимит размера + запрет управляющих символов кроме \\n,\\r,\\t."""
    if not value:
        raise ValueError("script_data is empty")
    # Размер в байтах (utf-8)
    if len(value.encode("utf-8")) > MAX_SCRIPT_BYTES:
        raise ValueError(f"script_data exceeds {MAX_SCRIPT_BYTES} bytes")
    # Маркер должен быть на первой строке (v1 ИЛИ v2)
    first_line = value.splitlines()[0] if value else ""
    if first_line.strip() not in ALLOWED_MARKERS:
        raise ValueError(
            "script_data must start with marker "
            f"'{SIEVE_MARKER_V1}' or '{SIEVE_MARKER_V2}' on the first line"
        )
    # Контроль-символы
    for ch in value:
        if ch in ("\n", "\r", "\t"):
            continue
        if ord(ch) < 0x20 or ord(ch) == 0x7F:
            raise ValueError("script_data contains forbidden control characters")
    return value


class AddFilterReq(BaseModel):
    active: int = Field(ge=0, le=1)
    username: EmailStr
    script_desc: str = Field(min_length=1, max_length=200)
    script_data: str = Field(min_length=1, max_length=MAX_SCRIPT_BYTES)
    filter_type: Literal["prefilter", "postfilter"] = "prefilter"

    @field_validator("script_data")
    @classmethod
    def _validate_script_field(cls, v: str) -> str:
        return _validate_script(v)


class EditAttrReq(BaseModel):
    active: int | None = Field(default=None, ge=0, le=1)
    script_desc: str | None = Field(default=None, min_length=1, max_length=200)
    script_data: str | None = Field(default=None, min_length=1, max_length=MAX_SCRIPT_BYTES)
    filter_type: Literal["prefilter", "postfilter"] | None = None
    # На редактировании upstream допускает смену username, но мы запрещаем —
    # ownership уже привязан к auth-юзеру. Поле не разрешаем.

    @field_validator("script_data")
    @classmethod
    def _validate_script_field(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _validate_script(v)


class EditFilterReq(BaseModel):
    items: list[int] = Field(min_length=1, max_length=1)
    attr: EditAttrReq


class DeleteFilterReq(RootModel[list[int]]):
    root: list[int] = Field(min_length=1, max_length=1)


# ---------------------------------------------------------------- #
#  Стандартные ответы
# ---------------------------------------------------------------- #


class ErrorResp(BaseModel):
    type: Literal["error"] = "error"
    msg: str
    retry_after: int | None = None


class SuccessResp(BaseModel):
    type: Literal["success"] = "success"
    msg: str | list | dict | None = None


class HealthResp(BaseModel):
    status: Literal["ok"] = "ok"
    version: str


class AuthCheckResp(BaseModel):
    ok: bool
    user: str
