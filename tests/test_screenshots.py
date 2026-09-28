"""Screenshots: bytes live in the blob store, rows hold the key and size.

Run: cd server && uv run --extra dev pytest ../tests/test_screenshots.py -q
"""

import base64

import pytest
from db_test_support import FAKE_TOKEN, FakeD1, run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


JPEG = b"\xff\xd8fake-jpeg-bytes"


async def _open(tmp_path, *, d1=False, blobs=None):
    import src.db as db
    from src.blobstore import LocalBlobStore
    from src.dbbackend.d1 import D1Backend

    backend = D1Backend("acct", "db", FAKE_TOKEN, transport=FakeD1().transport()) if d1 else None
    await db.init_db(
        None if d1 else str(tmp_path / "kn.db"),
        backend=backend,
        blobs=blobs or LocalBlobStore(tmp_path / "blobs"),
    )
    return db


@pytest.mark.parametrize("d1", [False, True], ids=["sqlite", "d1"])
def test_insert_stores_bytes_in_blob_store_and_key_in_row(tmp_path, d1):
    async def scenario():
        db = await _open(tmp_path, d1=d1)
        try:
            row_id = await db.insert_screenshot("m1", 0, 300, JPEG)
            rows = await db.query("SELECT blob_key, size, data FROM screenshots WHERE id = ?", (row_id,))
            listing = await db.get_screenshots("m1")
            data = await db.get_screenshot_data(row_id)
            return rows, listing, data
        finally:
            await db.close_db()

    rows, listing, data = run_async(scenario())
    assert rows == [{"blob_key": "matches/m1/screenshots/0-300.jpg", "size": len(JPEG), "data": None}]
    assert [(s["slot"], s["frame"], s["size"]) for s in listing] == [(0, 300, len(JPEG))]
    assert data == JPEG
    assert (tmp_path / "blobs/matches/m1/screenshots/0-300.jpg").read_bytes() == JPEG


@pytest.mark.parametrize(("slot", "frame"), [("../x", 300), (0, "12/../../x"), (None, 300), (0, None)])
def test_insert_rejects_non_integer_slot_or_frame(tmp_path, slot, frame):
    async def scenario():
        db = await _open(tmp_path)
        try:
            row_id = await db.insert_screenshot("m1", slot, frame, JPEG)
            rows = await db.query("SELECT COUNT(*) AS n FROM screenshots", ())
            return row_id, rows[0]["n"]
        finally:
            await db.close_db()

    assert run_async(scenario()) == (None, 0)
    assert not (tmp_path / "blobs").exists()


def test_insert_skips_row_when_blob_upload_fails(tmp_path):
    from src.blobstore import BlobStoreError

    class FailingStore:
        name = "failing"

        async def put(self, key, data, content_type="application/octet-stream"):
            raise BlobStoreError("R2 put_object failed: AccessDenied")

        async def get(self, key):
            return None

        async def delete(self, keys):
            return None

    async def scenario():
        db = await _open(tmp_path, blobs=FailingStore())
        try:
            row_id = await db.insert_screenshot("m1", 0, 300, JPEG)
            rows = await db.query("SELECT COUNT(*) AS n FROM screenshots", ())
            return row_id, rows[0]["n"]
        finally:
            await db.close_db()

    assert run_async(scenario()) == (None, 0)


def test_legacy_row_with_bytes_in_database_is_still_readable(tmp_path):
    async def scenario():
        db = await _open(tmp_path)
        try:
            await db.execute_write(
                "INSERT INTO screenshots (match_id, slot, frame, data) VALUES (?, ?, ?, ?)", ("m-old", 1, 60, JPEG)
            )
            listing = await db.get_screenshots("m-old")
            return listing, await db.get_screenshot_data(listing[0]["id"])
        finally:
            await db.close_db()

    listing, data = run_async(scenario())
    assert listing[0]["size"] == len(JPEG)
    assert data == JPEG


def test_desync_vision_loads_screenshots_from_blob_store(tmp_path):
    from src.api import desync_vision

    async def scenario():
        db = await _open(tmp_path)
        try:
            await db.insert_screenshot("m1", 0, 300, JPEG)
            await db.insert_screenshot("m1", 1, 301, JPEG + b"-p2")
            return await desync_vision._load_screenshots("m1", 300)
        finally:
            await db.close_db()

    shots = run_async(scenario())
    assert [(s.slot, base64.b64decode(s.png_b64)) for s in shots] == [(0, JPEG), (1, JPEG + b"-p2")]
