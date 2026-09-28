"""`combine_into_page_image` (one-step only): instead of sending one cropped
image per detected text element, draw a numbered box on each element
directly on the full page and send that single annotated image — cuts a
busy page's image count from N crops to 1, trading per-element legibility
for fewer images (see core/pipeline.py:_build_annotated_page_image and
core/services/translation.py:call_translation_api_batch's `single_page_image`
branch)."""

import core.services.translation as tr
from core.config import TranslationConfig
from core.pipeline import _build_annotated_page_image
from PIL import Image


def _config(**kw):
    defaults = dict(
        provider="Google",
        google_api_key="k",
        model_name="gemini-2.5-flash",
        translation_mode="one-step",
        ocr_method="LLM",
        send_full_page_context=False,
        temperature=0.0,
        combine_into_page_image=True,
    )
    defaults.update(kw)
    return TranslationConfig(**defaults)


def _capture_call(monkeypatch, response_text):
    captured = {}

    def fake_call(cfg, parts, prompt, *args, **kwargs):
        captured["parts"] = parts
        captured["prompt"] = prompt
        captured["system_prompt"] = kwargs.get("system_prompt")
        return response_text

    monkeypatch.setattr(tr, "_call_llm_endpoint", fake_call)
    return captured


# ---------------------------------------------------------------------------
# core/pipeline.py:_build_annotated_page_image — pure image drawing
# ---------------------------------------------------------------------------
def test_build_annotated_page_image_returns_rgb_at_requested_max_side():
    page = Image.new("RGB", (2000, 3000), (255, 255, 255))
    bubbles = [{"bbox": (100, 100, 300, 200)}, {"bbox": (400, 500, 900, 700)}]
    annotated = _build_annotated_page_image(page, bubbles, max_side_pixels=1000)
    assert annotated.mode == "RGB"
    assert max(annotated.size) == 1000
    # Aspect ratio preserved (2000x3000 -> max side 1000 means height=1000, width~667)
    assert annotated.size[1] == 1000


def test_build_annotated_page_image_skips_items_without_a_bbox():
    page = Image.new("RGB", (500, 500), (255, 255, 255))
    bubbles = [{"bbox": (10, 10, 50, 50)}, {"no_bbox_here": True}, {"bbox": None}]
    # Must not raise despite the two bubbles missing a usable bbox.
    annotated = _build_annotated_page_image(page, bubbles, max_side_pixels=500)
    assert annotated.size == (500, 500)


def test_build_annotated_page_image_badge_does_not_cover_the_box_center():
    # The number badge must sit at the box's top-left corner, not dead
    # center — manga bubble text is usually near the visual center of a
    # small bubble, so a centered badge would cover exactly the characters
    # the model needs to read (unlike _write_component_order_debug_image's
    # own debug canvas, which is blank and never had this problem).
    page = Image.new("RGB", (600, 600), (255, 255, 255))
    bubbles = [{"bbox": (100, 100, 400, 400)}]
    annotated = _build_annotated_page_image(page, bubbles, max_side_pixels=600)
    center_pixel = annotated.getpixel((250, 250))
    assert center_pixel == (255, 255, 255)  # untouched white, not the red badge
    corner_pixel = annotated.getpixel((100, 100))
    assert corner_pixel != (255, 255, 255)  # the badge (or its dashed border) is here


def test_combine_into_page_image_defaults_to_enabled():
    assert TranslationConfig(provider="Google", google_api_key="k").combine_into_page_image is True


def test_build_annotated_page_image_does_not_upscale_a_small_page():
    page = Image.new("RGB", (300, 200), (255, 255, 255))
    annotated = _build_annotated_page_image(page, [], max_side_pixels=1024)
    assert annotated.size == (300, 200)


