"""Per-region text style (schemas.RegionStyle -> core/manual_region.py:
apply_region_style/render_regions): one manual text area drawn with its own
font, size, colours, alignment, rotation, ... while the others keep the
global settings. Real Skia rendering with the bundled font packs."""
import math
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import main
from config import settings
from core.config import RenderingConfig
from core.manual_region import apply_region_style, render_regions, resolve_font_pack, rotated_fit

client = TestClient(main.app, raise_server_exceptions=False)
FONTS = Path(__file__).resolve().parents[1] / "fonts"
FONT_DIR = str(FONTS / "Roboto")
BASE_RENDERING = RenderingConfig(font_dir=FONT_DIR, min_font_size=10, max_font_size=22, supersampling_factor=1)
BOX = (0.1, 0.1, 0.9, 0.9)  # on a 400x300 page: x 40..360, y 30..270
TEXT = "Hello there, friend"


def _page():
    return Image.new("RGB", (400, 300), (255, 255, 255))


def _render(text=TEXT, style=None, rendering=BASE_RENDERING, box=BOX, font_dir=FONT_DIR, page=None):
    spec = (box, text) if style is None else (box, text, style)
    out = render_regions(page or _page(), [spec], font_dir, rendering, fonts_base_dir=FONTS)
    return np.array(out.convert("RGB"))


def _ink(arr, bg=(255, 255, 255), tol=40):
    return (np.abs(arr.astype(int) - np.array(bg)).max(axis=2) > tol)


def _extent(mask):
    ys, xs = np.nonzero(mask)
    return xs.min(), ys.min(), xs.max(), ys.max()


# ---------------------------------------------------------------------------
# geometry helpers
# ---------------------------------------------------------------------------
def test_rotated_fit_swaps_sides_at_a_quarter_turn_and_shrinks_at_45():
    assert rotated_fit(200, 100, 0) == (200, 100)
    assert rotated_fit(200, 100, 90) == (100, 200)
    assert rotated_fit(200, 100, -90) == (100, 200)
    assert rotated_fit(200, 100, 180) == (200, 100)
    w, h = rotated_fit(100, 100, 45)
    assert w == pytest.approx(70.7, abs=1.5) and h == pytest.approx(70.7, abs=1.5)


@pytest.mark.parametrize("angle", [10, 30, 45, 60, 89, -25, 135])
def test_the_rotated_block_always_fits_inside_the_box(angle):
    box_w, box_h = 320.0, 120.0
    w, h = rotated_fit(box_w, box_h, angle)
    t = math.radians(angle)
    bound_w = w * abs(math.cos(t)) + h * abs(math.sin(t))
    bound_h = w * abs(math.sin(t)) + h * abs(math.cos(t))
    assert bound_w <= box_w + 0.5 and bound_h <= box_h + 0.5
    assert w > 0 and h > 0


def test_font_pack_names_resolve_only_to_real_packs_directly_under_the_fonts_dir():
    assert resolve_font_pack("Comicka", FONTS) == str(FONTS / "Comicka")
    assert resolve_font_pack("Komika Hand", FONTS) == str(FONTS / "Komika Hand")  # spaces are fine
    for bad in ["../fonts", "..", ".", "", None, "Roboto/../Comicka", "/etc", "nope", "fonts/Roboto", "Roboto\x00"]:
        assert resolve_font_pack(bad, FONTS) is None, bad
    assert resolve_font_pack("Roboto", None) is None


def test_no_style_changes_nothing():
    rendering, font_dir, kwargs = apply_region_style((0, 0, 100, 50), None, BASE_RENDERING, FONT_DIR, FONTS)
    assert rendering is BASE_RENDERING and font_dir == FONT_DIR and kwargs == {}
    rendering, font_dir, kwargs = apply_region_style((0, 0, 100, 50), {"rotation": 0.0, "vertical": False}, BASE_RENDERING, FONT_DIR, FONTS)
    assert rendering == BASE_RENDERING and kwargs == {}


