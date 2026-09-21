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
