"""HTTP-клиент к mailcow API (ТЗ §5.1.1, §10)."""

from __future__ import annotations

import json
from typing import Any

import httpx

from .config import Settings, get_settings
from .logging import get_logger

log = get_logger("upstream")


class UpstreamError(Exception):
    """Транспортная или семантическая ошибка от mailcow."""

    def __init__(self, status: int, msg: str, body: Any = None):
        super().__init__(f"upstream {status}: {msg}")
        self.status = status
        self.msg = msg
        self.body = body


def _interpret_body(body: Any) -> tuple[bool, str | None]:
    """Вернуть (ok, error_msg).

    mailcow всегда отвечает 200, в body — `{type:"success"|"error"|"danger", msg:...}`
    либо массив таких. См. ТЗ §10.
    """
    if body is None:
        return True, None
    if isinstance(body, list):
        for item in body:
            if isinstance(item, dict) and item.get("type") in ("error", "danger"):
                return False, _stringify(item.get("msg"))
        return True, None
    if isinstance(body, dict):
        if body.get("type") in ("error", "danger"):
            return False, _stringify(body.get("msg"))
    return True, None


def _stringify(msg: Any) -> str:
    if msg is None:
        return "unknown error"
    if isinstance(msg, str):
        return msg
    if isinstance(msg, list):
        return "; ".join(_stringify(x) for x in msg)
    try:
        return json.dumps(msg, ensure_ascii=False)
    except Exception:
        return str(msg)


class MailcowClient:
    """Тонкий async-клиент. Один инстанс на приложение, переиспользует connection pool."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.settings.mailcow_api_url.rstrip("/"),
                timeout=self.settings.request_timeout,
                verify=self.settings.mailcow_api_verify_tls,
                headers={"X-API-Key": self.settings.mailcow_api_key},
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ----------------------------- low-level ----------------------------- #

    async def _do(
        self,
        method: str,
        path: str,
        *,
        data: dict[str, Any] | None = None,
        json_body: Any = None,
    ) -> Any:
        try:
            client = await self._get_client()
            if method == "GET":
                resp = await client.get(path)
            elif method == "POST":
                if json_body is not None:
                    resp = await client.post(path, json=json_body)
                else:
                    resp = await client.post(path, data=data)
            else:
                raise UpstreamError(500, f"unsupported method {method}")
        except httpx.TimeoutException as e:
            log.error("upstream.timeout", path=path, err=str(e))
            raise UpstreamError(504, "upstream timeout") from e
        except httpx.RequestError as e:
            log.error("upstream.transport_error", path=path, err=str(e))
            raise UpstreamError(502, "upstream unavailable") from e
        except UpstreamError:
            raise
        except Exception as e:
            log.error("upstream.unexpected", path=path, err=str(e))
            raise UpstreamError(502, "upstream unavailable") from e

        # mailcow обычно отвечает 200 даже на ошибки.
        if resp.status_code >= 500:
            log.error("upstream.server_error", path=path, status=resp.status_code)
            raise UpstreamError(502, "upstream unavailable")
        if resp.status_code in (401, 403):
            log.error("upstream.auth_denied", path=path, status=resp.status_code)
            raise UpstreamError(502, "upstream auth denied (check IP-ACL)")
        if resp.status_code >= 400:
            log.error("upstream.client_error", path=path, status=resp.status_code)
            raise UpstreamError(502, f"upstream returned {resp.status_code}")

        try:
            body = resp.json()
        except Exception:
            body = resp.text or None

        ok, err = _interpret_body(body)
        if not ok:
            # семантическая ошибка от mailcow — наружу как 400
            raise UpstreamError(400, err or "mailcow returned error", body=body)
        return body

    # ----------------------------- public API ---------------------------- #

    async def get_mailbox(self, username: str) -> Any:
        return await self._do("GET", f"/api/v1/get/mailbox/{username}")

    async def list_filters(self, username: str) -> Any:
        return await self._do("GET", f"/api/v1/get/filters/{username}")

    async def add_filter(self, payload: dict[str, Any]) -> Any:
        # mailcow для add при Content-Type=application/json кладёт raw body
        # в $_POST['attr'] (см. json_api.php:80-82). Шлём JSON напрямую.
        body = dict(payload)
        if "active" in body:
            body["active"] = int(bool(int(body["active"])))
        return await self._do("POST", "/api/v1/add/filter", json_body=body)

    async def edit_filter(self, filter_id: int, attr: dict[str, Any]) -> Any:
        # mailcow для edit при JSON ожидает {"items":[id], "attr":{...}}
        # (json_api.php:85-88).
        attr_clean = {k: v for k, v in attr.items() if v is not None}
        if "active" in attr_clean:
            attr_clean["active"] = int(bool(int(attr_clean["active"])))
        body = {"items": [int(filter_id)], "attr": attr_clean}
        return await self._do("POST", "/api/v1/edit/filter", json_body=body)

    async def delete_filter(self, filter_id: int) -> Any:
        # mailcow для delete при JSON ожидает body = массив [id]
        # (json_api.php:90-93).
        return await self._do("POST", "/api/v1/delete/filter", json_body=[int(filter_id)])


# Глобальный синглтон
_default_client: MailcowClient | None = None


def get_mailcow_client() -> MailcowClient:
    global _default_client
    if _default_client is None:
        _default_client = MailcowClient()
    return _default_client


def reset_mailcow_client() -> None:
    global _default_client
    _default_client = None
