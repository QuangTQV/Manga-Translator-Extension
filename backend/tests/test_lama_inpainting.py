"""LaMa inpainting (core/image/lama_inpainter.py) and its use by the manual
tools (core/manual_region.py, /region/erase, /region/render).

Most tests stub the model out (no 200MB download needed). The last one runs
the real model if it's already in backend/models/lama/ and is skipped
otherwise: it checks LaMa reconstructs a hatched background measurably
better than OpenCV, the reason the option exists.
"""
import base64
import io

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import core.image.lama_inpainter as lama_mod
import core.manual_region as manual_region
import main
from core.image.lama_inpainter import LamaInpainter, lama_inpaint_rgb

client = TestClient(main.app, raise_server_exceptions=False)


def _fake_model(seen):
    def run(img, mask, device, verbose):
        seen.append(img.shape)
        assert img.shape[0] % 8 == 0 and img.shape[1] % 8 == 0
        return np.full_like(img, 7)
    return run


def test_only_masked_pixels_change(monkeypatch):
    seen = []
    monkeypatch.setattr(lama_mod, "_run_model", _fake_model(seen))
    rgb = np.random.default_rng(0).integers(0, 255, (300, 200, 3), dtype=np.uint8)
    mask = np.zeros((300, 200), bool)
    mask[100:130, 50:90] = True
    out = lama_inpaint_rgb(rgb, mask)
    assert (out[mask] == 7).all()
    assert (out[~mask] == rgb[~mask]).all()
    # Worked on a crop around the mask (with context), not the whole page.
    assert seen[0][0] < 300 or seen[0][1] < 200


def test_empty_mask_is_a_no_op(monkeypatch):
    monkeypatch.setattr(lama_mod, "_run_model", lambda *a: pytest.fail("model must not run"))
    rgb = np.zeros((20, 20, 3), np.uint8)
    assert (lama_inpaint_rgb(rgb, np.zeros((20, 20), bool)) == rgb).all()


def test_large_crops_are_downscaled_for_inference(monkeypatch):
    seen = []
    monkeypatch.setattr(lama_mod, "_run_model", _fake_model(seen))
    rgb = np.zeros((400, 4000, 3), np.uint8)
    mask = np.zeros((400, 4000), bool)
    mask[150:250, 100:3900] = True
    out = lama_inpaint_rgb(rgb, mask)
    assert max(seen[0][:2]) <= 1536 + 8
    assert (out[mask] == 7).all() and (out[~mask] == 0).all()


def test_inpaint_mask_respects_the_composite_clip_bbox(monkeypatch):
    monkeypatch.setattr(lama_mod, "_run_model", _fake_model([]))
    monkeypatch.setattr(lama_mod.ModelManager, "load_lama", lambda self, *a, **k: None)
    image = Image.new("RGB", (100, 100), (200, 200, 200))
    mask = np.zeros((100, 100), bool)
    mask[10:90, 10:90] = True
    out = np.array(LamaInpainter().inpaint_mask(image, mask, composite_clip_bbox=(10, 10, 50, 50)))
    assert (out[20, 20] == 7).all()          # inside the clip box: inpainted
    assert (out[70, 70] == 200).all()        # masked but outside the clip box: untouched


def test_erase_mask_uses_lama_when_asked_and_falls_back_to_opencv(monkeypatch):
    image = Image.new("RGB", (60, 60), (255, 255, 255))
    mask = Image.new("L", (60, 60), 0)
    mask.paste(255, (20, 20, 40, 40))

    monkeypatch.setattr(manual_region, "_lama_inpaint", lambda rgb, m: np.full_like(rgb, 7))
    assert np.array(manual_region.erase_mask(image, mask, use_lama=True))[30, 30].tolist() == [7, 7, 7]

    def boom(rgb, m):
        raise RuntimeError("no model")
    monkeypatch.setattr(manual_region, "_lama_inpaint", boom)
    # Falls back to OpenCV: a white image stays white, no exception.
    assert np.array(manual_region.erase_mask(image, mask, use_lama=True))[30, 30].tolist() == [255, 255, 255]


def test_clean_region_uses_lama_on_busy_backgrounds_only(monkeypatch):
    calls = []
    monkeypatch.setattr(manual_region, "_lama_inpaint", lambda rgb, m: (calls.append(1), np.full_like(rgb, 7))[1])
    flat = np.full((80, 80, 3), 255, np.uint8)
    manual_region.clean_region(flat, (20, 20, 60, 60), use_lama=True)
    assert calls == []  # flat border: plain fill, no model needed

    busy = np.random.default_rng(1).integers(0, 255, (80, 80, 3), dtype=np.uint8)
    manual_region.clean_region(busy, (20, 20, 60, 60), use_lama=True)
    assert calls == [1]


def _b64png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.mark.parametrize("method, expected", [("lama", True), ("auto", False), (None, False)])
def test_region_erase_route_passes_the_inpainting_method(monkeypatch, method, expected):
    import endpoints.regions as regions

    seen = {}

    def fake_erase(image, mask, use_lama=False):
        seen["use_lama"] = use_lama
        return image.convert("RGB")

    monkeypatch.setattr(regions, "erase_mask", fake_erase)
    body = {"image": _b64png(Image.new("RGB", (8, 8))), "mask": _b64png(Image.new("L", (8, 8)))}
    if method is not None:
        body["inpainting_method"] = method
    resp = client.post("/region/erase", json=body)
    assert resp.status_code == 200
    assert seen["use_lama"] is expected


def _hatched(size=160):
    img = np.full((size, size), 235, np.uint8)
    for k in range(-size, size, 6):
        cv2.line(img, (k, 0), (k + size, size), 40, 1)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)


@pytest.mark.skipif(
    not (lama_mod.ModelManager().model_paths[lama_mod.ModelType.LAMA]).exists(),
    reason="LaMa model not downloaded (backend/models/lama/big-lama.pt)",
)
def test_real_lama_reconstructs_hatching_better_than_opencv():
    truth = _hatched()
    damaged = truth.copy()
    mask = np.zeros(truth.shape[:2], np.uint8)
    cv2.putText(mask, "SFX", (22, 105), cv2.FONT_HERSHEY_SIMPLEX, 2.2, 255, 14)
    damaged[mask > 0] = 0  # "text" drawn over the hatching

    lama = lama_inpaint_rgb(damaged, mask > 0, device="cpu")
    opencv = cv2.inpaint(damaged, mask, 3, cv2.INPAINT_TELEA)
    m = mask > 0
    lama_err = np.abs(lama[m].astype(int) - truth[m]).mean()
    opencv_err = np.abs(opencv[m].astype(int) - truth[m]).mean()
    assert lama_err < opencv_err, (lama_err, opencv_err)
