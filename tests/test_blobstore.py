"""Tests for the blob store (local folder and Cloudflare R2).

Run: cd server && uv run --extra dev pytest ../tests/test_blobstore.py -q
Live R2 check: add KN_R2_LIVE=1 and the R2 env vars (see deploy/render/README.md).
"""

import os
import secrets

import pytest
from botocore.exceptions import ClientError
from db_test_support import run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


# ── LocalBlobStore ───────────────────────────────────────────────────────────


def test_local_put_then_get_round_trips(tmp_path):
    from src.blobstore import LocalBlobStore

    store = LocalBlobStore(tmp_path)

    async def scenario():
        await store.put("matches/m1/screenshots/0-10.jpg", b"\xff\xd8jpeg", "image/jpeg")
        return await store.get("matches/m1/screenshots/0-10.jpg")

    assert run_async(scenario()) == b"\xff\xd8jpeg"
    assert (tmp_path / "matches/m1/screenshots/0-10.jpg").read_bytes() == b"\xff\xd8jpeg"


def test_local_get_missing_returns_none(tmp_path):
    from src.blobstore import LocalBlobStore

    assert run_async(LocalBlobStore(tmp_path).get("matches/nope.jpg")) is None


def test_local_delete_removes_and_ignores_missing(tmp_path):
    from src.blobstore import LocalBlobStore

    store = LocalBlobStore(tmp_path)

    async def scenario():
        await store.put("a/1.jpg", b"1")
        await store.put("a/2.jpg", b"2")
        await store.delete(["a/1.jpg", "a/missing.jpg"])
        return await store.get("a/1.jpg"), await store.get("a/2.jpg")

    assert run_async(scenario()) == (None, b"2")


@pytest.mark.parametrize("key", ["", "/etc/passwd", "../escape.jpg", "a/../../escape.jpg", "a//b", "a/b c.jpg"])
def test_local_rejects_unsafe_keys(tmp_path, key):
    from src.blobstore import BlobStoreError, LocalBlobStore

    with pytest.raises(BlobStoreError):
        run_async(LocalBlobStore(tmp_path / "root").put(key, b"x"))
    assert not (tmp_path / "escape.jpg").exists()


# ── R2BlobStore (fake S3 client) ─────────────────────────────────────────────


class _Body:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data


class FakeS3:
    def __init__(self, fail_with=None):
        self.objects: dict[str, bytes] = {}
        self.calls: list[tuple[str, dict]] = []
        self.fail_with = fail_with

    def _maybe_fail(self, op):
        if self.fail_with:
            raise ClientError({"Error": {"Code": self.fail_with, "Message": "boom"}}, op)

    def put_object(self, **kw):
        self.calls.append(("put_object", kw))
        self._maybe_fail("PutObject")
        self.objects[kw["Key"]] = kw["Body"]

    def get_object(self, **kw):
        self.calls.append(("get_object", kw))
        self._maybe_fail("GetObject")
        if kw["Key"] not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "missing"}}, "GetObject")
        return {"Body": _Body(self.objects[kw["Key"]])}

    def delete_objects(self, **kw):
        self.calls.append(("delete_objects", kw))
        self._maybe_fail("DeleteObjects")
        for obj in kw["Delete"]["Objects"]:
            self.objects.pop(obj["Key"], None)
        return {}


def _r2(client):
    from src.blobstore import R2BlobStore

    return R2BlobStore("acct", "key-id", "secret", "bucket", client=client)


def test_r2_put_and_get_use_the_bucket():
    client = FakeS3()
    store = _r2(client)

    async def scenario():
        await store.put("matches/m/screenshots/0-1.jpg", b"img", "image/jpeg")
        return await store.get("matches/m/screenshots/0-1.jpg")

    assert run_async(scenario()) == b"img"
    assert client.calls[0] == (
        "put_object",
        {"Bucket": "bucket", "Key": "matches/m/screenshots/0-1.jpg", "Body": b"img", "ContentType": "image/jpeg"},
    )


def test_r2_get_missing_returns_none():
    assert run_async(_r2(FakeS3()).get("matches/none.jpg")) is None


def test_r2_errors_become_blobstore_error():
    from src.blobstore import BlobStoreError

    store = _r2(FakeS3(fail_with="AccessDenied"))
    with pytest.raises(BlobStoreError, match="AccessDenied"):
        run_async(store.put("matches/m/x.jpg", b"x"))
    with pytest.raises(BlobStoreError):
        run_async(store.get("matches/m/x.jpg"))


def test_r2_delete_batches_by_1000():
    client = FakeS3()
    keys = [f"matches/m/screenshots/0-{i}.jpg" for i in range(1500)]
    run_async(_r2(client).delete(keys))
    batches = [kw["Delete"]["Objects"] for op, kw in client.calls if op == "delete_objects"]
    assert [len(b) for b in batches] == [1000, 500]


def test_r2_rejects_unsafe_keys():
    from src.blobstore import BlobStoreError

    client = FakeS3()
    with pytest.raises(BlobStoreError):
        run_async(_r2(client).put("../x", b"x"))
    assert client.calls == []


# ── blobstore_from_env ───────────────────────────────────────────────────────


@pytest.fixture
def r2_env(monkeypatch):
    for name in ("CF_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_from_env_defaults_to_local(r2_env, tmp_path):
    from src.blobstore import LocalBlobStore, blobstore_from_env

    store = blobstore_from_env(tmp_path / "blobs")
    assert isinstance(store, LocalBlobStore)
    assert store.root == tmp_path / "blobs"


def test_from_env_selects_r2_when_configured(r2_env, tmp_path):
    from src.blobstore import R2BlobStore, blobstore_from_env

    r2_env.setenv("CF_ACCOUNT_ID", "acct")
    r2_env.setenv("R2_ACCESS_KEY_ID", "kid")
    r2_env.setenv("R2_SECRET_ACCESS_KEY", "secret")
    r2_env.setenv("R2_BUCKET", "bucket")
    assert isinstance(blobstore_from_env(tmp_path), R2BlobStore)


def test_from_env_rejects_partial_r2_config(r2_env, tmp_path):
    from src.blobstore import BlobStoreError, blobstore_from_env

    r2_env.setenv("R2_BUCKET", "bucket")
    with pytest.raises(BlobStoreError, match="CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY"):
        blobstore_from_env(tmp_path)


# ── Live R2 (opt-in) ─────────────────────────────────────────────────────────

_LIVE_R2 = os.environ.get("KN_R2_LIVE") == "1" and all(
    os.environ.get(n) for n in ("CF_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
)


@pytest.mark.skipif(not _LIVE_R2, reason="set KN_R2_LIVE=1 and the R2 env vars to run against real R2")
def test_live_r2_put_get_delete(tmp_path):
    """Checks the R2 token and bucket before cutover. Leaves nothing behind."""
    from src.blobstore import R2BlobStore, blobstore_from_env

    store = blobstore_from_env(tmp_path)
    assert isinstance(store, R2BlobStore)
    key = f"kn-live-test/{secrets.token_hex(6)}.bin"

    async def scenario():
        await store.put(key, b"\x00\x01live", "application/octet-stream")
        try:
            return await store.get(key)
        finally:
            await store.delete([key])
            assert await store.get(key) is None

    assert run_async(scenario()) == b"\x00\x01live"