def test_style_fields_map_onto_the_rendering_config_and_render_arguments():
    style = {
        "font_size": 30.4, "line_spacing": 1.4, "align": "right", "text_color": "#112233", "outline_width": 2.5,
        "outline_color": "#ffffff", "uppercase": True, "background_color": "#ffee00", "vertical": True,
        "rotation": 15, "text_area": 50, "offset_x": 10, "offset_y": -10, "font": "Comicka",
    }
    rendering, font_dir, kwargs = apply_region_style((0, 0, 200, 100), style, BASE_RENDERING, FONT_DIR, FONTS)
    assert (rendering.min_font_size, rendering.max_font_size) == (30, 30)
    assert rendering.line_spacing_mult == 1.4 and rendering.text_align == "right"
    assert rendering.text_color_rgb == (0x11, 0x22, 0x33) and rendering.outline_color_rgb == (255, 255, 255)
    assert rendering.outline_width == 2.5 and rendering.uppercase is True
    assert font_dir == str(FONTS / "Comicka")
    assert kwargs["text_background_color"] == (255, 0xEE, 0) and kwargs["vertical_stack"] is True and kwargs["rotation_deg"] == 15
    lw, lh = kwargs["layout_size"]
    assert lw <= 100 and lh <= 50  # 50% of the box, and rotated inside it
    assert BASE_RENDERING.min_font_size == 10  # the shared global config is never mutated


def test_an_explicit_outline_width_of_zero_beats_a_global_outline():
    globally_outlined = RenderingConfig(font_dir=FONT_DIR, outline_width=3.0)
    rendering, _, _ = apply_region_style((0, 0, 100, 50), {"outline_width": 0}, globally_outlined, FONT_DIR, FONTS)
    assert rendering.outline_width == 0.0
    rendering, _, _ = apply_region_style((0, 0, 100, 50), {}, globally_outlined, FONT_DIR, FONTS)
    assert rendering.outline_width == 3.0  # unset = global


def test_offsets_are_clamped_so_the_text_block_stays_inside_the_box():
    _, _, kwargs = apply_region_style((0, 0, 200, 100), {"text_area": 60, "offset_x": 50, "offset_y": -50}, BASE_RENDERING, FONT_DIR, FONTS)
    dx, dy = kwargs["center_offset"]
    assert dx == pytest.approx((200 - 120) / 2) and dy == pytest.approx(-(100 - 60) / 2)
    _, _, kwargs = apply_region_style((0, 0, 200, 100), {"offset_x": 50}, BASE_RENDERING, FONT_DIR, FONTS)
    assert "center_offset" not in kwargs  # a full-size block has no room to move


# ---------------------------------------------------------------------------
# real rendering
# ---------------------------------------------------------------------------
def test_a_fixed_font_size_is_used_instead_of_fitting_to_the_box():
    small = _extent(_ink(_render(style={"font_size": 12})))
    large = _extent(_ink(_render(style={"font_size": 30})))
    small_h, large_h = small[3] - small[1], large[3] - large[1]
    assert large_h > small_h * 1.8
    # Auto-fit picks the biggest size in the global range that fits: the global max here.
    auto = _extent(_ink(_render()))
    assert (auto[3] - auto[1]) < large_h


def test_text_colour_outline_and_background_are_drawn():
    red = _render(style={"text_color": "#dc0000"})
    assert ((red[:, :, 0] > 180) & (red[:, :, 1] < 60) & (red[:, :, 2] < 60)).sum() > 50

    outlined = _render(style={"text_color": "#ffffff", "outline_width": 3, "outline_color": "#0000e6"})
    assert ((outlined[:, :, 2] > 180) & (outlined[:, :, 0] < 60) & (outlined[:, :, 1] < 60)).sum() > 50

    highlighted = _render(style={"background_color": "#ffee00"})
    assert ((highlighted[:, :, 0] > 240) & (highlighted[:, :, 1] > 220) & (highlighted[:, :, 2] < 40)).sum() > 200


