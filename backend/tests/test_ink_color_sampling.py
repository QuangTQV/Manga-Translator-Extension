"""core/image/cleaning.py:_sample_ink_color_bgr — the rendered translated
text used to come out visibly paler than the source ink. Manga text
(especially small dialogue/SFX) is heavily anti-aliased: most sampled
"text" pixels are partial ink/background blends rather than pure ink, so a
plain median over all of them skews toward the background color instead of
the actual ink. Biasing toward the most ink-like quarter (by luminance)
before taking the median should land much closer to the true color."""
import numpy as np

from core.image.cleaning import _sample_ink_color_bgr


def test_mostly_anti_aliased_dark_text_samples_close_to_pure_black():
    # A handful of near-pure-black "core" pixels drowned out by many more
    # lighter, partially-blended edge pixels — the realistic shape of
    # small anti-aliased manga text on a white bubble.
    core = np.tile(np.array([5, 5, 5]), (10, 1))
    blended = np.tile(np.array([180, 180, 180]), (40, 1))
    pixels = np.vstack([core, blended]).astype(np.uint8)

    naive_median = np.median(pixels, axis=0)
    result = _sample_ink_color_bgr(pixels, is_black_bubble=False)

    # The naive median (dominated by blended pixels) would read ~180 —
    # nowhere near the actual ink. The percentile-biased result must land
    # much closer to the true dark ink color instead.
    assert max(result) < 100
    assert max(result) < naive_median[0]


def test_mostly_anti_aliased_light_text_on_black_bubble_samples_close_to_white():
    core = np.tile(np.array([250, 250, 250]), (10, 1))
    blended = np.tile(np.array([70, 70, 70]), (40, 1))
    pixels = np.vstack([core, blended]).astype(np.uint8)

    result = _sample_ink_color_bgr(pixels, is_black_bubble=True)

    assert min(result) > 200


def test_uniform_color_returns_that_color():
    pixels = np.tile(np.array([12, 34, 56]), (20, 1)).astype(np.uint8)
    result = _sample_ink_color_bgr(pixels, is_black_bubble=False)
    assert tuple(result) == (12, 34, 56)


def test_colored_ink_hue_is_preserved_not_flattened_to_gray():
    # A saturated red ink, still anti-aliased against a white bubble —
    # the color (not just darkness) must survive the percentile filter.
    core = np.tile(np.array([10, 10, 200]), (10, 1))  # BGR: strong red
    blended = np.tile(np.array([200, 200, 250]), (40, 1))  # pale pink blend
    pixels = np.vstack([core, blended]).astype(np.uint8)

    result = _sample_ink_color_bgr(pixels, is_black_bubble=False)

    # Blue/green channels should land near the saturated core, not the
    # much brighter blended average.
    assert result[0] < 100
    assert result[1] < 100
