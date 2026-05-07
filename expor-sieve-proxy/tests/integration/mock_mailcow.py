"""Минимальный fake-mailcow на FastAPI для dev-up и integration-тестов.

Воспроизводит 5 эндпоинтов с типичной семантикой (200 + JSON, type/msg для write).
"""

from __future__ import annotations

import argparse

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

API_KEY = "dev-rw-key"

# В памяти — простая БД фильтров.
_FILTERS: dict[int, dict] = {
    1: {
        "id": 1,
        "active": 1,
        "username": "test@example.com",
        "script_desc": "existing filter",
        "script_data": "# expor-sieve v1 managed\nrequire [\"fileinto\"];\n",
        "filter_type": "prefilter",
    },
    # Чужой фильтр — для проверки ownership delete-by-id
    99: {
        "id": 99,
        "active": 1,
        "username": "other@example.com",
        "script_desc": "not yours",
        "script_data": "# expor-sieve v1 managed\n",
        "filter_type": "prefilter",
    },
}
_NEXT_ID = 100


def _check_key(x_api_key: str | None) -> JSONResponse | None:
    if x_api_key != API_KEY:
        return JSONResponse(
            status_code=401,
            content={"type": "error", "msg": "api access denied for ip 127.0.0.1"},
        )
    return None


def create_app() -> FastAPI:
    app = FastAPI(title="mock-mailcow")

    @app.get("/api/v1/get/mailbox/{username}")
    async def get_mailbox(username: str, x_api_key: str | None = Header(default=None)):
        if (e := _check_key(x_api_key)):
            return e
        return [
            {
                "username": username,
                "active": 1,
                "quota": 1024 * 1024 * 100,
                "messages": 0,
            }
        ]

    @app.get("/api/v1/get/filters/{username}")
    async def get_filters(username: str, x_api_key: str | None = Header(default=None)):
        if (e := _check_key(x_api_key)):
            return e
        return [f for f in _FILTERS.values() if f["username"].lower() == username.lower()]

    @app.post("/api/v1/add/filter")
    async def add_filter(request: Request, x_api_key: str | None = Header(default=None)):
        if (e := _check_key(x_api_key)):
            return e
        # mailcow при Content-Type=application/json кладёт raw body в $_POST['attr'].
        body = await request.json()
        global _NEXT_ID
        new_id = _NEXT_ID
        _NEXT_ID += 1
        _FILTERS[new_id] = {
            "id": new_id,
            "active": int(body.get("active", 1)),
            "username": body.get("username", ""),
            "script_desc": body.get("script_desc", ""),
            "script_data": body.get("script_data", ""),
            "filter_type": body.get("filter_type", "prefilter"),
        }
        return [{"type": "success", "msg": ["filter_added", new_id]}]

    @app.post("/api/v1/edit/filter")
    async def edit_filter(request: Request, x_api_key: str | None = Header(default=None)):
        if (e := _check_key(x_api_key)):
            return e
        # mailcow для edit при JSON ожидает {"items":[id], "attr":{...}}.
        body = await request.json()
        ids = body.get("items", [])
        attr = body.get("attr", {})
        for fid in ids:
            if fid in _FILTERS:
                _FILTERS[fid].update(attr)
        return [{"type": "success", "msg": "filter_modified"}]

    @app.post("/api/v1/delete/filter")
    async def delete_filter(request: Request, x_api_key: str | None = Header(default=None)):
        if (e := _check_key(x_api_key)):
            return e
        # mailcow для delete при JSON ожидает body = массив [id].
        ids = await request.json()
        for fid in ids:
            _FILTERS.pop(fid, None)
        return [{"type": "success", "msg": "filter_removed"}]

    @app.get("/_reset")
    async def _reset():
        global _NEXT_ID
        _FILTERS.clear()
        _FILTERS.update(
            {
                1: {
                    "id": 1,
                    "active": 1,
                    "username": "test@example.com",
                    "script_desc": "existing filter",
                    "script_data": "# expor-sieve v1 managed\n",
                    "filter_type": "prefilter",
                },
                99: {
                    "id": 99,
                    "active": 1,
                    "username": "other@example.com",
                    "script_desc": "not yours",
                    "script_data": "# expor-sieve v1 managed\n",
                    "filter_type": "prefilter",
                },
            }
        )
        _NEXT_ID = 100
        return {"ok": True}

    return app


app = create_app()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9000)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
