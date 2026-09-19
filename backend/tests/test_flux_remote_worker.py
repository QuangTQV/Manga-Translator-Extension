"""core/image/inpainting.py:FluxKleinInpainter's remote-worker support
(remote_base_url) and backend/flux_worker.py — running Flux inpainting on
a remote GPU (e.g. a Kaggle notebook tunneled via cloudflared) instead of
loading weights locally. Pure logic + mocked HTTP — no real GPU/model
weights needed.
"""
import base64
import io

import pytest
from PIL import Image

from core.image.inpainting import FluxKleinInpainter


def _fake_png_bytes(size=(32, 32), color=(255, 0, 0)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _fake_png_b64(size=(32, 32), color=(255, 0, 0)) -> str:
    return base64.b64encode(_fake_png_bytes(size, color)).decode("ascii")


class _FakeResponse:
    def __init__(self, status_code=200, json_body=None):
        self.status_code = status_code
        self._json_body = json_body or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._json_body


# ---------------------------------------------------------------------------
# load_models() is a no-op when remote_base_url is set
# ---------------------------------------------------------------------------
def test_load_models_is_a_noop_when_remote_base_url_is_set(monkeypatch):
    def _boom(*a, **k):
        raise AssertionError("local model load should never happen in remote mode")

    monkeypatch.setattr("core.ml.model_manager.ModelManager.load_flux_klein_4b", _boom)

    inpainter = FluxKleinInpainter(variant="4b", remote_base_url="http://example.com")
    inpainter.load_models()  # must not raise
    assert inpainter.pipeline is None


def test_local_mode_still_calls_load_flux_klein_4b(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "core.ml.model_manager.ModelManager.load_flux_klein_4b",
        lambda self, low_vram=False, verbose=False: calls.append(1) or "fake-pipeline",
    )
    inpainter = FluxKleinInpainter(variant="4b")  # no remote_base_url
    inpainter.load_models()
    assert calls == [1]
    assert inpainter.pipeline == "fake-pipeline"


# ---------------------------------------------------------------------------
# remote_base_url trailing-slash normalization
# ---------------------------------------------------------------------------
def test_remote_base_url_trailing_slash_is_stripped():
    inpainter = FluxKleinInpainter(remote_base_url="http://example.com/")
    assert inpainter.remote_base_url == "http://example.com"


def test_remote_base_url_none_stays_none():
    inpainter = FluxKleinInpainter(remote_base_url=None)
    assert inpainter.remote_base_url is None


# ---------------------------------------------------------------------------
# _run_remote_inference
# ---------------------------------------------------------------------------
def test_run_remote_inference_sends_the_expected_payload_and_decodes_the_result(monkeypatch):
    captured = {}

    def fake_post(url, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["timeout"] = timeout
        return _FakeResponse(200, {"image_base64": _fake_png_b64((16, 20))})

    monkeypatch.setattr("requests.post", fake_post)

    inpainter = FluxKleinInpainter(
        variant="4b", num_inference_steps=6, remote_base_url="http://example.com:8189",
        remote_timeout_seconds=42.0,
    )
    image = Image.new("RGB", (16, 20), (0, 255, 0))
    result = inpainter._run_remote_inference(image, 16, 20, seed=7)

    assert result is not None
    assert result.size == (16, 20)
    assert captured["url"] == "http://example.com:8189/inpaint"
    assert captured["timeout"] == 42.0
    payload = captured["json"]
    assert payload["width"] == 16
    assert payload["height"] == 20
    assert payload["seed"] == 7
    assert payload["num_inference_steps"] == 6
    assert payload["variant"] == "4b"
    # The image bytes sent are a real PNG re-encoding of the input, not the
    # raw pixel buffer — decodable back into an image of the same size.
    sent_image = Image.open(io.BytesIO(base64.b64decode(payload["image_base64"])))
    assert sent_image.size == (16, 20)


def test_run_remote_inference_returns_none_on_connection_error(monkeypatch):
    def fake_post(*a, **k):
        raise ConnectionError("Kaggle session restarted, tunnel URL is dead")

    monkeypatch.setattr("requests.post", fake_post)
    inpainter = FluxKleinInpainter(remote_base_url="http://dead-tunnel.example.com")
    result = inpainter._run_remote_inference(Image.new("RGB", (8, 8)), 8, 8, seed=1)
    assert result is None


def test_run_remote_inference_returns_none_on_timeout(monkeypatch):
    def fake_post(*a, **k):
        raise TimeoutError("worker took too long")

    monkeypatch.setattr("requests.post", fake_post)
    inpainter = FluxKleinInpainter(remote_base_url="http://slow.example.com")
    result = inpainter._run_remote_inference(Image.new("RGB", (8, 8)), 8, 8, seed=1)
    assert result is None


def test_run_remote_inference_returns_none_on_non_200(monkeypatch):
    monkeypatch.setattr("requests.post", lambda *a, **k: _FakeResponse(503, {}))
    inpainter = FluxKleinInpainter(remote_base_url="http://example.com")
    result = inpainter._run_remote_inference(Image.new("RGB", (8, 8)), 8, 8, seed=1)
    assert result is None


def test_run_remote_inference_returns_none_on_malformed_response_body(monkeypatch):
    # Missing "image_base64" key entirely.
    monkeypatch.setattr("requests.post", lambda *a, **k: _FakeResponse(200, {}))
    inpainter = FluxKleinInpainter(remote_base_url="http://example.com")
    result = inpainter._run_remote_inference(Image.new("RGB", (8, 8)), 8, 8, seed=1)
    assert result is None


# ---------------------------------------------------------------------------
# inpaint_mask() end-to-end with a mocked remote worker
# ---------------------------------------------------------------------------
def test_inpaint_mask_uses_remote_inference_when_configured(monkeypatch):
    import numpy as np

    def fake_post(url, json=None, timeout=None):
        # Echo back a same-size image so the composite step has something
        # valid to work with.
        w, h = json["width"], json["height"]
        return _FakeResponse(200, {"image_base64": _fake_png_b64((w, h), (0, 0, 255))})

    monkeypatch.setattr("requests.post", fake_post)

    def _boom_local_load(*a, **k):
        raise AssertionError("local Flux load should never happen in remote mode")

    monkeypatch.setattr("core.ml.model_manager.ModelManager.load_flux_klein_4b", _boom_local_load)

    inpainter = FluxKleinInpainter(variant="4b", remote_base_url="http://example.com")
    monkeypatch.setattr(inpainter.cache, "should_use_inpaint_cache", lambda seed: False)
    image = Image.new("RGB", (256, 256), (255, 255, 255))
    mask = np.zeros((256, 256), dtype=bool)
    mask[100:140, 100:180] = True

    result = inpainter.inpaint_mask(image, mask, seed=1)

    assert result is not None
    assert result.size == image.size


def test_inpaint_mask_leaves_image_untouched_when_remote_fails(monkeypatch):
    import numpy as np

    monkeypatch.setattr("requests.post", lambda *a, **k: (_ for _ in ()).throw(ConnectionError("down")))
    inpainter = FluxKleinInpainter(variant="4b", remote_base_url="http://dead.example.com")
    # Isolate from the real on-disk inpaint-result cache — the previous
    # test uses an identically-shaped white image/mask/seed, and a cache
    # hit here would let this test "pass" by skipping remote inference
    # entirely instead of actually exercising the failure path.
    monkeypatch.setattr(inpainter.cache, "should_use_inpaint_cache", lambda seed: False)
    image = Image.new("RGB", (256, 256), (255, 255, 255))
    mask = np.zeros((256, 256), dtype=bool)
    mask[100:140, 100:180] = True

    result = inpainter.inpaint_mask(image, mask, seed=1)

    # Graceful skip: original image returned unchanged, not an exception.
    assert result.size == image.size
    assert result.tobytes() == image.tobytes()


# ---------------------------------------------------------------------------
# flux_worker.py — the standalone FastAPI app meant to run on the remote
# GPU. _run_local_inference is mocked out so this needs no real weights.
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _reset_worker_inpainter_cache():
    import flux_worker

    flux_worker._inpainters.clear()
    yield
    flux_worker._inpainters.clear()


def test_worker_health_reports_ok_and_no_variants_loaded_yet():
    from fastapi.testclient import TestClient

    import flux_worker

    client = TestClient(flux_worker.app)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["loaded_variants"] == []


def test_worker_inpaint_round_trips_through_the_real_http_layer(monkeypatch):
    from fastapi.testclient import TestClient

    import flux_worker

    def fake_run_local_inference(self, image, width, height, seed, verbose=False):
        return Image.new("RGB", (width, height), (10, 20, 30))

    monkeypatch.setattr(FluxKleinInpainter, "load_models", lambda self: None)
    monkeypatch.setattr(FluxKleinInpainter, "_run_local_inference", fake_run_local_inference)

    client = TestClient(flux_worker.app)
    resp = client.post("/inpaint", json={
        "image_base64": _fake_png_b64((12, 10)),
        "width": 12, "height": 10, "seed": 3, "num_inference_steps": 4, "variant": "4b",
    })
    assert resp.status_code == 200
    result_b64 = resp.json()["image_base64"]
    result_image = Image.open(io.BytesIO(base64.b64decode(result_b64)))
    assert result_image.size == (12, 10)

    health = client.get("/health").json()
    assert health["loaded_variants"] == ["4b"]


def test_worker_inpaint_rejects_invalid_base64():
    from fastapi.testclient import TestClient

    import flux_worker

    client = TestClient(flux_worker.app)
    resp = client.post("/inpaint", json={
        "image_base64": "not-valid-base64!!!",
        "width": 8, "height": 8,
    })
    assert resp.status_code == 400


def test_worker_inpaint_returns_503_when_inference_unavailable(monkeypatch):
    from fastapi.testclient import TestClient

    import flux_worker

    monkeypatch.setattr(FluxKleinInpainter, "load_models", lambda self: None)
    monkeypatch.setattr(FluxKleinInpainter, "_run_local_inference", lambda self, *a, **k: None)

    client = TestClient(flux_worker.app)
    resp = client.post("/inpaint", json={
        "image_base64": _fake_png_b64((8, 8)),
        "width": 8, "height": 8,
    })
    assert resp.status_code == 503
