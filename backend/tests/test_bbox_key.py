"""core/pipeline.py:_bbox_key — the render step looks up a cleaned bubble's
mask/original-crop by its bbox in a dict keyed at the cleaning stage. An
exact tuple(bbox) match is fragile to float-precision drift between
pipeline stages (numpy float32 vs. Python float, list/JSON round-trips),
which would silently drop that bubble's render info — see
bubble_render_info_map in pipeline.py."""
from core.pipeline import _bbox_key


def test_identical_bboxes_match():
    assert _bbox_key([10, 20, 100, 200]) == _bbox_key([10, 20, 100, 200])


def test_float_precision_drift_still_matches():
    a = [10.0, 20.0, 100.0, 200.0]
    b = [10.0000001, 19.9999998, 100.0000003, 199.9999996]  # float32/float64 round-trip noise
    assert _bbox_key(a) == _bbox_key(b)


def test_genuinely_different_bboxes_do_not_match():
    assert _bbox_key([10, 20, 100, 200]) != _bbox_key([15, 20, 100, 200])


def test_rounds_to_whole_pixels():
    assert _bbox_key([10.4, 20.4, 100.4, 200.4]) == (10, 20, 100, 200)
    assert _bbox_key([10.6, 20.6, 100.6, 200.6]) == (11, 21, 101, 201)
