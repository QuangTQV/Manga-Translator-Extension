"""core/services/translation.py: a real production bug where translated
text ended up rendered into the WRONG bubble/panel — e.g. a caption box's
line from panel 1 rendered inside panel 3's caption box instead, while
panel 3's own line ended up elsewhere. Every individual translated string
was accurate, just attached to the wrong numbered crop.

Root cause (confirmed by reading the actual pipeline): the backend's
crop-to-bubble ordering and response-parsing are both correct and
self-consistent — the bug is the LLM itself misreporting which numbered
item a piece of text belongs to. Plain rectangular narration/caption boxes
look nearly identical across different panels (unlike speech bubbles,
which have distinctive tails), and the existing "Cohesion: treat as a
continuous narrative" instruction — reinforced by "refer to the full-page
image" when full_page_context is on — encourages holistic reasoning that
can cause the model to source a line from wherever it fits the story best,
rather than strictly from the crop numbered i. There is no independent
verification step, so a mislabeled index silently overwrites another
bubble's slot with no detection.

The fix adds an explicit "Index Integrity" rule clarifying that cohesion
governs tone/flow only, never which numbered item a line is attached to,
and specifically calls out the look-alike-caption-box confusion."""
from core.services.translation import _build_system_prompt_translation


def test_index_integrity_rule_is_present():
    prompt = _build_system_prompt_translation(
        output_language="English", mode="one-step", reading_direction="rtl"
    )
    assert "Index Integrity" in prompt
    assert "never from a similar-looking line you recall from a different crop" in prompt


def test_index_integrity_rule_present_regardless_of_full_page_context():
    # The confusion isn't unique to full_page_context=True (that only adds
    # a stronger pull toward holistic reasoning) — the rule must guard
    # against it either way.
    without_context = _build_system_prompt_translation(
        output_language="English", mode="one-step", reading_direction="rtl",
        full_page_context=False,
    )
    with_context = _build_system_prompt_translation(
        output_language="English", mode="one-step", reading_direction="rtl",
        full_page_context=True,
    )
    assert "Index Integrity" in without_context
    assert "Index Integrity" in with_context


def test_index_integrity_rule_present_in_two_step_mode_too():
    prompt = _build_system_prompt_translation(
        output_language="Japanese", mode="two-step", reading_direction="ltr"
    )
    assert "Index Integrity" in prompt