def test_alignment_uppercase_and_line_spacing():
    long_text = "Wonderful weather we have today! Yes"
    narrow = (0.3, 0.1, 0.7, 0.9)

    def line_starts(arr):
        ink = _ink(arr)
        rows = ink.any(axis=1)
        starts, begin = [], None
        for y, has in enumerate(list(rows) + [False]):
            if has and begin is None:
                begin = y
            elif not has and begin is not None:
                starts.append(int(np.nonzero(ink[begin:y].any(axis=0))[0].min()))
                begin = None
        return starts

    left = line_starts(_render(long_text, {"align": "left"}, box=narrow))
    assert len(left) >= 3 and max(left) - min(left) <= 2
    center = line_starts(_render(long_text, {"align": "center"}, box=narrow))
    assert max(center) - min(center) > 5

    assert (_render("abc def", {"uppercase": True}) == _render("ABC DEF")).all()
    assert (_render("ABC def", {"uppercase": False}) == _render("ABC def")).all()

    tight = _extent(_ink(_render(long_text, {"line_spacing": 0.8, "font_size": 16}, box=narrow)))
    loose = _extent(_ink(_render(long_text, {"line_spacing": 1.8, "font_size": 16}, box=narrow)))
    assert (loose[3] - loose[1]) > (tight[3] - tight[1]) * 1.3


def test_text_area_limits_how_much_of_the_box_the_text_may_use():
    from dataclasses import replace

    text = "This is quite a lot of text to fit into the box"
    roomy = replace(BASE_RENDERING, max_font_size=60)  # so the box, not the global size cap, is the limit
    full = _extent(_ink(_render(text, rendering=roomy)))
    half = _extent(_ink(_render(text, {"text_area": 50}, rendering=roomy)))
    box_w = 0.8 * 400
    assert (half[2] - half[0]) <= box_w * 0.5 + 2  # never wider than half the box
    assert (full[2] - full[0]) > (half[2] - half[0]) * 1.4  # while without it the text fills much more of it


def test_offset_moves_the_text_block_and_stays_inside_the_box():
    text = "Short text"
    centre = _extent(_ink(_render(text, {"text_area": 50})))
    right = _extent(_ink(_render(text, {"text_area": 50, "offset_x": 25})))
    assert right[0] > centre[0] + 40  # moved right by about 25% of the 320px box
    far_right = _extent(_ink(_render(text, {"text_area": 50, "offset_x": 50})))
    assert far_right[2] <= 360 + 1  # clamped: never past the box's right edge (x = 0.9 * 400)
    up = _extent(_ink(_render(text, {"text_area": 50, "offset_y": -25})))
    assert up[1] < centre[1] - 30


def test_rotation_turns_the_text_and_never_leaves_the_box():
    text = "Rotated words in a box"
    flat = _extent(_ink(_render(text)))
    quarter = _extent(_ink(_render(text, {"rotation": 90})))
    assert (quarter[3] - quarter[1]) > (quarter[2] - quarter[0])  # now taller than wide
    assert (flat[2] - flat[0]) > (flat[3] - flat[1])  # while unrotated text is wider than tall
    left, top, right, bottom = 40, 30, 360, 270
    for angle in (90, -90, 30, -30, 45, 180, 135):
        ink = _extent(_ink(_render(text, {"rotation": angle})))
        assert ink[0] >= left - 1 and ink[1] >= top - 1 and ink[2] <= right + 1 and ink[3] <= bottom + 1, angle
    # Opposite angles are mirror images about the box centre, not the same picture.
    assert not (_render(text, {"rotation": 30}) == _render(text, {"rotation": -30})).all()


def test_rotation_direction_is_clockwise_for_positive_angles():
    arr = _render("MMMMMMMM", {"rotation": 30, "font_size": 24})
    ys, xs = np.nonzero(_ink(arr))
    slope = np.polyfit(xs, ys, 1)[0]  # image y grows downward: clockwise rotation makes y increase with x
    assert slope > 0.3


