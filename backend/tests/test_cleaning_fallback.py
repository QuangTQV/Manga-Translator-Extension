"""Covers the third piece of the "bubble renders fully blank despite a
successful translation" bug family: when mask-processing genuinely fails
for a bubble (both standard cleaning and the Otsu retry — most often seen
for tightly-conjoined bubble pairs where the mask split is asymmetric),
that bubble used to be dropped from processed_bubbles_info entirely via a
silent `continue`. That meant the render step's bubble_render_info_map
lookup missed it, `original_crop_pil` stayed None, and the "restore
original text on render failure" fallback in pipeline.py had nothing to
restore — leaving the bubble fully blank with no way to recover.

_build_original_crop_fallback_entry gives that bubble a minimal entry
instead (no mask, so rendering falls back to the padded-bbox path; just
enough for the lookup to succeed and the restore fallback to have
something to paste back)."""
import numpy as np

from core.image.cleaning import _build_original_crop_fallback_entry


def _solid_image(width=300, height=200, bgr=(10, 20, 30)):
    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:, :] = bgr
    return img


def test_builds_a_minimal_entry_with_no_mask_and_the_original_crop():
    img = _solid_image()
    detection = {"bbox": [50, 40, 150, 100]}

    entry = _build_original_crop_fallback_entry(detection, img, img_width=300, img_height=200, is_sam=True)

    assert entry is not None
    assert entry["mask"] is None  # forces the render step's padded-bbox fallback path
    assert entry["base_mask"] is None
    assert entry["color"] == (255, 255, 255)
    assert entry["bbox"] == detection["bbox"]
    assert entry["is_sam"] is True
    # Cropped from the given bbox exactly (100x60), for pipeline.py's
    # restore-original-crop fallback to paste back unmodified.
    assert entry["original_crop_pil"].size == (100, 60)


def test_degenerate_zero_width_bbox_returns_none():
    img = _solid_image()
    assert _build_original_crop_fallback_entry(
        {"bbox": [50, 40, 50, 100]}, img, img_width=300, img_height=200, is_sam=False
    ) is None


def test_missing_bbox_returns_none():
    img = _solid_image()
    assert _build_original_crop_fallback_entry({}, img, img_width=300, img_height=200, is_sam=False) is None


def test_out_of_bounds_bbox_is_clamped_to_image():
    img = _solid_image()
    entry = _build_original_crop_fallback_entry(
        {"bbox": [-10, -10, 60, 50]}, img, img_width=300, img_height=200, is_sam=False
    )
    assert entry is not None
    assert entry["original_crop_pil"].size == (60, 50)


def test_crop_content_matches_the_source_image_region():
    img = _solid_image(bgr=(10, 20, 30))
    img[40:100, 50:150] = (99, 88, 77)  # distinct color inside the bbox region

    entry = _build_original_crop_fallback_entry(
        {"bbox": [50, 40, 150, 100]}, img, img_width=300, img_height=200, is_sam=True
    )

    # cv2_to_pil converts BGR -> RGB, so (99, 88, 77) BGR becomes (77, 88, 99) RGB.
    pixel = entry["original_crop_pil"].getpixel((5, 5))
    assert pixel == (77, 88, 99)
