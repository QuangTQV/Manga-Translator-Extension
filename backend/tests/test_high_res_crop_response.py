"""endpoints/translate.py:_build_bubble_info — the hover-to-magnify UI in
the extension used to enlarge a crop of the FINAL (already downscaled)
page image via CSS, which just blows up existing pixels with no new detail
— visibly blurry for anything more than a light zoom. The backend already
renders each bubble's text at N times the final resolution before
downscaling it back down for the page (core/text/text_renderer.py's
supersampling path) — that sharper intermediate was previously discarded
immediately after use. It's now optionally captured (via render_text_skia's
high_res_crops out-param, threaded through core/pipeline.py's per-bubble
loop) and, here, base64-encoded into each BubbleInfo response item so the
extension can use it instead of the blurry CSS crop when present."""
import base64
import io

from PIL import Image

from endpoints.translate import _build_bubble_info


def _tiny_image(color=(10, 20, 30)):
    img = Image.new("RGB", (8, 6), color)
    return img


def test_bubble_with_a_high_res_crop_gets_it_base64_encoded():
    bubbles = [{
        "bbox": [1.0, 2.0, 3.0, 4.0],
        "confidence": 0.9,
        "ocr_text": "hi",
        "translation": "chao",
        "high_res_crop_pil": _tiny_image(),
    }]

    [info] = _build_bubble_info(bubbles)

    assert info.high_res_crop is not None
    decoded = Image.open(io.BytesIO(base64.b64decode(info.high_res_crop)))
    assert decoded.size == (8, 6)


def test_bubble_without_a_high_res_crop_leaves_the_field_none():
    # Supersampling can be off, or rendering can have failed after the
    # bubble was already added to bubbles_out — either way, no crop should
    # never crash the response, just omit it (extension falls back to its
    # existing CSS-crop magnifier).
    bubbles = [{
        "bbox": [1.0, 2.0, 3.0, 4.0],
        "confidence": 0.9,
        "ocr_text": "hi",
        "translation": "chao",
    }]

    [info] = _build_bubble_info(bubbles)

    assert info.high_res_crop is None


def test_mixed_batch_only_encodes_the_bubbles_that_have_a_crop():
    bubbles = [
        {"bbox": [0, 0, 1, 1], "confidence": 1.0, "translation": "a", "high_res_crop_pil": _tiny_image((1, 1, 1))},
        {"bbox": [0, 0, 1, 1], "confidence": 1.0, "translation": "b"},
        {"bbox": [0, 0, 1, 1], "confidence": 1.0, "translation": "c", "high_res_crop_pil": _tiny_image((2, 2, 2))},
    ]

    results = _build_bubble_info(bubbles)

    assert results[0].high_res_crop is not None
    assert results[1].high_res_crop is None
    assert results[2].high_res_crop is not None