def test_vertical_stacks_the_characters_in_one_column():
    horizontal = _extent(_ink(_render("ABCD")))
    vertical = _extent(_ink(_render("ABCD", {"vertical": True})))
    assert (vertical[3] - vertical[1]) > (vertical[2] - vertical[0]) * 2
    assert (horizontal[2] - horizontal[0]) > (horizontal[3] - horizontal[1])


def test_a_font_pack_changes_the_glyphs_and_an_unknown_one_falls_back_to_the_default():
    default = _render()
    comicka = _render(style={"font": "Comicka"})
    assert not (default == comicka).all()
    unknown = _render(style={"font": "No Such Pack"})
    assert (unknown == default).all()
    traversal = _render(style={"font": "../fonts/Comicka"})
    assert (traversal == default).all()


def test_only_the_styled_region_changes():
    page = _page()
    two = [((0.05, 0.05, 0.45, 0.45), "Left one"), ((0.55, 0.55, 0.95, 0.95), "Right one", {"text_color": "#c80000", "rotation": 20})]
    both = np.array(render_regions(page, two, FONT_DIR, BASE_RENDERING, fonts_base_dir=FONTS).convert("RGB"))
    plain = np.array(render_regions(page, [(two[0][0], "Left one"), (two[1][0], "Right one")], FONT_DIR, BASE_RENDERING, fonts_base_dir=FONTS).convert("RGB"))
    assert (both[:150, :200] == plain[:150, :200]).all()  # the unstyled region is untouched
    assert not (both[150:, 200:] == plain[150:, 200:]).all()


def test_a_style_can_override_a_global_lettering_choice():
    upper_global = RenderingConfig(font_dir=FONT_DIR, min_font_size=10, max_font_size=22, supersampling_factor=1, uppercase=True, text_align="left")
    forced_lower = _render("mixed case", {"uppercase": False}, rendering=upper_global)
    assert (forced_lower == _render("mixed case")).all()
    assert not (_render("mixed case", rendering=upper_global) == forced_lower).all()


def test_supersampling_still_works_with_a_rotated_styled_region():
    supersampled = RenderingConfig(font_dir=FONT_DIR, min_font_size=10, max_font_size=22, supersampling_factor=3)
    arr = _render("Rotated and sharp", {"rotation": 25, "text_color": "#000000"}, rendering=supersampled)
    ink = _extent(_ink(arr))
    assert ink[0] >= 40 - 1 and ink[2] <= 360 + 1 and ink[1] >= 30 - 1 and ink[3] <= 270 + 1


# ---------------------------------------------------------------------------
# the /region/render route
# ---------------------------------------------------------------------------
OPTS = {"provider": "Google", "input_language": "Japanese", "output_language": "English"}


def _b64(img):
    from core.manual_region import encode_png
    return encode_png(img)


def test_the_route_passes_each_regions_style_and_ignores_the_style_of_restore_only_regions(monkeypatch):
    import endpoints.regions as regions

    seen = {}

    def fake_render(base, draw_regions, font_dir, rendering, use_lama=False, lama_manga=False, fonts_base_dir=None, warnings=None):
        seen["regions"] = draw_regions
        seen["fonts_base_dir"] = fonts_base_dir
        return base

    monkeypatch.setattr(regions, "render_regions", fake_render)
    box = {"x1": 0.1, "y1": 0.1, "x2": 0.6, "y2": 0.6}
    resp = client.post("/region/render", json={
        **OPTS, "image": _b64(Image.new("RGB", (60, 60))), "source_image": _b64(Image.new("RGB", (60, 60))),
        "regions": [
            {"box": box, "text": "styled", "style": {"font": "Comicka", "font_size": 24, "rotation": 15, "text_color": "#112233", "vertical": True}},
            {"box": box, "text": "plain"},
            {"box": box, "restore_only": True, "style": {"rotation": 90}},
        ],
    })
    assert resp.status_code == 200, resp.text
    styled, plain = seen["regions"]  # the restore-only region is not drawn at all
    assert styled[1] == "styled" and styled[2] == {
        "font": "Comicka", "font_size": 24.0, "rotation": 15.0, "text_color": "#112233", "vertical": True, "offset_x": 0.0, "offset_y": 0.0,
    }
    assert plain[1] == "plain" and plain[2] is None
    assert seen["fonts_base_dir"] == settings.fonts_base_dir


