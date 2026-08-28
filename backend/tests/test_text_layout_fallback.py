"""Covers the "bubble renders fully blank despite a successful translation"
bug: a long translated sentence (Vietnamese diacritics in particular tend
to run long) in a small bubble could fail to fit at any font size down to
min_font_size, raising RenderingError and leaving the bubble as just the
cleaned/whited-out crop with nothing drawn — see core/text/layout_engine.py
find_optimal_layout's last-resort fallback."""
from pathlib import Path

import pytest

from core.text.drawing_engine import load_font_resources
from core.text.layout_engine import find_optimal_layout
from utils.exceptions import RenderingError

FONT_PATH = Path(__file__).resolve().parent.parent / "fonts" / "Roboto" / "Roboto-Regular.ttf"

LONG_VIETNAMESE_SENTENCE = (
    "Ở kiếp trước, vào những giây phút cuối đời, mình đã nhận ra một sai lầm "
    "chết người mà bản thân đã mắc phải suốt bao năm qua"
)


@pytest.fixture(scope="module")
def font_resources():
    _font_data, typeface, hb_face = load_font_resources(str(FONT_PATH))
    return typeface, hb_face


def test_text_that_cannot_fit_even_at_min_font_size_still_renders(font_resources):
    """The exact bug scenario: a long sentence in a bubble too small for it
    at any font size must still produce a drawable layout (text overflows
    the box rather than the bubble staying blank)."""
    typeface, hb_face = font_resources

    result = find_optimal_layout(
        text=LONG_VIETNAMESE_SENTENCE,
        max_render_width=80.0,
        max_render_height=40.0,  # deliberately far too short for this much text
        regular_hb_face=hb_face,
        regular_typeface=typeface,
        loaded_hb_faces={"regular": hb_face},
        features_to_enable={"kern": False, "liga": False, "calt": False},
        min_font_size=8,
        max_font_size=16,
    )

    assert result["font_size"] == 8  # fell back to the minimum, as designed
    assert len(result["lines"]) > 0
    total_height = result["line_height"] * len(result["lines"])
    # The whole point: it's allowed to exceed max_render_height now, rather
    # than raising and leaving the bubble blank.
    assert total_height > 40.0


def test_normal_text_that_fits_is_unaffected(font_resources):
    """The fallback must only kick in when nothing else fits — a short
    string in a roomy box should still get a normal, non-overflowing fit
    at a size below max, exactly as before this change."""
    typeface, hb_face = font_resources

    result = find_optimal_layout(
        text="Hi there",
        max_render_width=400.0,
        max_render_height=200.0,
        regular_hb_face=hb_face,
        regular_typeface=typeface,
        loaded_hb_faces={"regular": hb_face},
        features_to_enable={"kern": False, "liga": False, "calt": False},
        min_font_size=8,
        max_font_size=16,
    )

    assert result["font_size"] == 16  # fits comfortably at the max size
    total_height = result["line_height"] * len(result["lines"])
    assert total_height <= 200.0


def test_genuinely_unfittable_width_still_raises(font_resources):
    """The fallback only relaxes the *height* limit — a word too wide to
    ever fit within max_render_width (even after hyphenation attempts)
    must still raise, since there's no sane way to lay it out at all."""
    typeface, hb_face = font_resources

    with pytest.raises(RenderingError):
        find_optimal_layout(
            text="Supercalifragilisticexpialidocioussupercalifragilisticexpialidocious",
            max_render_width=10.0,
            max_render_height=10.0,
            regular_hb_face=hb_face,
            regular_typeface=typeface,
            loaded_hb_faces={"regular": hb_face},
            features_to_enable={"kern": False, "liga": False, "calt": False},
            min_font_size=8,
            max_font_size=16,
            hyphenate_before_scaling=False,
        )
