"""Cloudflare D1 backend over the HTTP query API.

POST https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query
with a Bearer token. Only the Worker binding's batch is documented as a
transaction, so callers must not rely on batch() being all-or-nothing here.
The token is sent in a header and never appears in error messages.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import httpx

from src.dbbackend.base import BackendError, ExecResult, Params, Statement

_API_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query"


def _encode_params(params: Params) -> list[Any]:
    encoded: list[Any] = []
    for value in params:
        if isinstance(value, bytes | bytearray | memoryview):
            raise TypeError("D1Backend cannot bind binary values; store blobs in the blob store")
        encoded.append(int(value) if isinstance(value, bool) else value)
    return encoded


def _exec_result(item: dict[str, Any]) -> ExecResult:
    meta = item.get("meta") or {}
    last_row_id = meta.get("last_row_id")
    return ExecResult(int(last_row_id) if last_row_id is not None else None, int(meta.get("changes") or 0))


class D1Backend:
    name = "d1"
    supports_blobs = False

    def __init__(
        self,
        account_id: str,
        database_id: str,
        api_token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 15.0,
    ) -> None:
        self._url = _API_URL.format(account=account_id, database=database_id)
        self._token = api_token
        self._transport = transport
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def open(self) -> None:
        self._client = httpx.AsyncClient(
            transport=self._transport,
            timeout=self._timeout,
            headers={"Authorization": f"Bearer {self._token}"},
        )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _post(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        if self._client is None:
            raise BackendError("D1 backend is not open")
        try:
            response = await self._client.post(self._url, json=body)
        except httpx.HTTPError as exc:
            raise BackendError(f"D1 request failed: {type(exc).__name__}: {exc}") from exc
        try:
            payload = response.json()
        except ValueError:
            raise BackendError(f"D1 returned HTTP {response.status_code} with a non-JSON body") from None
        if not isinstance(payload, dict):
            raise BackendError(f"D1 returned HTTP {response.status_code} with an unexpected body")
        if response.status_code != 200 or not payload.get("success"):
            errors = payload.get("errors") or []
            detail = "; ".join(str(e.get("message", e)) if isinstance(e, dict) else str(e) for e in errors)
            raise BackendError(f"D1 query failed (HTTP {response.status_code}): {detail or 'no error detail'}")
        result = payload.get("result")
        if not isinstance(result, list):
            raise BackendError("D1 response has no result list")
        return result

    async def query(self, sql: str, params: Params = ()) -> list[dict[str, Any]]:
        result = await self._post({"sql": sql, "params": _encode_params(params)})
        return [dict(row) for row in (result[0].get("results") or [])] if result else []

    async def execute(self, sql: str, params: Params = ()) -> ExecResult:
        result = await self._post({"sql": sql, "params": _encode_params(params)})
        return _exec_result(result[0] if result else {})

    async def batch(self, statements: Sequence[Statement]) -> list[ExecResult]:
        if not statements:
            return []
        body = {"batch": [{"sql": sql, "params": _encode_params(params)} for sql, params in statements]}
        return [_exec_result(item) for item in await self._post(body)]
