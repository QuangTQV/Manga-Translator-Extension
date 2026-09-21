"""Manual region tools — core/manual_region.py and the /region/* routes.
The ML/LLM calls are monkeypatched; cleaning and rendering are real."""
import base64
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import main
from core.manual_region import box_to_pixels, decode_image, encode_png, render_regions

client = TestClient(main.app, raise_server_exceptions=False)
FONT_DIR = "fonts/Roboto"
OPTS = {"provider": "Google", "input_language": "Japanese", "output_language": "English"}


def _page():
    im = Image.new("RGB", (400, 300), (255, 255, 255))
    ImageDraw.Draw(im).text((150, 100), "HELLO JP", fill=(0, 0, 0))
    return im


def _b64(im):
    return encode_png(im)


def test_box_to_pixels_clamps_orders_and_rejects_tiny_boxes():
    assert box_to_pixels((400, 300), (0.7, 0.5, 0.3, 0.25)) == (120, 75, 280, 150)  # corners given in reverse order
    assert box_to_pixels((400, 300), (0.0, 0.0, 1.0, 1.0)) == (0, 0, 400, 300)
    with pytest.raises(ValueError):
        box_to_pixels((400, 300), (0.5, 0.5, 0.501, 0.501))


def test_render_regions_only_touches_the_box():
    page = _page()
    out = render_regions(page, [((0.3, 0.25, 0.7, 0.5), "Translated")], FONT_DIR)
    before, after = np.array(page), np.array(out)
    assert out.size == page.size
    outside = np.ones(before.shape[:2], bool)
    outside[75:150, 120:280] = False
    assert (before[outside] == after[outside]).all()  # untouched outside the box
    assert (before[75:150, 120:280] != after[75:150, 120:280]).any()  # original ink gone / new text drawn


def test_empty_text_only_cleans_the_spot():
    out = np.array(render_regions(_page(), [((0.3, 0.25, 0.7, 0.5), "")], FONT_DIR))
    assert (out[75:150, 120:280] == 255).all()  # flat bubble-like background: fully erased, nothing drawn


def test_one_bad_region_does_not_lose_the_others():
    out = render_regions(_page(), [((0.3, 0.25, 0.7, 0.5), "ok"), ((0.0, 0.0, 0.5, 0.5), "x" * 10)], "does-not-exist")
    assert out.size == (400, 300)  # font failure is swallowed per region; cleaning still happened


def test_ocr_route_returns_the_recognised_text(monkeypatch):
    import endpoints.regions as regions

    seen = {}

    def fake_ocr(images, meta, debug=False):
        seen["crop_size"] = decode_image(images[0]).size
        return ["こんにちは"]

    monkeypatch.setattr(regions, "_perform_manga_ocr", fake_ocr)
    resp = client.post("/region/ocr", json={**OPTS, "ocr_method": "manga-ocr", "image": _b64(_page()), "box": {"x1": 0.3, "y1": 0.25, "x2": 0.7, "y2": 0.5}})
    assert resp.status_code == 200
    assert resp.json() == {"text": "こんにちは", "warning": None}
    assert seen["crop_size"][0] >= 160  # the boxed area (plus a little padding), not the whole page


def test_ocr_failure_becomes_an_empty_text_with_a_warning(monkeypatch):
    import endpoints.regions as regions

    monkeypatch.setattr(regions, "_perform_manga_ocr", lambda *a, **k: ["[OCR FAILED]"])
    resp = client.post("/region/ocr", json={**OPTS, "ocr_method": "manga-ocr", "image": _b64(_page()), "box": {"x1": 0.3, "y1": 0.25, "x2": 0.7, "y2": 0.5}})
    assert resp.json() == {"text": "", "warning": "ocr_failed"}


def test_ocr_route_rejects_a_tiny_box_and_out_of_range_coordinates():
    body = {**OPTS, "image": _b64(_page())}
    assert client.post("/region/ocr", json={**body, "box": {"x1": 0.5, "y1": 0.5, "x2": 0.501, "y2": 0.501}}).status_code == 400
    assert client.post("/region/ocr", json={**body, "box": {"x1": -1, "y1": 0, "x2": 2, "y2": 1}}).status_code == 422


def test_translate_route_cleans_the_reply_and_tells_the_model_the_language(monkeypatch):
    import endpoints.regions as regions

    captured = {}

    def fake_call(config, parts, prompt, debug=False, system_prompt=None, call_type="translate"):
        captured.update(prompt=prompt, call_type=call_type, parts=parts)
        return '"Hello there"'

    monkeypatch.setattr(regions, "_call_llm_endpoint", fake_call)
    resp = client.post("/region/translate", json={**OPTS, "text": "こんにちは"})
    assert resp.status_code == 200
    assert resp.json() == {"translation": "Hello there"}  # surrounding quotes stripped
    assert "into English" in captured["prompt"] and "こんにちは" in captured["prompt"]
    assert captured["call_type"] == "translate_region" and captured["parts"] == []


def test_translate_route_rejects_blank_text():
    assert client.post("/region/translate", json={**OPTS, "text": "   "}).status_code == 400


def test_render_route_returns_the_edited_page():
    page = _page()
    resp = client.post("/region/render", json={**OPTS, "image": _b64(page), "regions": [{"box": {"x1": 0.3, "y1": 0.25, "x2": 0.7, "y2": 0.5}, "text": "Hi"}]})
    assert resp.status_code == 200
    out = Image.open(io.BytesIO(base64.b64decode(resp.json()["image"])))
    assert out.size == page.size
    assert np.array(out).tobytes() != np.array(page).tobytes()


def test_render_route_limits_regions_per_page():
    region = {"box": {"x1": 0.1, "y1": 0.1, "x2": 0.5, "y2": 0.5}, "text": "x"}
    resp = client.post("/region/render", json={**OPTS, "image": _b64(_page()), "regions": [region] * 51})
    assert resp.status_code == 400
