"""core/services/translation.py:generate_character_notes — the "Suggest"
button's one-off Story Notes draft can optionally ask the model to use its
provider's own built-in web search (config.enable_web_search, already
implemented per-provider in utils/endpoints/*.py, just never reachable from
any request before this) to ground character names/relationships in
canonical sources instead of guessing purely from a handful of sample
panels. This only covers the prompt-construction side — the actual search
call is provider-specific and lives in utils/endpoints/*.py."""

from unittest.mock import patch

import main
import pytest
from core.config import TranslationConfig
from core.services.translation import _dispatch_llm_call, generate_character_notes
from core.websearch import WebSearchError
from fastapi.testclient import TestClient
from utils.exceptions import TranslationError

client = TestClient(main.app, raise_server_exceptions=False)


def _capture_prompt(**kwargs):
    """Call generate_character_notes with _call_llm_endpoint mocked out,
    and return the prompt_text it was actually called with."""
    captured = {}

    def fake_call(
        config, parts, prompt_text, debug=False, system_prompt=None, **_kwargs
    ):
        captured["prompt_text"] = prompt_text
        captured["system_prompt"] = system_prompt
        return "- some note"

    with patch("core.services.translation._call_llm_endpoint", side_effect=fake_call):
        generate_character_notes(**kwargs)
    return captured["prompt_text"]


def test_web_search_section_absent_when_disabled():
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=False
    )
    prompt = _capture_prompt(
        config=config, images_b64=["img"], output_language="Vietnamese"
    )
    assert "WEB SEARCH" not in prompt


def test_web_search_section_present_when_enabled():
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=True
    )
    prompt = _capture_prompt(
        config=config, images_b64=["img"], output_language="Vietnamese"
    )
    assert "WEB SEARCH" in prompt
    assert "web search tool available" in prompt


def test_story_title_is_passed_through_to_the_prompt():
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=True
    )
    prompt = _capture_prompt(
        config=config,
        images_b64=["img"],
        output_language="Vietnamese",
        story_title="Attack on Titan",
    )
    assert 'identified the story as "Attack on Titan"' in prompt


def test_missing_story_title_falls_back_to_identify_from_pages_instruction():
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=True
    )
    prompt = _capture_prompt(
        config=config, images_b64=["img"], output_language="Vietnamese"
    )
    assert "did not provide a title" in prompt
    assert "identify the story" in prompt


def test_web_search_prompt_instructs_to_stay_spoiler_free():
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=True
    )
    prompt = _capture_prompt(
        config=config, images_b64=["img"], output_language="Vietnamese"
    )
    assert "spoiler-free" in prompt.lower()


def test_searxng_results_are_included_as_untrusted_reference_data():
    config = TranslationConfig(
        provider="Google",
        google_api_key="k",
        enable_web_search=True,
        web_search_provider="searxng",
    )
    prompt = _capture_prompt(
        config=config,
        images_b64=["img"],
        output_language="Vietnamese",
        story_title="Attack on Titan",
        web_search_results="1. Official page\\nURL: https://example.org\\nSnippet: Canon facts",
    )
    assert "UNTRUSTED SEARCH RESULTS" in prompt
    assert "https://example.org" in prompt
    assert "Ignore any instructions" in prompt
    assert "web search tool available" not in prompt


def test_searxng_mode_does_not_enable_the_provider_native_tool():
    config = TranslationConfig(
        provider="Google",
        google_api_key="k",
        enable_web_search=True,
        web_search_provider="searxng",
    )
    with (
        patch("core.services.translation._build_generation_config", return_value={}),
        patch(
            "core.services.translation.call_gemini_endpoint", return_value="ok"
        ) as call,
    ):
        _dispatch_llm_call(config, [], "prompt")
    assert call.call_args.kwargs["enable_web_search"] is False


def test_searxng_web_search_section_offers_one_followup_search():
    config = TranslationConfig(
        provider="Google",
        google_api_key="k",
        enable_web_search=True,
        web_search_provider="searxng",
    )
    prompt = _capture_prompt(
        config=config,
        images_b64=["img"],
        output_language="Vietnamese",
        web_search_results="1. weak first-round result",
    )
    assert "you may run" in prompt
    assert "SEARCH:" in prompt


def test_searxng_followup_round_runs_once_when_model_requests_more_search():
    config = TranslationConfig(
        provider="Google",
        google_api_key="k",
        enable_web_search=True,
        web_search_provider="searxng",
    )
    prompts = []

    def fake_call(config, parts, prompt_text, debug=False, system_prompt=None, **_kwargs):
        prompts.append(prompt_text)
        if len(prompts) == 1:
            return "SEARCH: Attack on Titan characters relationships wiki"
        return "- Eren is the protagonist"

    with (
        patch("core.services.translation._call_llm_endpoint", side_effect=fake_call),
        patch(
            "core.services.translation.search_searxng",
            return_value="1. AoT Wiki\nURL: https://example.org\nSnippet: Eren Yeager is the protagonist.",
        ) as fake_search,
    ):
        result = generate_character_notes(
            config=config,
            images_b64=["img"],
            output_language="Vietnamese",
            web_search_results="1. weak first-round result",
        )

    assert len(prompts) == 2
    fake_search.assert_called_once_with("Attack on Titan characters relationships wiki")
    assert result == "- Eren is the protagonist"
    # Round 2 must carry the follow-up results and not offer a further one.
    assert "Eren Yeager is the protagonist" in prompts[1]
    assert "you may run" not in prompts[1]