# ---------------------------------------------------------------------------
# core/services/translation.py:_build_system_prompt_translation
# ---------------------------------------------------------------------------
def test_single_page_image_system_prompt_talks_about_numbered_regions():
    prompt = tr._build_system_prompt_translation(
        output_language="English",
        mode="one-step",
        reading_direction="rtl",
        single_page_image=True,
    )
    assert "numbered regions in the page image" in prompt
    assert "image crops" not in prompt
    assert "region numbered `i`" in prompt
    assert "one line per numbered region" in prompt
    assert "numbered regions' order" in prompt


def test_default_system_prompt_unchanged_when_single_page_image_omitted():
    # Regression guard: the wording refactor for single_page_image must not
    # alter a single character of the existing one-step/two-step prompts.
    one_step = tr._build_system_prompt_translation(
        output_language="English", mode="one-step", reading_direction="rtl"
    )
    assert "image crops" in one_step
    assert "crop `i` itself" in one_step
    assert "different crop or from the full-page reference image" in one_step
    assert "one line per input image" in one_step
    assert "numbered region" not in one_step


# ---------------------------------------------------------------------------
# core/services/translation.py:call_translation_api_batch — single_page_image
# ---------------------------------------------------------------------------
def test_single_page_image_sends_exactly_one_image_part(monkeypatch):
    captured = _capture_call(
        monkeypatch, "1: 元 || first\n2: 気 || second\n3: 力 || third"
    )
    bubble_metadata = [{}, {}, {}]
    # Pipeline still passes the real per-bubble crops (cheap local work,
    # other features read them) — they must NOT end up in base_parts.
    translations = tr.call_translation_api_batch(
        _config(),
        ["crop1", "crop2", "crop3"],
        "",
        ["image/png"] * 3,
        "image/png",
        bubble_metadata,
        annotated_page_b64="ANNOTATED_PAGE_DATA",
        annotated_page_mime_type="image/jpeg",
    )
    assert translations == ["first", "second", "third"]
    assert len(captured["parts"]) == 1
    assert captured["parts"][0]["inline_data"]["data"] == "ANNOTATED_PAGE_DATA"
    assert captured["parts"][0]["inline_data"]["mime_type"] == "image/jpeg"
    assert "ONE full-page manga image" in captured["prompt"]
    assert "3 text regions" in captured["prompt"]


def test_single_page_image_falls_back_to_crops_when_no_annotated_image(monkeypatch):
    # combine_into_page_image is on, but the caller (pipeline.py) couldn't
    # build an annotated image (e.g. no text elements) — must not silently
    # send zero images; falls back to the normal per-crop path.
    captured = _capture_call(monkeypatch, "1: 元 || first")
    translations = tr.call_translation_api_batch(
        _config(),
        ["crop1"],
        "",
        ["image/png"],
        "image/png",
        [{}],
        annotated_page_b64=None,
    )
    assert translations == ["first"]
    assert len(captured["parts"]) == 1
    assert captured["parts"][0]["inline_data"]["data"] == "crop1"


def test_single_page_image_ignored_in_two_step_mode(monkeypatch):
    captured = _capture_call(monkeypatch, "1: first")
    config = _config(translation_mode="two-step")
    translations = tr.call_translation_api_batch(
        config,
        ["text line"],
        "",
        [],
        "image/png",
        [{}],
        annotated_page_b64="ANNOTATED_PAGE_DATA",
    )
    assert translations == ["first"]
    # two-step never sends images at all regardless of combine_into_page_image.
    assert captured["parts"] == []


def test_combine_into_page_image_off_uses_normal_per_bubble_parts(monkeypatch):
    captured = _capture_call(monkeypatch, "1: 元 || first\n2: 気 || second")
    config = _config(combine_into_page_image=False)
    translations = tr.call_translation_api_batch(
        config,
        ["crop1", "crop2"],
        "",
        ["image/png", "image/png"],
        "image/png",
        [{}, {}],
        annotated_page_b64="ANNOTATED_PAGE_DATA",  # present but must be ignored
    )
    assert translations == ["first", "second"]
    assert len(captured["parts"]) == 2
