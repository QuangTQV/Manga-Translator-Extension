"""Covers the fourth (and actual root-cause) piece of the "bubble renders
fully blank despite a successful translation" bug family: for outside-
bubble (OSB) text, a K-means/contrast-based heuristic tries to preserve
the original text's color when painting the translation over it. When an
OSB caption box sits close to dark artwork (e.g. a character's dark hair),
the small border ring this heuristic samples to guess "background" can
bleed into that dark art — inverting the read entirely, so it reports the
box's own WHITE background as the "text color" instead of the actual
black text. render_text_skia then paints white text over the white fill
it just painted: no exception, "success" logged, completely invisible
output. See core/outside_text_processor.py's
_text_color_would_be_invisible guard."""
from core.outside_text_processor import (
    INVISIBLE_TEXT_COLOR_DISTANCE_THRESHOLD,
    _text_color_would_be_invisible,
)


def test_white_on_white_is_invisible():
    assert _text_color_would_be_invisible((255, 255, 255), (255, 255, 255)) is True


def test_black_on_black_is_invisible():
    assert _text_color_would_be_invisible((0, 0, 0), (0, 0, 0)) is True


def test_black_on_white_is_visible():
    assert _text_color_would_be_invisible((0, 0, 0), (255, 255, 255)) is False


def test_near_white_on_white_is_still_caught():
    # The extraction is a median over noisy real pixels, rarely exactly
    # (255,255,255) — near-white must be caught too, not just exact matches.
    assert _text_color_would_be_invisible((248, 250, 252), (255, 255, 255)) is True


def test_clearly_distinct_colors_are_not_flagged():
    assert _text_color_would_be_invisible((0, 0, 0), (255, 255, 255)) is False
    assert _text_color_would_be_invisible((200, 30, 30), (255, 255, 255)) is False


def test_no_fill_color_available_never_flags():
    # Can't judge invisibility without knowing what it'll be painted over —
    # must not discard a plausibly-correct extracted color in that case.
    assert _text_color_would_be_invisible((255, 255, 255), None) is False


def test_threshold_is_a_summed_channel_distance():
    # Documents the actual metric so a future change to the threshold value
    # doesn't silently change what "close" means without a test noticing.
    just_under = (255, 255, 255 - (INVISIBLE_TEXT_COLOR_DISTANCE_THRESHOLD - 1))
    just_over = (255, 255, 255 - (INVISIBLE_TEXT_COLOR_DISTANCE_THRESHOLD + 1))
    assert _text_color_would_be_invisible(just_under, (255, 255, 255)) is True
    assert _text_color_would_be_invisible(just_over, (255, 255, 255)) is False