@pytest.mark.parametrize("bad_style", [
    {"text_color": "red"}, {"text_color": "#12345"}, {"font_size": 0}, {"font_size": 9999}, {"rotation": 400},
    {"align": "justify"}, {"offset_x": 80}, {"text_area": 5}, {"line_spacing": 9}, {"outline_width": -1}, {"font": "x" * 200},
])
def test_the_route_rejects_out_of_range_styles(bad_style):
    resp = client.post("/region/render", json={
        **OPTS, "image": _b64(Image.new("RGB", (60, 60))),
        "regions": [{"box": {"x1": 0.1, "y1": 0.1, "x2": 0.6, "y2": 0.6}, "text": "x", "style": bad_style}],
    })
    assert resp.status_code == 422, bad_style


def test_end_to_end_the_route_draws_a_styled_region_differently():
    body = {**OPTS, "image": _b64(_page()), "supersampling_factor": 1}
    box = {"x1": 0.1, "y1": 0.1, "x2": 0.9, "y2": 0.9}
    plain = client.post("/region/render", json={**body, "regions": [{"box": box, "text": "Hello there"}]})
    styled = client.post("/region/render", json={**body, "regions": [{"box": box, "text": "Hello there", "style": {"text_color": "#dc0000", "rotation": 20, "font": "Comicka"}}]})
    assert plain.status_code == 200 and styled.status_code == 200
    assert plain.json()["image"] != styled.json()["image"]


# ---------------------------------------------------------------------------
# a font without the glyphs: reported, not silently dropped
# ---------------------------------------------------------------------------
VIETNAMESE = "Xin chào, bạn khoẻ không?"


def test_missing_glyphs_are_reported_per_region_with_the_font_and_the_characters():
    warnings: list = []
    regions = [
        ((0.05, 0.05, 0.45, 0.45), VIETNAMESE),  # Roboto covers Vietnamese
        ((0.55, 0.55, 0.95, 0.95), VIETNAMESE, {"font": "Comicka"}),  # Comicka does not
        ((0.05, 0.55, 0.45, 0.95), "plain ascii", {"font": "Comicka"}),
    ]
    render_regions(_page(), regions, FONT_DIR, BASE_RENDERING, fonts_base_dir=FONTS, warnings=warnings)
    assert len(warnings) == 1
    warning = warnings[0]
    assert warning["region"] == 1 and warning["code"] == "font_missing_glyphs" and warning["font"] == "Comicka"
    assert set(warning["chars"]) >= set("àạẻ") and " " not in warning["chars"] and len(set(warning["chars"])) == len(warning["chars"])


def test_uppercase_is_taken_into_account_when_checking_glyphs():
    # "ß" has no upper-case glyph in many fonts, but the check must look at what will actually be drawn.
    warnings: list = []
    render_regions(_page(), [((0.1, 0.1, 0.9, 0.9), "abc", {"uppercase": True})], FONT_DIR, BASE_RENDERING, fonts_base_dir=FONTS, warnings=warnings)
    assert warnings == []


def test_the_route_returns_the_warnings():
    box = {"x1": 0.1, "y1": 0.1, "x2": 0.9, "y2": 0.9}
    body = {**OPTS, "image": _b64(_page()), "supersampling_factor": 1}
    resp = client.post("/region/render", json={**body, "regions": [{"box": box, "text": VIETNAMESE, "style": {"font": "Comicka"}}]})
    assert resp.status_code == 200, resp.text
    (warning,) = resp.json()["warnings"]
    assert warning["region"] == 0 and warning["code"] == "font_missing_glyphs" and warning["font"] == "Comicka" and "à" in warning["chars"]
    clean = client.post("/region/render", json={**body, "regions": [{"box": box, "text": VIETNAMESE}]})
    assert clean.json()["warnings"] == []
