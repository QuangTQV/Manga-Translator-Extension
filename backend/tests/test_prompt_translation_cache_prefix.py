"""core/services/translation.py:_build_system_prompt_translation — the
target-language name used to be interpolated into the second sentence of
the prompt (the OBJECTIVE section, near the very start), so two requests
that differ only in output_language diverged after just ~160 characters.
Providers that cache by exact prefix match (OpenAI/Gemini/DeepSeek
automatic prefix caching) then couldn't share the ~2.6KB of identical
STYLING GUIDE/CORE RULES content that follows for different target
languages — relevant on a hosted deployment serving many users with
different target languages through one shared key, or a single user who
translates different series into different languages.

output_language now only appears in the OUTPUT SCHEMA section, near the
end (already-unconditional format-example lines), so unrelated languages
share almost the entire prompt as a prefix; only this is tested — the
actual wording changes are already covered by other prompt-content tests
(test_pronoun_prompt.py, test_index_integrity_prompt.py).
"""
from core.services.translation import _build_system_prompt_translation


def _shared_prefix_len(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def test_non_vietnamese_output_languages_share_almost_the_whole_prompt_as_a_prefix():
    en = _build_system_prompt_translation(output_language="English", mode="one-step", reading_direction="rtl")
    es = _build_system_prompt_translation(output_language="Spanish", mode="one-step", reading_direction="rtl")
    fr = _build_system_prompt_translation(output_language="French", mode="one-step", reading_direction="rtl")

    # Previously this was ~160/2844 chars (~6%) — the target-language name
    # used to sit in the prompt's second sentence. Should now be the bulk
    # of the prompt: only the OUTPUT SCHEMA's format-example line (where
    # the model needs the language to understand what to output) differs.
    assert _shared_prefix_len(en, es) / len(en) > 0.9
    assert _shared_prefix_len(en, fr) / len(en) > 0.9


def test_the_objective_section_no_longer_names_the_target_language():
    # Guards the actual fix, not just its effect: the language name must
    # come from the OUTPUT SCHEMA section (format-example lines), not be
    # re-added to the early OBJECTIVE sentence by a future edit.
    prompt = _build_system_prompt_translation(output_language="English", mode="one-step", reading_direction="rtl")
    objective_section = prompt.split("## STYLING GUIDE")[0]
    assert "English" not in objective_section


def test_two_step_mode_still_names_the_target_language_in_the_output_schema():
    prompt = _build_system_prompt_translation(output_language="German", mode="two-step", reading_direction="rtl")
    assert "<translated German text>" in prompt
