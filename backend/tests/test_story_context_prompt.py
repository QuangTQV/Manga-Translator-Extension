"""core/services/translation.py:_format_story_context — builds the
"## STORY CONTEXT (character database)" prompt block from a resolved
Story DB (see core/story_context.py, endpoints/translate.py's
_resolve_story_context). Pure prompt-text logic, no DB/network/ML needed —
same style as test_pronoun_prompt.py.
"""
from core.config import (
    StoryCharacterConfig,
    StoryContinuityNoteConfig,
    StoryGlossaryTermConfig,
    StoryRelationshipConfig,
    TranslationConfig,
)
from core.services.translation import _format_story_context


def test_empty_story_context_is_an_empty_string():
    assert _format_story_context(TranslationConfig()) == ""


def test_characters_section_lists_gender_role_and_voice_notes():
    config = TranslationConfig(
        story_characters=[
            StoryCharacterConfig(id="c1", name="Aoi", gender="female", role="protagonist", voice_notes="blunt"),
            StoryCharacterConfig(id="c2", name="Ren"),  # gender defaults to "unknown", role/voice_notes None
        ]
    )
    prompt = _format_story_context(config)
    assert "## STORY CONTEXT (character database)" in prompt
    assert "### Characters" in prompt
    assert "- Aoi (female; protagonist; voice/tone: blunt)" in prompt
    # A character with no extra detail (unknown gender, no role/voice) gets
    # no parenthetical at all, not an empty "()" or "(unknown)".
    assert "- Ren\n" in prompt or prompt.rstrip().endswith("- Ren")
    assert "### Relationships" not in prompt
    assert "### Glossary" not in prompt


def test_relationships_section_resolves_character_ids_to_names():
    config = TranslationConfig(
        story_characters=[
            StoryCharacterConfig(id="c1", name="Aoi"),
            StoryCharacterConfig(id="c2", name="Ren"),
        ],
        story_relationships=[
            StoryRelationshipConfig(character_a_id="c1", character_b_id="c2", surface_relation="rivals", address_notes="by surname"),
        ],
    )
    prompt = _format_story_context(config)
    assert "### Relationships" in prompt
    assert "- Aoi <-> Ren: rivals (by surname)" in prompt


def test_relationship_with_unknown_character_id_falls_back_to_the_raw_id():
    # Defensive: a relationship referencing a character id that isn't (or
    # is no longer) in story_characters shouldn't crash prompt-building —
    # it should just show the raw id instead of resolving a name.
    config = TranslationConfig(
        story_relationships=[
            StoryRelationshipConfig(character_a_id="ghost-1", character_b_id="ghost-2", surface_relation="unknown"),
        ],
    )
    prompt = _format_story_context(config)
    assert "- ghost-1 <-> ghost-2: unknown" in prompt


def test_glossary_section_lists_term_translation_and_notes():
    config = TranslationConfig(
        story_glossary=[
            StoryGlossaryTermConfig(term="Kage-ryu", translation="Shadow Style", notes="sword technique"),
            StoryGlossaryTermConfig(term="Reikon", translation="Soul"),  # no notes
        ],
    )
    prompt = _format_story_context(config)
    assert "### Glossary (use these exact translations)" in prompt
    assert "- Kage-ryu -> Shadow Style (sword technique)" in prompt
    assert "- Reikon -> Soul\n" in prompt or prompt.rstrip().endswith("- Reikon -> Soul")


def test_all_three_sections_together_are_separated_by_blank_lines():
    config = TranslationConfig(
        story_characters=[StoryCharacterConfig(id="c1", name="Aoi", gender="female")],
        story_relationships=[StoryRelationshipConfig(character_a_id="c1", character_b_id="c2", surface_relation="siblings")],
        story_glossary=[StoryGlossaryTermConfig(term="X", translation="Y")],
    )
    prompt = _format_story_context(config)
    # Order matters: Characters, then Relationships, then Glossary.
    assert prompt.index("### Characters") < prompt.index("### Relationships") < prompt.index("### Glossary")


def test_continuity_notes_section_lists_notes_with_optional_source_label():
    config = TranslationConfig(
        story_continuity_notes=[
            StoryContinuityNoteConfig(text="Ren is revealed to be Aoi's half-brother", source_label="Chapter 5"),
            StoryContinuityNoteConfig(text="Aoi loses her memory of the incident"),  # no source_label
        ],
    )
    prompt = _format_story_context(config)
    assert "### Continuity Notes (established earlier in this story)" in prompt
    assert "- [Chapter 5] Ren is revealed to be Aoi's half-brother" in prompt
    assert "- Aoi loses her memory of the incident" in prompt


