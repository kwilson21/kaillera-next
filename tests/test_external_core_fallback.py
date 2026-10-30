"""Browser regression checks for missing local EmulatorJS cores."""

import os
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """These checks use a standalone page and don't need the server/browser fixtures."""
    yield


def test_missing_local_core_keeps_the_local_error_and_no_cdn_fallback():
    source = (ROOT / "web/static/ejs/emulator.min.js").read_text()

    assert "cdn.emulatorjs.org/${t}/data/${o}" not in source
    assert '"Error downloading core"' in source
    assert "if(-1===a)return void" in source
    assert source.index("if(-1===a)return void") < source.index('"Error downloading core"')


def test_mobile_streaming_core_choice_is_redirected_to_the_bundled_core():
    from playwright.sync_api import sync_playwright

    local_core_requests = []
    unexpected_cdn_requests = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("CHROMIUM_PATH"),
        )
        page = browser.new_page()

        def respond(route):
            url = route.request.url
            if url == "http://local.test/?mode=streaming":
                return route.fulfill(status=200, content_type="text/html", body="<html><body></body></html>")
            if url == "http://local.test/static/ejs/cores/mupen64plus_next-wasm.data":
                local_core_requests.append(url)
                return route.fulfill(status=404, body="missing local fixture")
            if "cdn.emulatorjs.org" in url and "parallel_n64" in url:
                unexpected_cdn_requests.append(url)
                return route.abort()
            return route.fulfill(status=404, body="not found")

        page.route("**/*", respond)
        page.goto("http://local.test/?mode=streaming")
        page.add_script_tag(path=str(ROOT / "web/static/core-redirector.js"))
        response = page.evaluate(
            "fetch('https://cdn.emulatorjs.org/latest/data/cores/parallel_n64-wasm.data')"
            ".then((response) => response.status)"
        )
        assert response == 404
        assert local_core_requests == ["http://local.test/static/ejs/cores/mupen64plus_next-wasm.data"]
        assert unexpected_cdn_requests == []
        browser.close()


def test_missing_local_emulator_core_returns_failure_without_external_retry():
    from playwright.sync_api import sync_playwright

    local_core_requests = []
    unexpected_cdn_requests = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("CHROMIUM_PATH"),
        )
        page = browser.new_page()

        def respond(route):
            url = route.request.url
            if url == "http://local.test/":
                return route.fulfill(status=200, content_type="text/html", body="<html><body></body></html>")
            if "/static/ejs/cores/parallel_n64-wasm.data" in url:
                local_core_requests.append(url)
                return route.fulfill(status=404, body="missing local fixture")
            if "cdn.emulatorjs.org" in url:
                unexpected_cdn_requests.append(url)
                return route.abort()
            return route.fulfill(status=404, body="not found")

        page.route("**/*", respond)
        page.goto("http://local.test/")
        page.add_script_tag(path=str(ROOT / "web/static/ejs/emulator.min.js"))
        result = page.evaluate(
            """async () => {
              const emulator = Object.create(window.EmulatorJS.prototype);
              emulator.config = { dataPath: '/static/ejs/' };
              emulator.toData = () => null;
              return emulator.downloadFile('cores/parallel_n64-wasm.data', null, false, {
                method: 'GET', responseType: 'arraybuffer'
              });
            }"""
        )
        assert result == -1
        assert len(local_core_requests) == 1
        assert unexpected_cdn_requests == []
        browser.close()
