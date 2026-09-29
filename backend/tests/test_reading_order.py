from core.image.sorting import sort_bubbles_by_reading_order, sort_panels_by_reading_order


def test_bubble_order_respects_rtl_and_ltr_for_same_row():
    bubbles = [
        {"bbox": (700, 100, 780, 160), "id": "right"},
        {"bbox": (100, 100, 180, 160), "id": "left"},
    ]

    assert [b["id"] for b in sort_bubbles_by_reading_order(bubbles, "rtl")] == [
        "right",
        "left",
    ]
    assert [b["id"] for b in sort_bubbles_by_reading_order(bubbles, "ltr")] == [
        "left",
        "right",
    ]


def test_panel_order_respects_rtl_and_ltr_for_same_row():
    panels = [(700, 100, 1000, 500), (100, 100, 400, 500)]

    assert sort_panels_by_reading_order(panels, "rtl") == [0, 1]
    assert sort_panels_by_reading_order(panels, "ltr") == [1, 0]
