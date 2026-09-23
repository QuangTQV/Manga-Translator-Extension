"""The static companion web app (backend/webapp/index.html), mounted at /app
for translating raw image files directly without the browser extension. See
that file's own header comment for the feature's rationale."""
from fastapi.testclient import TestClient

import main

client = TestClient(main.app, raise_server_exceptions=False)


def test_webapp_is_served_at_slash_app():
    resp = client.get("/app/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    assert "MangaTranslator" in resp.text


def test_webapp_bare_path_redirects_or_serves_index():
    # StaticFiles(html=True) resolves "/app" (no trailing slash) to index.html
    # too — either directly or via a redirect to "/app/".
    resp = client.get("/app", follow_redirects=True)
    assert resp.status_code == 200
    assert "MangaTranslator" in resp.text


def test_vendored_jszip_is_served():
    resp = client.get("/app/vendor/jszip.min.js")
    assert resp.status_code == 200
    assert "javascript" in resp.headers["content-type"]


def test_root_points_at_the_webapp():
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json()["webapp"] == "/app"


def test_webapp_mount_does_not_shadow_the_api_routes():
    assert client.get("/health").status_code == 200
    assert client.get("/providers").status_code == 200
    assert client.get("/fonts").status_code == 200
