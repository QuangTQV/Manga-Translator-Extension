"""Vietnamese-localization rules must work with free-form language labels."""

from core.services.translation import (
    _build_system_prompt_translation,
    _is_vietnamese_output,
)


def test_native_vietnamese_label_enables_pronoun_rules():
    assert _is_vietnamese_output("Tiếng Việt")

    prompt = _build_system_prompt_translation(
        output_language="Tiếng Việt",
        mode="one-step",
        reading_direction="rtl",
    )

    assert "Vietnamese Pronouns (xưng hô)" in prompt
    assert "PRONOUN MAP:" in prompt


def test_non_vietnamese_label_does_not_enable_pronoun_rules():
    assert not _is_vietnamese_output("English")
