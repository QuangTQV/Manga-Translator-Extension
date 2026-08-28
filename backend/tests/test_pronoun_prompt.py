"""core/services/translation.py: Vietnamese xưng hô (pronoun) handling in
the translation system prompt. Covers three reported failure modes:

1. Model misjudges relationship age/gender from art alone (unreliable —
   manga art routinely draws characters years apart as the same age) —
   fixed by an explicit evidence-priority rule ranking dialogue-derived
   signals (address terms, source-language register) above the art.
2. PRONOUN MAP is decided fresh every page/batch and thrown away — even
   with Context Memory enabled, only a vague prose MEMORY NOTE carried
   forward, not the actual pair decisions — fixed by having the model
   echo established pairs into MEMORY NOTE as a parseable `XƯNG HÔ:` line
   and instructing later pages to reuse them.
3. The model over-defaults to "tôi"/"bạn" (stiff, stranger-register) for
   any relationship it isn't sure about — fixed by restricting "tôi"/"bạn"
   to two named cases and defaulting genuinely-unclear relationships to
   "cậu"/"tớ" instead.
"""
from core.services.translation import (
    _build_system_prompt_translation,
    _extract_memory_note,
)


def test_evidence_priority_rule_present_for_vietnamese_output():
    prompt = _build_system_prompt_translation(
        output_language="Vietnamese", mode="one-step", reading_direction="rtl"
    )
    assert "Evidence priority" in prompt
    assert "manga art is unreliable" in prompt


def test_evidence_priority_rule_absent_for_non_vietnamese_output():
    prompt = _build_system_prompt_translation(
        output_language="English", mode="one-step", reading_direction="rtl"
    )
    assert "Evidence priority" not in prompt
    assert "xưng hô" not in prompt.lower()


def test_unclear_relationship_defaults_to_casual_pair_not_toi_ban():
    prompt = _build_system_prompt_translation(
        output_language="Vietnamese", mode="one-step", reading_direction="rtl"
    )
    assert 'default to "cậu"/"tớ", NOT "tôi"/"bạn"' in prompt
    assert "reserved for the two named cases above" in prompt


def test_self_check_instruction_present_for_vietnamese():
    prompt = _build_system_prompt_translation(
        output_language="Vietnamese", mode="one-step", reading_direction="rtl"
    )
    assert "Before finalizing your answer" in prompt
    assert "re-scan every `[pair]`-tagged line" in prompt


def test_xung_ho_echo_requires_both_context_memory_and_vietnamese():
    both = _build_system_prompt_translation(
        output_language="Vietnamese",
        mode="one-step",
        reading_direction="rtl",
        context_memory_enabled=True,
    )
    assert "XƯNG HÔ:" in both

    no_context_memory = _build_system_prompt_translation(
        output_language="Vietnamese", mode="one-step", reading_direction="rtl",
        context_memory_enabled=False,
    )
    assert "XƯNG HÔ:" not in no_context_memory

    non_vietnamese = _build_system_prompt_translation(
        output_language="English",
        mode="one-step",
        reading_direction="rtl",
        context_memory_enabled=True,
    )
    assert "XƯNG HÔ:" not in non_vietnamese


def test_memory_note_extraction_captures_embedded_xung_ho_line():
    # What the model is now instructed to emit: a MEMORY NOTE sentence
    # immediately followed by an XƯNG HÔ sub-line on its own line.
    raw = (
        "1: original text || [em-anh] translated text\n"
        "MEMORY NOTE: Two classmates meet after school.\n"
        "XƯNG HÔ: - girl, short hair -> boy, glasses: em-anh"
    )
    remaining, note = _extract_memory_note(raw)
    assert "1: original text || [em-anh] translated text" in remaining
    assert "MEMORY NOTE" not in remaining
    assert "Two classmates meet after school." in note
    assert "XƯNG HÔ: - girl, short hair -> boy, glasses: em-anh" in note