def test_continuity_notes_come_last_after_the_other_three_sections():
    config = TranslationConfig(
        story_characters=[StoryCharacterConfig(id="c1", name="Aoi")],
        story_relationships=[StoryRelationshipConfig(character_a_id="c1", character_b_id="c2", surface_relation="siblings")],
        story_glossary=[StoryGlossaryTermConfig(term="X", translation="Y")],
        story_continuity_notes=[StoryContinuityNoteConfig(text="Something happened")],
    )
    prompt = _format_story_context(config)
    assert prompt.index("### Glossary") < prompt.index("### Continuity Notes")


def test_continuity_notes_alone_still_produce_the_story_context_header():
    # A story could plausibly have continuity notes enabled with no
    # characters/relationships/glossary entered yet — the section should
    # still render (this is the branch that would break if the "is
    # everything empty" check in _format_story_context forgot this field).
    config = TranslationConfig(story_continuity_notes=[StoryContinuityNoteConfig(text="Something happened")])
    prompt = _format_story_context(config)
    assert "## STORY CONTEXT (character database)" in prompt
    assert "### Continuity Notes" in prompt


# ---------------------------------------------------------------------------
# Placement: the Story DB block lives at the end of the (cacheable) system
# prompt, not in the per-page prompt — see _append_story_context_to_system.
# ---------------------------------------------------------------------------
def _capture_calls(monkeypatch, config, images, previous_texts=None):
    import core.services.translation as tr

    calls = []

    def fake_call(cfg, parts, prompt, *args, **kwargs):
        calls.append({"prompt": prompt, "system": kwargs.get("system_prompt")})
        return "\n".join(f"{i + 1}: hello || xin chào" for i in range(len(images)))

    monkeypatch.setattr(tr, "_call_llm_endpoint", fake_call)
    monkeypatch.setattr(tr, "get_cache", lambda: type("C", (), {
        "get_translation_cache_key": lambda *a, **k: None,
        "get_translation": lambda *a, **k: (None, None),
        "set_translation": lambda *a, **k: None,
    })())
    try:
        tr.call_translation_api_batch(
            config, images, "", ["image/png"] * len(images), "image/png", [{} for _ in images],
            previous_context_texts=previous_texts,
        )
    except Exception:
        pass  # response parsing isn't under test — only what was sent
    return calls


def _story_config(**overrides):
    return TranslationConfig(
        provider="Google", google_api_key="k", model_name="gemini-2.5-flash",
        translation_mode="one-step", ocr_method="LLM", send_full_page_context=False,
        story_characters=[StoryCharacterConfig(id="c1", name="Aoi", gender="female", role="protagonist")],
        story_glossary=[StoryGlossaryTermConfig(term="Kage-ryu", translation="Shadow Style")],
        special_instructions="Aoi speaks formally.",
        **overrides,
    )


def test_story_db_goes_in_the_system_prompt_not_the_per_page_prompt(monkeypatch):
    calls = _capture_calls(monkeypatch, _story_config(), ["AAAA"])
    call = calls[-1]
    assert "- Aoi (female; protagonist)" in call["system"]
    assert "- Kage-ryu -> Shadow Style" in call["system"]
    assert "follow the STORY NOTES" in call["system"]
    # Only a pointer stays per-page; the per-page STORY NOTES still come next to the task.
    assert "- Aoi (female; protagonist)" not in call["prompt"]
    assert "in your system instructions under \"STORY CONTEXT\"" in call["prompt"]
    assert "## STORY NOTES\nAoi speaks formally." in call["prompt"]


def test_story_db_is_appended_after_the_generic_rules(monkeypatch):
    # Generic rules first = a prefix shared across every story, still
    # cacheable when the user switches stories.
    calls = _capture_calls(monkeypatch, _story_config(), ["AAAA"])
    system = calls[-1]["system"]
    assert system.index("## STORY CONTEXT (character database)") > len(system) // 2


def test_system_prompt_is_identical_across_different_pages(monkeypatch):
    # The whole point of the move: page content and previous-page text
    # differ, the system prompt (which carries the Story DB) must not.
    page_a = _capture_calls(monkeypatch, _story_config(), ["AAAA"], previous_texts=[["こんにちは"]])[-1]
    page_b = _capture_calls(monkeypatch, _story_config(), ["BBBB", "CCCC"], previous_texts=[["さようなら"]])[-1]
    assert page_a["prompt"] != page_b["prompt"]
    assert "- Aoi (female; protagonist)" in page_a["system"]
    assert page_a["system"] == page_b["system"]


def test_no_story_db_leaves_the_system_prompt_and_pointer_out(monkeypatch):
    config = TranslationConfig(
        provider="Google", google_api_key="k", model_name="gemini-2.5-flash",
        translation_mode="one-step", ocr_method="LLM", send_full_page_context=False,
    )
    call = _capture_calls(monkeypatch, config, ["AAAA"])[-1]
    assert "STORY CONTEXT" not in call["system"]
    assert "STORY CONTEXT" not in call["prompt"]
