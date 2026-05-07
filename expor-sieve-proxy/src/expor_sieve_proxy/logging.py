"""structlog setup с маскировкой секретов (ТЗ §9)."""

from __future__ import annotations

import logging
import re
import sys
from typing import Any

import structlog

# Поля, которые нельзя писать в лог (значения заменяем на ***).
SECRET_KEYS = frozenset({"password", "passwd", "apikey", "api_key", "authorization", "x-api-key"})

_AUTH_HEADER_RE = re.compile(r"(?i)(basic|bearer)\s+\S+")


def _redact(value: Any) -> Any:
    if isinstance(value, str):
        return _AUTH_HEADER_RE.sub(r"\1 ***", value)
    return value


def _redact_processor(logger, method_name, event_dict: dict[str, Any]) -> dict[str, Any]:
    for key in list(event_dict.keys()):
        if key.lower() in SECRET_KEYS:
            event_dict[key] = "***"
        else:
            event_dict[key] = _redact(event_dict[key])
    return event_dict


def configure_logging(level: str = "INFO") -> None:
    log_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=log_level,
        force=True,
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _redact_processor,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
