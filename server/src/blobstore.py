"""Blob storage for binary objects too large or too binary for the database.

Screenshots today; session logs and Parquet archives later (see
docs/superpowers/specs/2026-09-25-offbox-log-storage-design.md). Keys look
like `matches/<match_id>/screenshots/<slot>-<frame>.jpg`, so everything for a
match sits under one prefix.

R2BlobStore talks to Cloudflare R2 through its S3-compatible API when the
R2 env vars are set; otherwise LocalBlobStore keeps files in a folder next to
the SQLite database (dev, tests, self-hosting).
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Protocol

from botocore.exceptions import BotoCoreError, ClientError

# Letters, digits, and . _ - in slash-separated segments; no empty, "." or ".." segment.
_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_R2_ENV = ("CF_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
_DELETE_BATCH = 1000  # S3 DeleteObjects limit


class BlobStoreError(RuntimeError):
    """A blob operation failed, or the key/configuration is invalid."""


def _check_key(key: str) -> str:
    segments = key.split("/")
    if not key or any(not _SEGMENT_RE.match(s) or s in (".", "..") for s in segments):
        raise BlobStoreError(f"Invalid blob key: {key!r}")
    return key


class BlobStore(Protocol):
    name: str

    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None: ...

    async def get(self, key: str) -> bytes | None: ...

    async def delete(self, keys: Sequence[str]) -> None: ...

    async def delete_prefix(self, prefix: str) -> None: ...


class LocalBlobStore:
    name = "local"

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        return self.root / _check_key(key)

    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        path = self._path(key)

        def write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, path)

        await asyncio.to_thread(write)

    async def get(self, key: str) -> bytes | None:
        path = self._path(key)

        def read() -> bytes | None:
            try:
                return path.read_bytes()
            except FileNotFoundError:
                return None

        return await asyncio.to_thread(read)

    async def delete(self, keys: Sequence[str]) -> None:
        paths = [self._path(k) for k in keys]

        def remove() -> None:
            for path in paths:
                path.unlink(missing_ok=True)

        await asyncio.to_thread(remove)

    async def delete_prefix(self, prefix: str) -> None:
        """Delete every blob under `prefix`, which names a folder ("matches/<id>/")."""
        folder = self._path(prefix.rstrip("/"))
        await asyncio.to_thread(shutil.rmtree, folder, True)


class R2BlobStore:
    name = "r2"

    def __init__(
        self,
        account_id: str,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
        *,
        client: Any | None = None,
    ) -> None:
        self._bucket = bucket
        if client is None:
            import boto3
            from botocore.config import Config

            client = boto3.client(
                "s3",
                endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
                aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key,
                region_name="auto",
                config=Config(connect_timeout=5, read_timeout=15, retries={"max_attempts": 3, "mode": "standard"}),
            )
        self._client = client

    async def _call(self, method: str, **kwargs: Any) -> Any:
        try:
            return await asyncio.to_thread(getattr(self._client, method), Bucket=self._bucket, **kwargs)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "unknown")
            raise BlobStoreError(f"R2 {method} failed: {code}") from exc
        except BotoCoreError as exc:
            raise BlobStoreError(f"R2 {method} failed: {type(exc).__name__}") from exc

    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        await self._call("put_object", Key=_check_key(key), Body=data, ContentType=content_type)

    async def get(self, key: str) -> bytes | None:
        try:
            response = await asyncio.to_thread(self._client.get_object, Bucket=self._bucket, Key=_check_key(key))
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "unknown")
            if code in ("NoSuchKey", "404"):
                return None
            raise BlobStoreError(f"R2 get_object failed: {code}") from exc
        except BotoCoreError as exc:
            raise BlobStoreError(f"R2 get_object failed: {type(exc).__name__}") from exc
        return await asyncio.to_thread(response["Body"].read)

    async def delete_prefix(self, prefix: str) -> None:
        """Delete every object whose key starts with `prefix` ("matches/<id>/")."""
        _check_key(prefix.rstrip("/"))
        keys: list[str] = []
        token: str | None = None
        while True:
            page = await self._call("list_objects_v2", Prefix=prefix, **({"ContinuationToken": token} if token else {}))
            keys.extend(obj["Key"] for obj in page.get("Contents", []))
            if not page.get("IsTruncated"):
                break
            token = page.get("NextContinuationToken")
        await self.delete(keys)

    async def delete(self, keys: Sequence[str]) -> None:
        checked = [_check_key(k) for k in keys]
        for start in range(0, len(checked), _DELETE_BATCH):
            batch = checked[start : start + _DELETE_BATCH]
            await self._call("delete_objects", Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True})


def blobstore_from_env(local_root: Path) -> BlobStore:
    """R2 when any R2 variable is set (a partial configuration is an error), else a local folder."""
    if any(os.environ.get(name) for name in _R2_ENV[1:]):
        values = {name: os.environ.get(name, "") for name in _R2_ENV}
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise BlobStoreError(f"R2 is partially configured; missing {', '.join(missing)}")
        return R2BlobStore(*values.values())
    return LocalBlobStore(local_root)
