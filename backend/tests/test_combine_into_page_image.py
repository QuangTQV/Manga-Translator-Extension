"""`combine_into_page_image` (one-step only): instead of sending one cropped
image per detected text element, draw a numbered box on each element
directly on the full page and send that single annotated image — cuts a
busy page's image count from N crops to 1, trading per-element legibility
for fewer images (see core/pipeline.py:_build_annotated_page_image and
core/services/translation.py:call_translation_api_batch's `single_page_image`
branch)."""

import base64
from io import BytesIO

import pytest
import core.services.translation as tr
from core.config import TranslationConfig
from core.pipeline import _build_annotated_page_image, _resolve_combined_page_image_max_side
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


def _png_b64(size=(1200, 800)):
    image = Image.new("RGB", size, (255, 255, 255))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


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


def test_combine_page_image_max_side_pixels_defaults_to_1536():
    config = TranslationConfig(provider="Google", google_api_key="k")
    assert config.combine_page_image_max_side_pixels == 1536


def test_combine_page_image_max_side_pixels_is_separate_from_context_image_setting():
    # Deliberately two different fields — see core/config.py's comment on
    # combine_page_image_max_side_pixels for why they must not be merged.
    config = TranslationConfig(provider="Google", google_api_key="k")
    assert config.context_image_max_side_pixels != config.combine_page_image_max_side_pixels


def test_translate_options_rejects_out_of_range_combine_page_image_max_side():
    import pytest
    from pydantic import ValidationError

    from schemas import TranslateOptions

    base = dict(input_language="Japanese", output_language="English", provider="Google")
    TranslateOptions(**base, combine_page_image_max_side_pixels=512)  # lower bound ok
    TranslateOptions(**base, combine_page_image_max_side_pixels=4096)  # upper bound ok
    with pytest.raises(ValidationError):
        TranslateOptions(**base, combine_page_image_max_side_pixels=511)
    with pytest.raises(ValidationError):
        TranslateOptions(**base, combine_page_image_max_side_pixels=4097)


def test_combine_page_image_max_side_pixels_is_part_of_the_cache_key():
    from core.caching import UnifiedCache

    cache = UnifiedCache()
    config_small = TranslationConfig(
        provider="Google", google_api_key="k", temperature=0.0,
        combine_into_page_image=True, combine_page_image_max_side_pixels=1024,
    )
    config_large = TranslationConfig(
        provider="Google", google_api_key="k", temperature=0.0,
        combine_into_page_image=True, combine_page_image_max_side_pixels=2048,
    )
    key_small = cache.get_translation_cache_key(["same-image-data"], "", config_small)
    key_large = cache.get_translation_cache_key(["same-image-data"], "", config_large)
    assert key_small != key_large


def test_build_annotated_page_image_does_not_upscale_a_small_page():
    page = Image.new("RGB", (300, 200), (255, 255, 255))
    annotated = _build_annotated_page_image(page, [], max_side_pixels=1024)
    assert annotated.size == (300, 200)


@pytest.mark.parametrize("mode,expected", [("low", 1024), ("standard", 1536), ("high", 2560)])
def test_combined_page_resolution_presets(mode, expected):
    assert _resolve_combined_page_image_max_side((3000, 4000), [], mode) == expected


def test_combined_page_resolution_keeps_legacy_numeric_setting():
    assert _resolve_combined_page_image_max_side((3000, 4000), [], "legacy", 2048) == 2048


def test_combined_page_resolution_auto_uses_low_for_easy_page():
    regions = [{"bbox": (i * 300, 100, i * 300 + 240, 300)} for i in range(6)]
    assert _resolve_combined_page_image_max_side((2000, 3000), regions, "auto") == 1024


def test_combined_page_resolution_auto_raises_for_dense_small_text():
    regions = [{"bbox": (i * 30, 100, i * 30 + 100, 200)} for i in range(40)]
    assert _resolve_combined_page_image_max_side((2000, 3000), regions, "auto") == 1536


def test_combined_page_resolution_auto_uses_highest_bound_for_tiny_regions():
    regions = [{"bbox": (i * 20, 100, i * 20 + 20, 120)} for i in range(60)]
    assert _resolve_combined_page_image_max_side((2000, 3000), regions, "auto") == 2560


def test_combined_page_resolution_auto_falls_back_without_valid_boxes():
    assert _resolve_combined_page_image_max_side((2000, 3000), [{"bbox": None}], "auto") == 1536


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
    assert "IDs `1..N` exactly once" in prompt
    assert "never add, omit, duplicate, renumber, merge, split, or move text between regions" in prompt


def test_default_system_prompt_keeps_crop_and_reference_assignment_clear():
    one_step = tr._build_system_prompt_translation(
        output_language="English", mode="one-step", reading_direction="rtl"
    )
    assert "image crops" in one_step
    assert "item `i` must come only from crop `i`" in one_step
    assert "not similar text from another crop or the full-page reference image" in one_step
    assert "one line per input image" in one_step
    assert "numbered region" not in one_step


def test_combined_page_response_validator_finds_missing_duplicate_and_failed_rows():
    rows, repair_ids, out_of_range = tr._inspect_combined_page_response(
        "1: source || translated\n"
        "2: first duplicate || translation\n"
        "2: second duplicate || translation\n"
        "4: [OCR FAILED] || [OCR FAILED]",
        total_elements=4,
    )
    assert rows == {1: "source || translated"}
    assert repair_ids == [2, 3, 4]
    assert out_of_range is False


def test_combined_page_response_validator_repairs_all_after_out_of_range_index():
    rows, repair_ids, out_of_range = tr._inspect_combined_page_response(
        "1: one || uno\n2: two || dos\n9: unexpected || extra",
        total_elements=2,
    )
    assert rows == {}
    assert repair_ids == [1, 2]
    assert out_of_range is True


