"""core/pipeline.py: a region whose OCR/translation comes back invalid
(`[OCR FAILED]`, an API error, an empty response, ...) used to just be
skipped after its area had already been whited-out/inpainted during
cleaning — leaving a blank hole on the page instead of the untranslated
source text. `_restore_original_patch` pastes the pre-cleaning crop back
for exactly this case (and is reused by the pre-existing "every render
attempt failed" fallback, which had the same restore logic inline before).
"""
import base64
import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import core.pipeline as pipeline
import main

client = TestClient(main.app, raise_server_exceptions=False)
OPTS = {"provider": "Google", "input_language": "Japanese", "output_language": "English"}


def test_restore_original_patch_pastes_when_a_crop_is_given():
    canvas = Image.new("RGB", (40, 40), (255, 255, 255))
    patch = Image.new("RGB", (10, 10), (10, 20, 30))
    assert pipeline._restore_original_patch(canvas, patch, (5, 5, 15, 15)) is True
    assert canvas.getpixel((6, 6)) == (10, 20, 30)  # inside the pasted patch
    assert canvas.getpixel((0, 0)) == (255, 255, 255)  # untouched elsewhere


def test_restore_original_patch_is_a_no_op_without_a_crop():
    canvas = Image.new("RGB", (10, 10), (255, 255, 255))
    assert pipeline._restore_original_patch(canvas, None, (0, 0, 5, 5)) is False
    assert canvas.getpixel((0, 0)) == (255, 255, 255)


YOLO_DIR = Path(__file__).resolve().parents[1] / "models/yolo"


def _two_bubble_page() -> bytes:
    # Two ellipse "speech bubbles" (the same simple line-drawn style the
    # extension's own Playwright fixtures use, which the real bubble
    # detector does pick up — verified live, not assumed) far enough apart
    # that restoring one leaves the other provably untouched.
    img = Image.new("RGB", (600, 850), (229, 229, 234))
    d = ImageDraw.Draw(img)
    d.rectangle([20, 20, 580, 400], outline=(0, 0, 0), width=3)
    d.rectangle([20, 430, 580, 850], outline=(0, 0, 0), width=3)
    d.ellipse([60, 60, 260, 160], outline=(0, 0, 0), width=3)
    d.text((80, 105), "Test page 1", fill=(0, 0, 0))
    d.ellipse([340, 470, 540, 570], outline=(0, 0, 0), width=3)
    d.text((360, 515), "Test page 2", fill=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.skipif(not any(YOLO_DIR.glob("*.pt")), reason="needs the YOLO weights")
def test_invalid_translation_restores_original_pixels_instead_of_a_blank_hole(monkeypatch):
    page_bytes = _two_bubble_page()
    image_b64 = base64.b64encode(page_bytes).decode()

    def fake_batch_all_ok(config, images_b64, *args, **kwargs):
        return ["Hello!"] * len(images_b64)

    monkeypatch.setattr(pipeline, "call_translation_api_batch", fake_batch_all_ok)
    baseline = client.post("/translate", json={**OPTS, "api_key": "k", "image": image_b64})
    assert baseline.status_code == 200, baseline.text
    bubbles = baseline.json()["bubbles"]
    assert len(bubbles) == 2, "expected both drawn bubbles to be detected"
    target_bbox = bubbles[0]["bbox"]

    def fake_batch_first_fails(config, images_b64, *args, **kwargs):
        texts = ["Hello!"] * len(images_b64)
        texts[0] = "[OCR FAILED]"
        return texts

    monkeypatch.setattr(pipeline, "call_translation_api_batch", fake_batch_first_fails)
    resp = client.post("/translate", json={**OPTS, "api_key": "k", "image": image_b64})
    assert resp.status_code == 200, resp.text
    data = resp.json()

    # Same detection ran (cached on the identical image+params), so bbox[0]
    # is still the same bubble — but a failed bubble is never added to the
    # successful-bubbles list, and the other one still translated normally.
    assert not any(tuple(b["bbox"]) == tuple(target_bbox) for b in data["bubbles"])
    assert len(data["bubbles"]) == 1
    assert data["bubbles"][0]["translated_text"] == "Hello!"

    original = Image.open(io.BytesIO(page_bytes)).convert("RGB")
    result = Image.open(io.BytesIO(base64.b64decode(data["translated_image"]))).convert("RGB")
    x1, y1, x2, y2 = (int(round(v)) for v in target_bbox)
    original_crop = np.array(original.crop((x1, y1, x2, y2)))
    result_crop = np.array(result.crop((x1, y1, x2, y2)))
    # Restored to the real pre-cleaning pixels, not left blank/white.
    assert np.array_equal(original_crop, result_crop)