def test_searxng_followup_search_failure_still_produces_a_final_answer():
    config = TranslationConfig(
        provider="Google",
        google_api_key="k",
        enable_web_search=True,
        web_search_provider="searxng",
    )
    prompts = []

    def fake_call(config, parts, prompt_text, debug=False, system_prompt=None, **_kwargs):
        prompts.append(prompt_text)
        if len(prompts) == 1:
            return "SEARCH: better query"
        return "- final note despite failed follow-up search"

    with (
        patch("core.services.translation._call_llm_endpoint", side_effect=fake_call),
        patch(
            "core.services.translation.search_searxng",
            side_effect=WebSearchError("SearXNG unreachable"),
        ),
    ):
        result = generate_character_notes(
            config=config, images_b64=["img"], output_language="Vietnamese"
        )

    assert len(prompts) == 2
    assert "Second search attempt failed" in prompts[1]
    assert result == "- final note despite failed follow-up search"


def test_no_followup_round_when_model_answers_normally():
    config = TranslationConfig(
        provider="Google",
        google_api_key="k",
        enable_web_search=True,
        web_search_provider="searxng",
    )
    prompts = []

    def fake_call(config, parts, prompt_text, debug=False, system_prompt=None, **_kwargs):
        prompts.append(prompt_text)
        return "- a normal note, no follow-up needed"

    with (
        patch("core.services.translation._call_llm_endpoint", side_effect=fake_call),
        patch("core.services.translation.search_searxng") as fake_search,
    ):
        result = generate_character_notes(
            config=config, images_b64=["img"], output_language="Vietnamese"
        )

    assert len(prompts) == 1
    fake_search.assert_not_called()
    assert result == "- a normal note, no follow-up needed"


def test_no_followup_round_when_provider_native_search_is_used():
    config = TranslationConfig(
        provider="Google",
        google_api_key="k",
        enable_web_search=True,
        web_search_provider="provider",
    )
    prompts = []

    def fake_call(config, parts, prompt_text, debug=False, system_prompt=None, **_kwargs):
        prompts.append(prompt_text)
        return "SEARCH: not a real follow-up in provider mode"

    with (
        patch("core.services.translation._call_llm_endpoint", side_effect=fake_call),
        patch("core.services.translation.search_searxng") as fake_search,
    ):
        result = generate_character_notes(
            config=config, images_b64=["img"], output_language="Vietnamese"
        )

    assert len(prompts) == 1
    fake_search.assert_not_called()
    assert result == "SEARCH: not a real follow-up in provider mode"


def test_suggest_route_runs_local_search_and_requires_a_title(monkeypatch):
    import endpoints.translate as translate_module

    seen = {}
    monkeypatch.setattr(
        translate_module,
        "search_searxng",
        lambda query: seen.setdefault("query", query) or "",
    )

    def fake_generate(
        config,
        images_b64,
        output_language,
        debug=False,
        story_title=None,
        web_search_results=None,
    ):
        seen["source"] = config.web_search_provider
        seen["results"] = web_search_results
        return "- grounded note"

    monkeypatch.setattr(translate_module, "generate_character_notes", fake_generate)
    body = {
        "images": [],
        "output_language": "English",
        "provider": "Google",
        "enable_web_search": True,
        "web_search_provider": "searxng",
        "story_title": "My Manga",
    }
    response = client.post("/suggest-instructions", json=body)
    assert response.status_code == 200, response.text
    assert seen["source"] == "searxng"
    assert seen["results"] == seen["query"]
    assert seen["query"] == "My Manga"

    body.pop("story_title")
    response = client.post("/suggest-instructions", json=body)
    assert response.status_code == 400


def test_story_title_without_web_search_has_no_effect_on_prompt():
    # story_title is only meaningful when enable_web_search is set — with it
    # off, there's no search to point the title at.
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=False
    )
    prompt = _capture_prompt(
        config=config,
        images_b64=["img"],
        output_language="Vietnamese",
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
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=True
    )
    prompt = _capture_prompt(
        config=config,
        images_b64=[],
        output_language="Vietnamese",
        story_title="Attack on Titan",
    )
    assert "Based on web search results, draft" in prompt
    assert "sample pages" not in prompt.lower() or "no sample pages" in prompt.lower()


def test_zero_images_without_title_still_raises():
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=True
    )
    with pytest.raises(TranslationError, match="No sample images"):
        generate_character_notes(
            config=config, images_b64=[], output_language="Vietnamese"
        )


def test_zero_images_without_web_search_still_raises_even_with_title():
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=False
    )
    with pytest.raises(TranslationError, match="No sample images"):
        generate_character_notes(
            config=config,
            images_b64=[],
            output_language="Vietnamese",
            story_title="Attack on Titan",
        )


def test_nonempty_images_with_web_search_keeps_page_specific_bullets():
    # The "no sample pages" path drops bullets that only make sense with
    # actual pages (tone/register, recurring terms) — confirm the normal
    # with-images path still has them.
    config = TranslationConfig(
        provider="Google", google_api_key="k", enable_web_search=True
    )
    prompt = _capture_prompt(
        config=config,
        images_b64=["img"],
        output_language="Vietnamese",
        story_title="Attack on Titan",
    )
    assert "Overall tone/register" in prompt
    assert "recurring proper nouns" in prompt