def test_combined_page_response_validator_rejects_ocr_failed_by_default():
    # The first pass over the model's original response: an [OCR FAILED] row
    # is worth one repair attempt (a dedicated crop might read better), so
    # it's flagged as needing repair rather than accepted outright.
    rows, repair_ids, out_of_range = tr._inspect_combined_page_response(
        "1: [OCR FAILED] || [OCR FAILED]\n2: two || dos", total_elements=2,
    )
    assert rows == {2: "two || dos"}
    assert repair_ids == [1]
    assert out_of_range is False


def test_combined_page_response_validator_accepts_ocr_failed_when_reparsing_a_repair():
    # Re-parsing the *repair* call's own response: the model already got a
    # dedicated crop and still says [OCR FAILED] — that's its considered
    # final answer, not something to discard in favor of "Missing item N".
    # Regression test for a real production report: this used to drop a
    # correctly-formatted repair response, producing the generic
    # "[PROVIDER: Missing item N]" placeholder instead of [OCR FAILED]
    # (which the rest of the pipeline already knows to fall back to the
    # original, untranslated pixels for). A repair response only ever
    # contains rows for the ids that needed repair, so 1/3 legitimately
    # stay missing here — the caller only reads the specific ids it asked
    # for back out of `rows`, never the unused `repair_ids` against the
    # full page.
    rows, repair_ids, out_of_range = tr._inspect_combined_page_response(
        "2: [OCR FAILED] || [OCR FAILED]\n4: [OCR FAILED] || [OCR FAILED]",
        total_elements=4,
        accept_ocr_failed=True,
    )
    assert rows == {2: "[OCR FAILED] || [OCR FAILED]", 4: "[OCR FAILED] || [OCR FAILED]"}
    assert 2 not in repair_ids and 4 not in repair_ids
    assert out_of_range is False


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


def test_single_page_image_repairs_missing_row_with_small_compressed_crop(monkeypatch):
    crops = [_png_b64() for _ in range(3)]
    calls = []

    def fake_call(cfg, parts, prompt, *args, **kwargs):
        calls.append((parts, prompt, kwargs.get("system_prompt")))
        if len(calls) == 1:
            return "1: 元 || first\n3: 力 || third"
        return "2: 気 || fixed second"

    monkeypatch.setattr(tr, "_call_llm_endpoint", fake_call)
    translations = tr.call_translation_api_batch(
        _config(),
        crops,
        "",
        ["image/png"] * 3,
        "image/png",
        [{}, {}, {}],
        annotated_page_b64="ANNOTATED_PAGE_DATA",
        annotated_page_mime_type="image/jpeg",
    )

    assert translations == ["first", "fixed second", "third"]
    assert len(calls) == 2
    repair_parts, repair_prompt, repair_system_prompt = calls[1]
    assert len(repair_parts) == 1
    repaired_image = repair_parts[0]["inline_data"]
    assert repaired_image["data"] != crops[1]
    assert repaired_image["mime_type"] == "image/jpeg"
    decoded = base64.b64decode(repaired_image["data"])
    with Image.open(BytesIO(decoded)) as image:
        assert image.format == "JPEG"
        assert max(image.size) == tr.COMBINE_PAGE_IMAGE_REPAIR_CROP_MAX_SIDE
    assert len(decoded) < len(base64.b64decode(crops[1]))
    assert "region(s): 2" in repair_prompt
    assert "crop 1 = original numbered region 2" in repair_prompt


def test_single_page_image_accepts_ocr_failed_from_a_repair_call(monkeypatch):
    # Regression test for a real production report: the model's repair
    # response correctly said [OCR FAILED] for both requested regions (a
    # legitimate final answer after a dedicated-crop look — not a parsing
    # failure), but the result used to discard it and fall back to the
    # generic "[PROVIDER: Missing item N]" placeholder instead.
    crops = [_png_b64() for _ in range(4)]
    calls = []

    def fake_call(cfg, parts, prompt, *args, **kwargs):
        calls.append(prompt)
        if len(calls) == 1:
            return "1: 元 || first\n3: ・・・怖い賭けだけど || scary bet"
        return "2: [OCR FAILED] || [OCR FAILED]\n4: [OCR FAILED] || [OCR FAILED]"

    monkeypatch.setattr(tr, "_call_llm_endpoint", fake_call)
    translations = tr.call_translation_api_batch(
        _config(provider="Azure OpenAI"),
        crops,
        "",
        ["image/png"] * 4,
        "image/png",
        [{}, {}, {}, {}],
        annotated_page_b64="ANNOTATED_PAGE_DATA",
        annotated_page_mime_type="image/jpeg",
    )

    assert len(calls) == 2  # exactly one repair attempt, as designed
    assert translations[1] == "[OCR FAILED]"
    assert translations[3] == "[OCR FAILED]"
    assert "Missing item" not in translations[1]
    assert "Missing item" not in translations[3]


def test_single_page_image_does_not_retry_more_than_once(monkeypatch):
    calls = []

    def fake_call(cfg, parts, prompt, *args, **kwargs):
        calls.append(prompt)
        return "1: 元 || first" if len(calls) == 1 else "2: still malformed"

    monkeypatch.setattr(tr, "_call_llm_endpoint", fake_call)
    translations = tr.call_translation_api_batch(
        _config(),
        ["crop1", "crop2"],
        "",
        ["image/png"] * 2,
        "image/png",
        [{}, {}],
        annotated_page_b64="REPAIR_ONCE_PAGE",
    )

    assert len(calls) == 2
    assert translations[0] == "first"
    assert "Missing item 2" in translations[1]


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
