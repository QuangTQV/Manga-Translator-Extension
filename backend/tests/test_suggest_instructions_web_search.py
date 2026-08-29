"""core/services/translation.py:generate_character_notes — the "Suggest"
button's one-off Story Notes draft can optionally ask the model to use its
provider's own built-in web search (config.enable_web_search, already
implemented per-provider in utils/endpoints/*.py, just never reachable from
any request before this) to ground character names/relationships in
canonical sources instead of guessing purely from a handful of sample
panels. This only covers the prompt-construction side — the actual search
call is provider-specific and lives in utils/endpoints/*.py."""
from unittest.mock import patch

import pytest

from core.config import TranslationConfig
from core.services.translation import generate_character_notes
from utils.exceptions import TranslationError


def _capture_prompt(**kwargs):
    """Call generate_character_notes with _call_llm_endpoint mocked out,
    and return the prompt_text it was actually called with."""
    captured = {}

    def fake_call(config, parts, prompt_text, debug=False, system_prompt=None):
        captured["prompt_text"] = prompt_text
        captured["system_prompt"] = system_prompt
        return "- some note"

    with patch("core.services.translation._call_llm_endpoint", side_effect=fake_call):
        generate_character_notes(**kwargs)
    return captured["prompt_text"]


def test_web_search_section_absent_when_disabled():
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=False)
    prompt = _capture_prompt(config=config, images_b64=["img"], output_language="Vietnamese")
    assert "WEB SEARCH" not in prompt


def test_web_search_section_present_when_enabled():
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=True)
    prompt = _capture_prompt(config=config, images_b64=["img"], output_language="Vietnamese")
    assert "WEB SEARCH" in prompt
    assert "web search tool available" in prompt


def test_story_title_is_passed_through_to_the_prompt():
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=True)
    prompt = _capture_prompt(
        config=config, images_b64=["img"], output_language="Vietnamese",
        story_title="Attack on Titan",
    )
    assert 'identified the story as "Attack on Titan"' in prompt


def test_missing_story_title_falls_back_to_identify_from_pages_instruction():
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=True)
    prompt = _capture_prompt(config=config, images_b64=["img"], output_language="Vietnamese")
    assert "did not provide a title" in prompt
    assert "identify the story" in prompt


def test_web_search_prompt_instructs_to_stay_spoiler_free():
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=True)
    prompt = _capture_prompt(config=config, images_b64=["img"], output_language="Vietnamese")
    assert "spoiler-free" in prompt.lower()


def test_story_title_without_web_search_has_no_effect_on_prompt():
    # story_title is only meaningful when enable_web_search is set — with it
    # off, there's no search to point the title at.
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=False)
    prompt = _capture_prompt(
        config=config, images_b64=["img"], output_language="Vietnamese",
        story_title="Attack on Titan",
    )
    assert "Attack on Titan" not in prompt
    assert "WEB SEARCH" not in prompt


# ---------------------------------------------------------------------------
# Zero sample images: only viable with both web search AND a title — search
# is the sole basis for the draft, so without a title there's nothing to
# search for, and without search there's nothing to look at at all.
# ---------------------------------------------------------------------------
def test_zero_images_allowed_with_web_search_and_title():
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=True)
    prompt = _capture_prompt(
        config=config, images_b64=[], output_language="Vietnamese",
        story_title="Attack on Titan",
    )
    assert "Based on web search results, draft" in prompt
    assert "sample pages" not in prompt.lower() or "no sample pages" in prompt.lower()


def test_zero_images_without_title_still_raises():
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=True)
    with pytest.raises(TranslationError, match="No sample images"):
        generate_character_notes(config=config, images_b64=[], output_language="Vietnamese")


def test_zero_images_without_web_search_still_raises_even_with_title():
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=False)
    with pytest.raises(TranslationError, match="No sample images"):
        generate_character_notes(
            config=config, images_b64=[], output_language="Vietnamese",
            story_title="Attack on Titan",
        )


def test_nonempty_images_with_web_search_keeps_page_specific_bullets():
    # The "no sample pages" path drops bullets that only make sense with
    # actual pages (tone/register, recurring terms) — confirm the normal
    # with-images path still has them.
    config = TranslationConfig(provider="Google", google_api_key="k", enable_web_search=True)
    prompt = _capture_prompt(
        config=config, images_b64=["img"], output_language="Vietnamese",
        story_title="Attack on Titan",
    )
    assert "Overall tone/register" in prompt
    assert "recurring proper nouns" in prompt
