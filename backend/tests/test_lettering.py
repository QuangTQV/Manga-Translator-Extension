"""Scanlation lettering options (popup Pro tab): uppercase, line alignment,
text color and outline — RenderingConfig fields read by
core/text/text_renderer.py / drawing_engine.py. Real Skia rendering with the
bundled Roboto font; no ML models needed."""
from dataclasses import replace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import main
from core.config import RenderingConfig
from core.text.text_renderer import render_text_skia
from pipeline.wrapper import _hex_to_rgb

client = TestClient(main.app, raise_server_exceptions=False)
FONT_DIR = "fonts/Roboto"
BASE = RenderingConfig(font_dir=FONT_DIR, min_font_size=14, max_font_size=14, supersampling_factor=1)
BOX = (0, 0, 120, 160)


def _render(text, **overrides):
    image = Image.new("RGB", (120, 160), (255, 255, 255))
    out = render_text_skia(image, text, BOX, FONT_DIR, config=replace(BASE, **overrides))
    return np.array(out.convert("RGB"))


def _line_left_edges(arr):
    """Leftmost ink x of each text line (rows of ink separated by blank rows)."""
    ink = (arr < 128).all(axis=2)
    rows = ink.any(axis=1)
    edges, start = [], None
    for y, has in enumerate(list(rows) + [False]):
        if has and start is None:
            start = y
        elif not has and start is not None:
            edges.append(int(np.nonzero(ink[start:y].any(axis=0))[0].min()))
            start = None
    return edges


LONG_THEN_SHORT = "Wonderful weather we have today! Yes"


def test_uppercase_renders_like_typing_in_capitals():
    assert (_render("hello *there*", uppercase=True) == _render("HELLO *THERE*")).all()
    assert not (_render("hello there") == _render("HELLO THERE")).all()


def test_left_alignment_lines_up_line_starts_and_center_does_not():
    left = _line_left_edges(_render(LONG_THEN_SHORT, text_align="left"))
    center = _line_left_edges(_render(LONG_THEN_SHORT))
    assert len(left) >= 2 and len(center) == len(left)
    assert max(left) - min(left) <= 2
    assert max(center) - min(center) > 10


def test_right_alignment_lines_up_line_ends():
    arr = _render(LONG_THEN_SHORT, text_align="right")
    mirrored = _line_left_edges(arr[:, ::-1])
    assert len(mirrored) >= 2 and max(mirrored) - min(mirrored) <= 2


def test_text_color_override_beats_the_automatic_color():
    arr = _render("RED TEXT", text_color_rgb=(220, 0, 0))
    reds = (arr[:, :, 0] > 180) & (arr[:, :, 1] < 60) & (arr[:, :, 2] < 60)
    assert reds.sum() > 50


def test_outline_uses_the_chosen_color():
    arr = _render("OUTLINE", text_color_rgb=(255, 255, 255), outline_width=3, outline_color_rgb=(0, 0, 230))
    blues = (arr[:, :, 2] > 180) & (arr[:, :, 0] < 60) & (arr[:, :, 1] < 60)
    assert blues.sum() > 50
    # No outline width -> nothing blue, whatever the outline color.
    plain = _render("OUTLINE", outline_color_rgb=(0, 0, 230))
    assert ((plain[:, :, 2] > 180) & (plain[:, :, 0] < 60)).sum() == 0


@pytest.mark.parametrize("value, expected", [("#ff8000", (255, 128, 0)), (None, None), ("", None), ("red", None), ("#zzzzzz", None)])
def test_hex_to_rgb(value, expected):
    assert _hex_to_rgb(value) == expected


def test_request_fields_reach_the_manual_region_renderer(monkeypatch):
    import endpoints.regions as regions

    seen = {}

    def fake_render(base, draw_regions, font_dir, rendering, use_lama=False):
        seen["rendering"] = rendering
        return base

    monkeypatch.setattr(regions, "render_regions", fake_render)
    from core.manual_region import encode_png

    resp = client.post("/region/render", json={
        "provider": "Google", "input_language": "Japanese", "output_language": "English",
        "image": encode_png(Image.new("RGB", (40, 40))),
        "regions": [{"box": {"x1": 0.1, "y1": 0.1, "x2": 0.9, "y2": 0.9}, "text": "hi"}],
        "lettering_uppercase": True, "lettering_align": "left",
        "lettering_text_color": "#112233", "lettering_outline_width": 2, "lettering_outline_color": "#FFFFFF",
    })
    assert resp.status_code == 200, resp.text
    r = seen["rendering"]
    assert (r.uppercase, r.text_align, r.text_color_rgb, r.outline_width, r.outline_color_rgb) == (
        True, "left", (0x11, 0x22, 0x33), 2.0, (255, 255, 255),
    )


@pytest.mark.parametrize("field, value", [
    ("lettering_text_color", "red"), ("lettering_align", "justify"), ("lettering_outline_width", 50),
])
def test_invalid_lettering_values_are_rejected(field, value):
    resp = client.post("/region/translate", json={
        "provider": "Google", "input_language": "Japanese", "output_language": "English",
        "text": "x", field: value,
    })
    assert resp.status_code == 422
