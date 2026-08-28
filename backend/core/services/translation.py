import base64
import json
import random
import re
import threading
import time
from dataclasses import replace
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image

from core.caching import get_cache
from core.config import TranslationConfig, calculate_reasoning_budget
from core.image.image_utils import cv2_to_pil, pil_to_cv2, process_bubble_image_cached
from core.image.ocr_detection import (
    extract_text_with_manga_ocr,
    extract_text_with_paddle_ocr_vl,
)
from utils.endpoints import (
    call_anthropic_endpoint,
    call_azure_openai_endpoint,
    call_deepseek_endpoint,
    call_gemini_endpoint,
    call_moonshot_endpoint,
    call_openai_compatible_endpoint,
    call_openai_endpoint,
    call_openrouter_endpoint,
    call_xai_endpoint,
    call_zai_endpoint,
    openrouter_is_reasoning_model,
)
from utils.exceptions import TranslationError
from utils.logging import log_message
from utils.model_metadata import (
    get_gpt5_generation,
    get_max_tokens_cap,
    is_46_model,
    is_anthropic_reasoning_model,
    is_deepseek_reasoning_model,
    is_gemini_25_flash_model,
    is_gemini_25_pro_model,
    is_gemma_model,
    is_gemini_3_model,
    is_google_reasoning_model,
    is_gpt5_chat_variant,
    is_gpt5_series,
    is_openai_compatible_reasoning_model,
    is_openai_model_family,
    supports_openai_original_image_detail,
)
from utils.model_metadata import is_openai_reasoning_model as _is_openai_reasoning_meta
from utils.model_metadata import (
    is_opus_45_model,
    is_opus_47_model,
    is_rosetta_model,
    is_xai_reasoning_model,
    is_zai_reasoning_model,
    supports_xai_reasoning_parameter,
)

TRANSLATION_PATTERN = re.compile(
    r'^\s*(\d+)\s*:\s*"?\s*(.*?)\s*"?\s*(?=\s*\n\s*\d+\s*:|\s*$)',
    re.MULTILINE | re.DOTALL,
)
OPENAI_COMPATIBLE_MAX_MEDIA_ITEMS = 10


def _build_system_prompt_ocr(
    input_language: Optional[str],
    reading_direction: str,
) -> str:
    is_auto_language = not input_language or input_language.strip().lower() == "auto"
    lang_label = "" if is_auto_language else f"{input_language} "
    direction = (
        "right-to-left"
        if (reading_direction or "rtl").lower() == "rtl"
        else "left-to-right"
    )

    return f"""
## ROLE
You are an expert manga OCR transcriber.

## OBJECTIVE
Your sole purpose is to accurately transcribe the original text from a series of provided images. You must not translate, interpret, or add commentary.

## CORE RULES
- **Reading Context:** The image crops are presented in a {direction} reading order. Do not reorder them.
- **Transcription Policy:** Preserve all original punctuation, ellipses, and casing. Collapse multi-line text into a single line, separated by a single space.
- **Ignore Policy:** Ignore all non-text visual elements (borders, tails, watermarks, etc.).
- **Language Focus:** Transcribe only the original {lang_label}text.{" Auto-detect the source language directly from the text itself — do not assume any particular language." if is_auto_language else ""}
- **Ruby/Furigana Policy:** If small phonetic characters (ruby/furigana) are present, you must ignore them and transcribe only the main, larger base text.
- **Visual Emphasis Policy:** If the source text is visually emphasized (bold, slanted, etc.), you must mirror that emphasis in your transcription using markdown-style markers: `*italic*` for slanted text, `**bold**` for bold text, `***bold-italic***` for both.
- **Quotes:** Do not wrap the transcribed text in quotation marks unless they are explicitly present in the image.
- **Edge Cases:**
  - If an image contains standalone periods/ellipses, you must return it exactly as it appears.
  - If text is indecipherable, you must return the exact token: `[OCR FAILED]`.

## OUTPUT SCHEMA
- You must return your response as a single numbered list with exactly one line per input image.
- The numbering must correspond to the input image order (1, 2, 3...).
- The format must be `i: <transcribed {lang_label}text>` where `i` is the input image number.
- Do not include section headers, explanations, or formatting outside of this list.
"""  # noqa


def _format_previous_context_prompt_note(
    previous_context_image_count: int,
    previous_context_text_count: int,
    image_order: str,
) -> str:
    has_images = previous_context_image_count > 0
    has_text = previous_context_text_count > 0

    if has_images and has_text:
        return (
            f" {previous_context_image_count} previous source page image(s) are "
            "attached as visual reference, and transcribed text from "
            f"{previous_context_text_count} previous source page(s) is provided "
            "in `## PREVIOUS PAGE TRANSCRIPTS`. Image order: "
            f"{image_order}. Use this previous-page context only as narrative "
            "reference; do not transcribe, translate, or renumber previous-page "
            "material."
        )

    if has_images:
        return (
            f" {previous_context_image_count} previous source page image(s) "
            f"are attached as reference. Image order: {image_order}."
        )

    if has_text:
        return (
            f" Transcribed text from {previous_context_text_count} previous "
            "source page(s) is provided in `## PREVIOUS PAGE TRANSCRIPTS` "
            "as narrative reference only — do not translate or renumber it."
        )

    return ""


def _build_system_prompt_translation(
    output_language: str,
    mode: str,
    reading_direction: str,
    full_page_context: bool = False,
    previous_context_image_count: int = 0,
    previous_context_text_count: int = 0,
    input_language: Optional[str] = None,
    context_memory_enabled: bool = False,
) -> str:
    direction = (
        "right-to-left"
        if (reading_direction or "rtl").lower() == "rtl"
        else "left-to-right"
    )
    input_type = "transcriptions" if mode == "two-step" else "image crops"

    if input_language and input_language.strip().lower() != "auto":
        source_language_rule = (
            f"- **Source Language:** The original text is in {input_language}."
        )
    else:
        source_language_rule = (
            "- **Source Language:** Auto-detect the original language directly "
            "from the text itself — do not assume any particular language."
        )

    cohesion_visual = (
        " Refer to the full-page image to resolve ambiguous context."
        if full_page_context
        else ""
    )

    if mode == "two-step":
        edge_cases = """- **Edge Cases:**
  - If an input line contains standalone periods/ellipses, you must return it exactly as it appears.
  - If an input line is the exact token `[OCR FAILED]`, you must output it unchanged."""
    else:
        edge_cases = """- **Edge Cases:**
  - If an image contains standalone periods/ellipses, you must return it exactly as it appears.
  - If text is indecipherable, you must return the exact token: `[OCR FAILED]`."""

    previous_context_rule = ""
    if previous_context_image_count > 0 and previous_context_text_count > 0:
        previous_context_rule = """
- **Previous Page Context:** Earlier source-page images and transcripts are visual/narrative context only; do not transcribe, translate, number, or count them. Use them to maintain consistency:
  - **Proper Nouns:** Keep character names, place names, organizations, technique/skill/title names, honorifics, and stylized terms consistent with established usage.
  - **Character Voice:** Preserve each character's established voice, register, and pronoun choices.
  - **Referents:** Disambiguate callbacks, ongoing beats, or unclear references using prior visuals and dialogue."""  # noqa
    elif previous_context_image_count > 0:
        previous_context_rule = """
- **Previous Page Reference:** Earlier source pages are visual/narrative context only — do not transcribe, translate, number, or count them. Use them to maintain consistency:
  - **Proper Nouns:** Keep character names, place names, organizations, technique/skill/title names, honorifics, and stylized terms spelled exactly as they appeared previously.
  - **Character Voice:** Preserve each character's established voice, register, and pronoun choices.
  - **Referents:** Disambiguate callbacks, ongoing beats, or unclear references using prior context."""  # noqa
    elif previous_context_text_count > 0:
        previous_context_rule = """
- **Previous Page Transcripts:** Earlier source-page transcribed text is provided as narrative context only — do not translate, number, or count it. Use it to maintain consistency:
  - **Proper Nouns:** Keep character names, place names, organizations, technique/skill/title names, honorifics, and stylized terms aligned with their established usage.
  - **Character Voice:** Preserve each character's established voice, register, and pronoun choices.
  - **Referents:** Disambiguate callbacks, ongoing beats, or unclear references using prior dialogue."""  # noqa

    vietnamese_pronoun_rule = ""
    if "vietnamese" in (output_language or "").lower():
        vietnamese_pronoun_rule = """
- **Vietnamese Pronouns (xưng hô):** Before translating any dialogue, work out for every distinct speaker-listener pair: (1) who is speaking, (2) who they're speaking to, (3) that pair's apparent age gap, gender, and relationship. Then pick ONE pronoun pair for that speaker-listener direction, write it down in the required `PRONOUN MAP:` section (see OUTPUT SCHEMA below), and reuse it for every line between them:
  - **Evidence priority — text over art:** manga art is unreliable for judging age/relationship — character designs routinely draw people who are actually years apart (senpai/kohai, siblings, teacher/student) as visually the same age, and a "young-looking" style can make every character look like a peer regardless of their real age. Rank evidence in this order and let a higher-ranked signal override a lower one when they conflict: (1) explicit address terms/honorifics used in the dialogue itself (-san/-chan/-kun/-senpai, name suffixes, family terms — see the override below), (2) source-language register — self-referential pronouns (e.g. Japanese ore/boku/watashi/atashi), sentence-final particles, keigo/politeness level, blunt vs. formal phrasing, (3) narrative/story context (established roles like teacher, senior, sibling), (4) apparent age/build from the art, used only as a tiebreaker when the above give no signal.
  - **Decisive override — family address terms:** if a line's own source text contains a family address term — "onii-chan"/"onii-san"/"aniki" (older brother), "onee-chan"/"onee-san" (older sister), "otouto" (younger brother), "imouto" (younger sister), or an English equivalent like "bro"/"sis"/"big brother"/"big sis" — that line's speaker-listener pair IS siblings, full stop. This overrides any guess about who the characters are from art or from a different panel's dialogue, even if a same-looking character elsewhere on the page seemed to be a classmate/stranger — a page can have several visually similar characters, and the address term in the line itself is stronger evidence than a cross-panel identity guess. Translate the address term itself as the real Vietnamese family term ("anh"/"chị"/"em"), not left as "onii-chan" untranslated.
  - Close friends, classmates, same apparent age, casual tone → "tớ"/"cậu" or "mình"/"cậu".
  - Very close friends, rivals, or rough/blunt speech → "tao"/"mày".
  - Noticeable age gap, romantic partners, or siblings → "anh"/"em" or "chị"/"em" (the older speaker says "anh"/"chị", the younger says "em").
  - Family members → the real family term ("con", "mẹ", "bố"/"ba", "ông", "bà", "anh", "chị", "em"...) — never "tôi"/"bạn" for family.
  - Genuine strangers *and* explicitly formal/business settings (job interviews, customer service, addressing a superior at work) → "tôi"/"bạn" or "anh/chị"/"em".
  - Relationship genuinely cannot be determined from any of the evidence above → default to "cậu"/"tớ", NOT "tôi"/"bạn". "tôi"/"bạn" is not a safe default for "unclear" — it reads as two adults who have never met, which is rarely what an unclear-but-clearly-young-and-casual scene actually is.
  Treat "tôi"/"bạn" as reserved for the two named cases above (genuine strangers, explicit formal/business register) — never as a fallback for "not sure". It is wrong far more often than it's right in casual manga dialogue. If forced to guess between two options, prefer the warmer/more casual one over the formal one, since most manga dialogue is casual.
  - **Applying the pair correctly:** the two terms are not interchangeable decorations — each one replaces a specific grammatical role from the source. The speaker's own term replaces "I"/"me"; the listener's term replaces "you". Map them to what the source sentence actually says, don't mechanically insert both terms into every line. A line that only addresses the listener (no "I" role in the source) — e.g. "What have you been writing?" — takes ONLY the listener's term, as the subject: "Anh đã viết gì vậy?". Adding the speaker's own term as a false subject — "Em đã viết gì vậy, anh?" — reverses who the question is about and is wrong, not just stylistically off.
  - **Before finalizing your answer**, re-scan every `[pair]`-tagged line against the `PRONOUN MAP:` entry for that same speaker-listener direction and fix any line where the actual pronoun words used don't match the mapped pair — a tag can be technically present while the sentence itself drifted to a different pair's wording; the words must match the tag, not just the bracket."""  # noqa

    natural_style_rule = (
        """
- **Natural Vietnamese:** Write each line the way a Vietnamese person would actually say it out loud, not a word-for-word rendering of the source sentence structure. Reorder clauses, drop redundant subject pronouns/particles the source repeats out of grammatical necessity, and use casual contractions ("ko", "z", "j"... are NOT allowed, but natural spoken phrasing like "à", "đấy", "mà", "đâu" is encouraged where it fits the tone). If your draft reads stiff or robotic, rewrite it more casually before finalizing."""  # noqa
        if "vietnamese" in (output_language or "").lower()
        else ""
    )

    is_vietnamese_output = "vietnamese" in (output_language or "").lower()

    core_rules = f"""
## CORE RULES
- **Reading Context:** The {input_type} are presented in a {direction} reading order. Do not reorder them.
{source_language_rule}
- **Cohesion:** Treat the input lines as a continuous narrative. Ensure the translation flows logically and naturally as a cohesive whole.{cohesion_visual}
- **Fidelity:** Focus on intent; translate functionally rather than literally.
- **Conciseness:** Keep translations idiomatic and concise.{natural_style_rule}
- **Emphasis:** If the source text is visually emphasized (bold, slanted, etc.), mirror that emphasis using the STYLING GUIDE.
- **Punctuation:** Replace ellipses (e.g., "…") with consecutive periods (e.g., "...").
- **Quotes:** Do not wrap the translated text in quotation marks unless they are explicitly present in the source text.
- **Text Types:**
  - **Spoken Dialogue/Internal Monologue:** Translate naturally, matching the character's personality.
  - **Narration:** Translate neutrally without special styling.
  - **Audible SFX:** Translate physical sounds (Giongo) as standard onomatopoeia.
  - **Mimetic FX:** Translate atmospheric text (Gitaigo) or silent actions as descriptive verbs or adjectives. Do not add a period at the end.
{edge_cases}{vietnamese_pronoun_rule}{previous_context_rule}
"""  # noqa

    shared_components = f"""
## ROLE
You are a professional manga localization translator and editor.

## OBJECTIVE
Your goal is to produce natural-sounding, high-quality translations in {output_language} that are faithful to the original source's meaning, tone, and visual emphasis.

## STYLING GUIDE
You must use the following markdown-style markers to convey emphasis:
- `*italic*`: Used for onomatopoeias, thoughts, flashbacks, distant sounds, or dialogue mediated by a device (e.g., phone, radio).
- `**bold**`: Used for sound effects (SFX), shouting, timestamps, or individual emphatic words.
- `***bold-italic***`: Used for extremely loud sounds or dialogue that also meets the criteria for italics (e.g., shouting over a radio).

{core_rules}
"""  # noqa

    pronoun_map_instruction = (
        """
- **Before the numbered list**, output a section titled exactly `PRONOUN MAP:` — one short line per distinct speaker-listener pair appearing ANYWHERE in this batch, each line starting with `-` (a dash, never a digit — digits are reserved for the list below), format `- <brief descriptor of speaker> -> <brief descriptor of listener>: <chosen pronoun pair>` (e.g. `- girl, short hair -> boy, glasses: tớ-cậu`). Base each line on the reasoning from the Vietnamese Pronouns rule above — actually work through speaker/listener/relationship for each pair here, don't skip straight to a guess. List EVERY distinct pair that exchanges dialogue in this batch, even ones with only one line — do not omit minor pairs or collapse different pairs into one. One line per distinct pair (not per dialogue line, not per image). If a line has no clear second party (narration, SFX, monologue), skip it. This section is required whenever any dialogue is present.
- **Every numbered line below** that involves a pair from `PRONOUN MAP:` must start with that exact pair in brackets, e.g. `[em-anh]`, before the translated text — see OUTPUT SCHEMA format. This is a hard constraint: once a pair is written in `PRONOUN MAP:`, every later line between those two speakers reuses it verbatim, no matter how many other lines/pairs come in between and no matter what feels more natural in isolation. Do not silently drift back to "mình"/"cậu" or any other default for a pair you already mapped. Lines with no clear second party use `[-]` instead."""
        if is_vietnamese_output
        else ""
    )
    pronoun_map_echo_instruction = (
        """ Immediately after that sentence, on its own line, add `XƯNG HÔ:` followed by every pair from this page's `PRONOUN MAP:` restated verbatim in the same `- <speaker> -> <listener>: <pair>` format (omit this line entirely if `PRONOUN MAP:` was empty) — this is how a later page knows the relationship was already decided instead of re-guessing from scratch."""
        if context_memory_enabled and is_vietnamese_output
        else ""
    )
    memory_note_instruction = (
        f"""
- **After the numbered list**, on a new line, output a section titled exactly `MEMORY NOTE:` followed by ONE short plain-text sentence (no dash, no numbering) summarizing this page for future reference — key characters present, notable events, or relationships revealed.{pronoun_map_echo_instruction} This section is required, even if the sentence is brief."""
        if context_memory_enabled
        else ""
    )
    schema_exception_labels = []
    if is_vietnamese_output:
        schema_exception_labels.append("the required `PRONOUN MAP:` section above the list")
    if context_memory_enabled:
        schema_exception_labels.append("the required `MEMORY NOTE:` section after the list")
    schema_exceptions = (
        " (except " + " and ".join(schema_exception_labels) + ")"
        if schema_exception_labels
        else ""
    )

    one_step_format = (
        f"`i: <transcribed text> || [pronoun pair, or - if none] <translated {output_language} text>`"
        if is_vietnamese_output
        else f"`i: <transcribed text> || <translated {output_language} text>`"
    )
    two_step_format = (
        f"`i: [pronoun pair, or - if none] <translated {output_language} text>`"
        if is_vietnamese_output
        else f"`i: <translated {output_language} text>`"
    )
    pronoun_subject_reminder = (
        """
- **Right before you write each translated line**, re-check: does the source line contain "I"/"me"? Does it contain "you"? Only insert a pronoun term for a role that's ACTUALLY present in that specific source line — a line with only "you" (no "I") gets only the listener's term, as its subject; do not add the speaker's own term as a second, unwarranted subject.
  - Source "What have you been writing?" (only "you", no "I") → correct: "Anh đã viết gì vậy?" — WRONG: "Em đã viết gì vậy, anh?" (this makes it sound like a question about what the SPEAKER wrote, reversing the meaning).
  - Source "I can't lie to you" (has both "I" and "you") → correct uses both terms: "Em không thể nói dối anh.\""""
        if is_vietnamese_output
        else ""
    )

    if mode == "one-step":
        output_schema = f"""
## OUTPUT SCHEMA
{pronoun_map_instruction}
- You must return your response as a single numbered list with exactly one line per input image.
- The numbering must correspond to the input image order (1, 2, 3...).
- For each item, provide both transcription and translation in the format:
  {one_step_format} where `i` is the input image number.
{memory_note_instruction}{pronoun_subject_reminder}
- Do not include section headers, explanations, or formatting outside of this list{schema_exceptions}.
"""
    elif mode == "two-step":
        output_schema = f"""
## OUTPUT SCHEMA
{pronoun_map_instruction}
- You must return your response as a single numbered list with exactly one line per input text.
- The numbering must correspond to the input order (1, 2, 3...).
- The format must be {two_step_format} where `i` is the input text number.
{memory_note_instruction}{pronoun_subject_reminder}
- Do not include section headers, explanations, or formatting outside of this list{schema_exceptions}.
"""  # noqa
    else:
        raise ValueError(
            f"Invalid mode '{mode}' specified for translation system prompt."
        )

    return shared_components + output_schema


def _is_reasoning_model_google(model_name: str) -> bool:
    """Check if a Google model is reasoning-capable."""
    return is_google_reasoning_model(model_name)


def _is_reasoning_model_openai(model_name: str) -> bool:
    """Check if an OpenAI model is reasoning-capable."""
    return _is_openai_reasoning_meta(model_name)


def _is_reasoning_model_anthropic(model_name: str) -> bool:
    """Check if an Anthropic model is reasoning-capable."""
    return is_anthropic_reasoning_model(model_name)


def _add_media_resolution_to_part(
    part: Dict[str, Any],
    media_resolution_ui: str,
) -> Dict[str, Any]:
    """
    Add media_resolution to an inline_data part.

    Args:
        part: Part dictionary with inline_data
        media_resolution_ui: UI format media resolution ("auto"/"high"/"medium"/"low")

    Returns:
        Part dictionary with media_resolution added
    """
    if "inline_data" not in part:
        return part

    media_resolution_mapping = {
        "auto": "MEDIA_RESOLUTION_UNSPECIFIED",
        "high": "MEDIA_RESOLUTION_HIGH",
        "medium": "MEDIA_RESOLUTION_MEDIUM",
        "low": "MEDIA_RESOLUTION_LOW",
    }
    backend_media_resolution = media_resolution_mapping.get(
        media_resolution_ui.lower(), "MEDIA_RESOLUTION_UNSPECIFIED"
    )

    result = part.copy()
    result["media_resolution"] = {"level": backend_media_resolution}
    return result


def _build_generation_config(
    provider: str,
    model_name: str,
    config: TranslationConfig,
    debug: bool = False,
) -> Dict[str, Any]:
    """
    Build provider-specific generation config dictionary.

    Centralizes logic for:
    - Base parameters (temperature, top_p, top_k)
    - Provider-specific parameter names and constraints
    - Reasoning model detection and token limits
    - Special features (thinking, reasoning_effort, etc.)

    Args:
        provider: Provider name (Google, OpenAI, Anthropic, xAI, OpenRouter, OpenAI-Compatible)
        model_name: Model identifier
        config: TranslationConfig with all settings
        debug: Whether to log debug messages

    Returns:
        Dictionary with generation config parameters for the specific provider
    """
    temperature = config.temperature
    top_p = config.top_p
    top_k = config.top_k

    def normalize_image_detail() -> str:
        image_detail = (config.image_detail or "auto").lower()
        if image_detail not in ("auto", "original", "high", "low"):
            image_detail = "auto"
        if image_detail == "original" and not supports_openai_original_image_detail(
            model_name
        ):
            image_detail = "high"
        return image_detail

    if config.max_tokens is not None:
        max_tokens_value = config.max_tokens
    else:
        is_reasoning = False
        if provider == "Google":
            is_reasoning = _is_reasoning_model_google(model_name)
        elif provider == "OpenAI":
            is_reasoning = _is_reasoning_model_openai(model_name)
        elif provider == "Azure OpenAI":
            is_reasoning = _is_reasoning_model_openai(model_name)
        elif provider == "Anthropic":
            is_reasoning = _is_reasoning_model_anthropic(model_name)
        elif provider == "xAI":
            is_reasoning = is_xai_reasoning_model(model_name)
        elif provider == "OpenRouter":
            is_reasoning = openrouter_is_reasoning_model(model_name, debug)
        elif provider == "OpenAI-Compatible":
            is_reasoning = is_openai_compatible_reasoning_model(model_name)
        elif provider == "DeepSeek":
            is_reasoning = is_deepseek_reasoning_model(model_name)
        elif provider == "Z.ai":
            is_reasoning = is_zai_reasoning_model(model_name)
        elif provider == "Moonshot AI":
            lm = (model_name or "").lower()
            is_reasoning = "kimi-k2." in lm
        max_tokens_value = 16384 if is_reasoning else 4096

    max_tokens_cap = get_max_tokens_cap(provider, model_name)
    if max_tokens_cap is not None and max_tokens_value > max_tokens_cap:
        max_tokens_value = max_tokens_cap

    if provider == "Google":
        is_gemini_3 = is_gemini_3_model(model_name)
        is_gemma = is_gemma_model(model_name)
        generation_config = {
            "temperature": temperature,
            "topP": top_p,
            "topK": top_k,
            "maxOutputTokens": max_tokens_value,
        }
        if not is_gemini_3:
            media_resolution_mapping = {
                "auto": "MEDIA_RESOLUTION_UNSPECIFIED",
                "high": "MEDIA_RESOLUTION_HIGH",
                "medium": "MEDIA_RESOLUTION_MEDIUM",
                "low": "MEDIA_RESOLUTION_LOW",
            }
            backend_media_resolution = media_resolution_mapping.get(
                config.media_resolution.lower(), "MEDIA_RESOLUTION_UNSPECIFIED"
            )
            generation_config["media_resolution"] = backend_media_resolution
        if is_gemini_3 or is_gemma:
            reasoning_effort = config.reasoning_effort or "high"
            generation_config["thinkingConfig"] = {"thinkingLevel": reasoning_effort}
            log_message(
                f"Using reasoning effort '{reasoning_effort}' for {model_name}",
                verbose=debug,
            )
        elif _is_reasoning_model_google(model_name) and not is_gemini_3:
            reasoning_effort = config.reasoning_effort or "auto"
            is_flash = is_gemini_25_flash_model(model_name)
            is_pro = is_gemini_25_pro_model(model_name)
            if reasoning_effort == "none":
                if is_flash:
                    generation_config["thinkingConfig"] = {"thinkingBudget": 0}
                    log_message(f"Disabled reasoning for {model_name}", verbose=debug)
                elif is_pro:
                    generation_config["thinkingConfig"] = {"thinkingBudget": 128}
                    log_message(
                        f"Using 'none' reasoning effort (thinkingBudget: 128) for {model_name}",
                        verbose=debug,
                    )
                else:
                    log_message(
                        f"Warning: 'none' not supported for {model_name}, using 'auto'",
                        verbose=debug,
                    )
            elif reasoning_effort == "auto":
                log_message(
                    f"Using auto reasoning allocation for {model_name}", verbose=debug
                )
            else:
                thinking_budget = calculate_reasoning_budget(
                    max_tokens_value, reasoning_effort
                )
                generation_config["thinkingConfig"] = {
                    "thinkingBudget": thinking_budget
                }
                log_message(
                    f"Using reasoning effort '{reasoning_effort}' (budget: {thinking_budget} tokens) for {model_name}",
                    verbose=debug,
                )
        return generation_config

    elif provider == "OpenAI":
        generation_config = {
            "temperature": temperature,
            "top_p": top_p,
            "max_output_tokens": max_tokens_value,
        }  # top_k not supported by OpenAI
        generation_config["image_detail"] = normalize_image_detail()
        if config.reasoning_effort:
            gen = get_gpt5_generation(model_name)
            is_chat = is_gpt5_chat_variant(model_name)
            xhigh_capable = gen in ("5.2", "5.3", "5.4", "5.5")
            effort = config.reasoning_effort
            if effort == "xhigh" and not xhigh_capable:
                effort = "high"
            none_capable = gen is not None and gen != "5"
            if not is_chat and (none_capable or effort != "none"):
                generation_config["reasoning_effort"] = effort
        if is_gpt5_series(model_name) and not is_gpt5_chat_variant(model_name):
            generation_config["verbosity"] = config.verbosity or "low"
        return generation_config

    elif provider == "Azure OpenAI":
        generation_config = {
            "temperature": temperature,
            "top_p": top_p,
            "max_tokens": max_tokens_value,
        }  # top_k not supported by Azure OpenAI Chat Completions
        generation_config["image_detail"] = normalize_image_detail()
        if config.reasoning_effort:
            effort = config.reasoning_effort
            if effort == "xhigh":
                effort = "high"
            if effort != "none":
                generation_config["reasoning_effort"] = effort
        if is_gpt5_series(model_name) and not is_gpt5_chat_variant(model_name):
            generation_config["verbosity"] = config.verbosity or "low"
        return generation_config

    elif provider == "Anthropic":
        is_reasoning = _is_reasoning_model_anthropic(model_name)
        is_opus_45 = is_opus_45_model(model_name)
        is_46 = is_46_model(model_name)
        is_47 = is_opus_47_model(model_name)
        clamped_temp = min(temperature, 1.0)  # Anthropic caps at 1.0
        generation_config = {
            "temperature": clamped_temp,
            "top_k": top_k,
            "max_tokens": max_tokens_value,
        }
        if is_reasoning:
            reasoning_effort = config.reasoning_effort or "none"
            generation_config["reasoning_effort"] = reasoning_effort
            # Claude 4.6/4.7 models use adaptive thinking; older models use budget-based
            if is_46 or is_47:
                if reasoning_effort == "auto":
                    generation_config["thinking_type"] = "adaptive"
            else:
                if reasoning_effort != "none":
                    generation_config["thinking_type"] = "enabled"
        if (is_opus_45 or is_46 or is_47) and config.effort:
            generation_config["effort"] = config.effort
            generation_config["is_46_model"] = is_46 or is_47
            generation_config["is_47_model"] = is_47
        return generation_config

    elif provider == "xAI":
        generation_config = {
            "temperature": temperature,
            "top_p": top_p,
            "max_tokens": max_tokens_value,
            "media_resolution": config.media_resolution,
        }
        if supports_xai_reasoning_parameter(model_name):
            generation_config["reasoning_effort"] = config.reasoning_effort or "high"
        return generation_config

    elif provider == "DeepSeek":
        is_reasoning = is_deepseek_reasoning_model(model_name)
        generation_config = {
            "temperature": temperature,
            "top_p": top_p,
            "max_tokens": max_tokens_value,
        }
        if is_reasoning:
            reasoning_effort = config.reasoning_effort or "high"
            thinking_type = "enabled" if reasoning_effort != "none" else "disabled"
            generation_config["thinking"] = {"type": thinking_type}
            if thinking_type == "enabled":
                generation_config["reasoning_effort"] = reasoning_effort
        return generation_config

    elif provider == "Z.ai":
        is_reasoning = is_zai_reasoning_model(model_name)
        generation_config = {
            "temperature": temperature,
            "top_p": top_p,
            "max_tokens": max_tokens_value,
        }
        if is_reasoning:
            # Z.ai uses thinking parameter with {"type": "enabled"} or {"type": "disabled"}
            # Map reasoning_effort: "auto" -> enabled, "none" -> disabled
            reasoning_effort = config.reasoning_effort or "auto"
            thinking_type = "enabled" if reasoning_effort != "none" else "disabled"
            generation_config["thinking"] = {"type": thinking_type}
        return generation_config

    elif provider == "Moonshot AI":
        lm = (model_name or "").lower()
        is_reasoning = "kimi-k2." in lm

        generation_config = {
            "temperature": min(temperature, 1.0),  # Moonshot caps at 1.0
            "top_p": top_p,
            "max_tokens": max_tokens_value,
        }

        if is_reasoning:
            # Map reasoning_effort: "high" -> enabled, "none" -> disabled
            reasoning_effort = config.reasoning_effort or "high"
            thinking_type = "enabled" if reasoning_effort == "high" else "disabled"
            generation_config["thinking"] = {"type": thinking_type}
        return generation_config

    elif provider == "OpenRouter":
        model_lower = (model_name or "").lower()
        is_openai_model = is_openai_model_family(model_name)
        is_anthropic_model = "anthropic/" in model_lower or model_lower.startswith(
            "claude-"
        )
        is_grok_model = "grok-4" in model_lower
        is_gemini_3 = is_gemini_3_model(model_name)

        generation_config = {
            "temperature": temperature,
            "top_p": top_p if not is_anthropic_model else None,
            "top_k": top_k,
            "max_tokens": max_tokens_value,
        }
        if is_openai_model:
            generation_config["image_detail"] = normalize_image_detail()

        is_openai_reasoning = is_openai_model and (
            "gpt-5" in model_lower
            or "o1" in model_lower
            or "o3" in model_lower
            or "o4-mini" in model_lower
        )
        is_gpt5_model = is_openai_model and is_gpt5_series(model_name)
        is_gpt5_1 = is_openai_model and "gpt-5.1" in model_lower
        is_gpt5 = is_openai_model and "gpt-5" in model_lower and not is_gpt5_1
        is_anthropic_reasoning = is_anthropic_reasoning_model(model_name)
        # On OpenRouter, Grok models lack explicit "reasoning" tags (e.g. "grok-4.1-fast")
        is_grok_reasoning = is_grok_model and "non-reasoning" not in model_lower

        is_opus_45 = is_opus_45_model(model_name)
        is_46 = is_46_model(model_name)
        is_47 = is_opus_47_model(model_name)
        generation_config["_metadata"] = {
            "is_openai_model": is_openai_model,
            "is_anthropic_model": is_anthropic_model,
            "is_grok_model": is_grok_model,
            "is_gemini_3": is_gemini_3,
            "is_google_model": "google/" in model_lower or "gemini" in model_lower,
            "is_openai_reasoning": is_openai_reasoning,
            "is_anthropic_reasoning": is_anthropic_reasoning,
            "is_grok_reasoning": is_grok_reasoning,
            "is_gpt5_1": is_gpt5_1,
            "is_gpt5": is_gpt5,
            "is_gpt5_model": is_gpt5_model,
            "is_opus_45": is_opus_45,
            "is_46_model": is_46 or is_47,
            "is_47_model": is_47,
        }

        if is_openai_reasoning or is_anthropic_reasoning or is_grok_reasoning:
            if is_anthropic_reasoning:
                reasoning_effort = config.reasoning_effort or "none"
                generation_config["reasoning_effort"] = reasoning_effort
            elif is_gpt5_1:
                generation_config["reasoning_effort"] = config.reasoning_effort
            elif config.reasoning_effort and config.reasoning_effort != "none":
                generation_config["reasoning_effort"] = config.reasoning_effort
        elif "gemini" in model_lower or "google/" in model_lower:
            if config.reasoning_effort:
                generation_config["reasoning_effort"] = config.reasoning_effort

        # Opus 4.5/4.6/4.7, Sonnet 4.6 effort parameter
        if (is_opus_45 or is_46 or is_47) and config.effort:
            generation_config["effort"] = config.effort

        # GPT-5 series verbosity
        if is_gpt5_model and not is_gpt5_chat_variant(model_name):
            generation_config["verbosity"] = config.verbosity or "low"

        return generation_config

    elif provider == "OpenAI-Compatible":
        return {
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "max_tokens": max_tokens_value,
        }

    else:
        raise TranslationError(f"Unknown provider for generation config: {provider}")


# Maps each provider to the TranslationConfig field holding its API key —
# used to build rotated config variants for backup keys / fallback providers
# without needing a separate branch per provider.
_PROVIDER_API_KEY_FIELD = {
    "Google": "google_api_key",
    "OpenAI": "openai_api_key",
    "Azure OpenAI": "azure_openai_api_key",
    "Anthropic": "anthropic_api_key",
    "xAI": "xai_api_key",
    "DeepSeek": "deepseek_api_key",
    "Z.ai": "zai_api_key",
    "Moonshot AI": "moonshot_api_key",
    "OpenRouter": "openrouter_api_key",
    "OpenAI-Compatible": "openai_compatible_api_key",
}


def _is_rate_limit_error(exc: Exception) -> bool:
    """True if this is a TranslationError raised after a provider endpoint
    exhausted its own internal 429 retries — every utils/endpoints/*.py
    module raises with this exact wording on that path."""
    return "Rate limited after" in str(exc)


# Phrases each provider actually uses for "this account is out of money",
# as opposed to a plain too-many-requests rate limit — kept to *structured*
# error codes / exact phrases that only appear on a genuine zero-balance
# response, not human-readable prose. Google in particular reuses "You
# exceeded your current quota, please check your plan and billing details"
# verbatim for its free-tier per-minute RATE limit too (confirmed from a
# real "RESOURCE_EXHAUSTED ... Please retry in 4s" response), so that
# sentence is deliberately NOT a marker — it would mislabel an ordinary,
# seconds-away-from-clearing rate limit as a 15-minute credit outage.
_INSUFFICIENT_CREDIT_MARKERS = (
    "insufficient_quota",  # OpenAI/Azure OpenAI error code (type AND code fields)
    "insufficient balance",  # DeepSeek
    "insufficient credit",
    "insufficient funds",
    "credit balance is too low",  # Anthropic's exact wording
    "top up your account",
    "top-up required",
)


def _is_insufficient_credit_error(exc: Exception) -> bool:
    """True if the provider is reporting an empty/negative account balance
    rather than a transient rate limit — worth rotating to the next key/
    provider for (the current one won't recover on its own), same as a
    rate limit, but a distinct enough failure mode to log clearly."""
    text = str(exc).lower()
    # HTTP 402 Payment Required is the standard status for "add funds" —
    # every utils/endpoints/*.py module formats a non-429 failure as
    # "Status <code>: ...", so this catches billing failures (OpenRouter,
    # DeepSeek, ...) regardless of each provider's own wording, without
    # having to enumerate every provider's exact error message.
    if "status 402" in text:
        return True
    return any(marker in text for marker in _INSUFFICIENT_CREDIT_MARKERS)


def _is_missing_key_error(exc: Exception) -> bool:
    """True if this candidate failed because it has no API key/endpoint/URL
    configured at all — every provider branch in _call_llm_endpoint_impl
    raises with this exact wording on that path. Distinct from a rate limit/
    credit failure (nothing to cool down — this candidate will never work on
    retry), but still worth rotating past rather than aborting the whole
    request: the primary candidate legitimately has an empty key whenever
    the extension's "temporarily disable this key" checkbox is unchecked
    with no enabled backup to promote in its place, and that should fall
    through to the next candidate (backup key/fallback provider) exactly
    like a rate limit would, not be treated as a fatal misconfiguration."""
    return "is missing" in str(exc)


def _candidate_key(candidate: TranslationConfig) -> Optional[str]:
    """The API key value a candidate config would actually call with."""
    key_field = _PROVIDER_API_KEY_FIELD.get(candidate.provider)
    return getattr(candidate, key_field, None) if key_field else None


# In-process cooldown tracker: once a (provider, key, model) triple gets
# rate-limited or reports no credit, it's benched for a while instead of
# being retried on the very next request — hammering an account that's
# already been told to back off just burns more of its rate-limit window
# and delays recovery. Scoped to the model too, not just the account —
# many providers (Gemini's free tier in particular) meter rate limits per
# model, so a limit on one model doesn't mean a different model on the
# same key is also out of quota. Process-lifetime only (resets on backend
# restart); deliberately not persisted, this is an operational throttle,
# not durable state.
_cooldowns: Dict[Tuple[str, str, str], float] = {}  # (provider, key, model) -> expires_at
_cooldowns_lock = threading.Lock()
# Fallback when the provider didn't send a `Retry-After` header on its 429
# (not all of them do) — a deliberately short blind guess, since most
# burst-style rate limits clear within seconds, not a full minute. When a
# header IS present, _call_llm_endpoint uses that instead (clamped by
# _MAX_RATE_LIMIT_COOLDOWN_SECONDS below) — see utils/rate_limit.py.
_RATE_LIMIT_COOLDOWN_SECONDS = 15.0
# Ceiling on a provider-supplied Retry-After, matching the credit-exhaustion
# cooldown below — a provider reporting a multi-hour quota reset shouldn't
# bench a key for the rest of the process's life; the user's own configured
# cooldown_seconds is still respected as-is (it's a deliberate user choice,
# not a provider-reported value) and isn't clamped by this.
_MAX_RATE_LIMIT_COOLDOWN_SECONDS = 900.0  # 15 minutes
# An empty/negative account balance doesn't fix itself on a retry timer —
# it stays broken until the user adds funds, which won't happen in the next
# few seconds, so re-checking it as often as a rate limit would just waste
# requests. Long, flat cooldown instead of the short rate-limit one.
_INSUFFICIENT_CREDIT_COOLDOWN_SECONDS = 900.0  # 15 minutes


def _mark_cooldown(
    provider: str,
    key: Optional[str],
    model: Optional[str],
    is_credit_error: bool,
    rate_limit_cooldown_seconds: float = _RATE_LIMIT_COOLDOWN_SECONDS,
) -> None:
    if not key:
        return
    duration = (
        _INSUFFICIENT_CREDIT_COOLDOWN_SECONDS
        if is_credit_error
        else rate_limit_cooldown_seconds
    )
    with _cooldowns_lock:
        _cooldowns[(provider, key, model or "")] = time.time() + duration


def _cooldown_remaining(provider: str, key: Optional[str], model: Optional[str]) -> float:
    """Seconds until this (provider, key, model) is usable again — 0 if it's
    not currently cooling down (including combinations never seen before)."""
    if not key:
        return 0.0
    with _cooldowns_lock:
        expires_at = _cooldowns.get((provider, key, model or ""))
    if not expires_at:
        return 0.0
    return max(expires_at - time.time(), 0.0)


# Round-robin cursor per distinct candidate pool (identified by its exact
# ordered set of (provider, key, model) triples) — spreads load proactively
# across every configured key/provider/model instead of always hammering
# the primary first and only touching backups reactively once it starts
# failing. Two keys on the same free-tier RPM cap effectively double
# combined throughput this way, instead of exhausting one before the other
# is ever used.
_round_robin_cursors: Dict[Tuple[Tuple[str, str, str], ...], int] = {}
_round_robin_lock = threading.Lock()


def _next_round_robin_offset(pool_signature: Tuple[Tuple[str, str, str], ...]) -> int:
    with _round_robin_lock:
        offset = _round_robin_cursors.get(pool_signature, 0)
        _round_robin_cursors[pool_signature] = offset + 1
        return offset


def _starting_offset(
    strategy: str,
    pool_signature: Tuple[Tuple[str, str, str], ...],
    pool_size: int,
    weights: Optional[List[float]] = None,
) -> int:
    """Which candidate a request tries first, before rotation-on-failure
    walks the rest in order. "sequential" always starts at the first
    configured key/provider (simplest, but concentrates load there);
    "random" picks by `weights` if given (each candidate's configured
    relative pick weight — equal weights behave the same as a uniform pick),
    otherwise uniformly at random; "round_robin" (default) advances a
    per-pool cursor so consecutive requests fan out evenly."""
    if strategy == "sequential":
        return 0
    if strategy == "random":
        return random.choices(range(pool_size), weights=weights or None, k=1)[0]
    return _next_round_robin_offset(pool_signature) % pool_size


def _iter_llm_candidates(config: TranslationConfig):
    """Yield TranslationConfig variants to try in order: the config exactly
    as given (so "API key is missing" etc. behave unchanged when no backups/
    fallbacks are configured), then the same provider/model with each backup
    key, then each fallback provider with each of its keys in turn.

    A (provider, key, model) triple is only ever yielded once — retrying the
    exact same account *and* model under a different label wastes a rate-
    limited request instead of actually rotating to fresh quota, so
    duplicates anywhere in the chain (primary vs. backups, backups vs. each
    other, vs. a fallback provider reusing the same key) are silently
    skipped after the first. The same key against a *different* model is
    NOT a duplicate — many providers (Gemini's free tier in particular)
    meter rate limits per model, so the same account can legitimately be
    configured twice with two different models to try.

    Each yielded candidate's `candidate_weight` carries its own configured
    relative pick weight (default 1.0), used only by "random" rotation to
    bias which ready candidate is tried first — every other rotation
    strategy ignores it.
    """
    primary_weight = (
        config.api_key_weight if config.api_key_weight and config.api_key_weight > 0 else 1.0
    )
    yield replace(config, candidate_weight=primary_weight)
    seen: set = set()

    key_field = _PROVIDER_API_KEY_FIELD.get(config.provider)
    primary_key = getattr(config, key_field, None) if key_field else None
    if key_field and primary_key:
        seen.add((config.provider, primary_key, config.model_name))
    if key_field:
        for i, backup_key in enumerate(config.backup_api_keys or []):
            if not backup_key or (config.provider, backup_key, config.model_name) in seen:
                continue
            seen.add((config.provider, backup_key, config.model_name))
            weights = config.backup_api_key_weights or []
            weight = weights[i] if i < len(weights) and weights[i] > 0 else 1.0
            yield replace(config, **{key_field: backup_key}, candidate_weight=weight)

    for fb in config.fallback_providers or []:
        fb_key_field = _PROVIDER_API_KEY_FIELD.get(fb.provider)
        if fb_key_field is None:
            continue
        extra_fields: Dict[str, Any] = {}
        if fb.provider == "Azure OpenAI":
            extra_fields["azure_openai_endpoint"] = fb.azure_openai_endpoint
            extra_fields["azure_openai_api_version"] = fb.azure_openai_api_version
            extra_fields["azure_openai_is_v1"] = fb.azure_openai_is_v1
        elif fb.provider == "OpenAI-Compatible":
            extra_fields["openai_compatible_url"] = fb.openai_compatible_url
        fb_model = fb.model_name or config.model_name
        for i, fb_key in enumerate(fb.api_keys or []):
            if not fb_key or (fb.provider, fb_key, fb_model) in seen:
                continue
            seen.add((fb.provider, fb_key, fb_model))
            fb_weights = fb.api_key_weights or []
            fb_weight = fb_weights[i] if i < len(fb_weights) and fb_weights[i] > 0 else 1.0
            yield replace(
                config,
                provider=fb.provider,
                model_name=fb_model,
                **{fb_key_field: fb_key},
                **extra_fields,
                candidate_weight=fb_weight,
            )


def _call_llm_endpoint(
    config: TranslationConfig,
    parts: List[Dict[str, Any]],
    prompt_text: str,
    debug: bool = False,
    system_prompt: Optional[str] = None,
) -> Optional[str]:
    """Dispatch an LLM API call, rotating through backup keys and fallback
    providers on rate limit, and log how long each attempt took.

    Every call site goes through here, so this is the single place that
    needs to log LLM latency separately from the rest of the pipeline
    (detection/cleaning/upscaling/rendering), which "Processing completed
    in Xs" lumps together — and the single choke point for key/provider
    rotation, so OCR and translation calls both benefit automatically.
    """
    all_candidates = list(_iter_llm_candidates(config))

    # Skip anything still cooling down from a recent rate-limit/credit
    # failure — retrying it on the very next request just burns more of
    # its rate-limit window instead of giving it a chance to recover.
    # Order among the rest is preserved (primary, then backups, then
    # fallbacks, as _iter_llm_candidates yielded them).
    candidates = []
    cooling_remaining = []
    for candidate in all_candidates:
        remaining = _cooldown_remaining(candidate.provider, _candidate_key(candidate), candidate.model_name)
        if remaining > 0:
            cooling_remaining.append(remaining)
            log_message(
                f"Skipping {candidate.provider} candidate — cooling down for "
                f"{remaining:.0f}s more after a recent rate limit/credit failure.",
                always_print=True,
            )
        else:
            candidates.append(candidate)

    if not candidates:
        soonest = min(cooling_remaining) if cooling_remaining else 0.0
        raise TranslationError(
            f"All {len(all_candidates)} configured API key(s)/provider(s) are "
            f"cooling down after a recent rate limit/credit failure. Try again "
            f"in about {soonest:.0f}s."
        )

    # Pick which ready candidate goes first, per config.rotation_strategy
    # (default round_robin: spread load proactively instead of always
    # starting from the primary). Rotation-on-failure below still walks the
    # rest of this (now rotated) order if the chosen starting candidate
    # fails, so nothing here removes the fallback chain — it only changes
    # which candidate goes first.
    if len(candidates) > 1:
        pool_signature = tuple(
            (c.provider, _candidate_key(c) or "", c.model_name or "") for c in all_candidates
        )
        weights = [max(c.candidate_weight, 0.0001) for c in candidates]
        offset = _starting_offset(config.rotation_strategy, pool_signature, len(candidates), weights)
        if offset:
            candidates = candidates[offset:] + candidates[:offset]

    for idx, candidate in enumerate(candidates):
        is_last = idx == len(candidates) - 1
        start = time.time()
        try:
            result = _call_llm_endpoint_impl(
                candidate, parts, prompt_text, debug, system_prompt
            )
            elapsed = time.time() - start
            log_message(
                f"LLM call ({candidate.provider} / {candidate.model_name}) took {elapsed:.2f}s",
                always_print=True,
            )
            return result
        except TranslationError as e:
            elapsed = time.time() - start
            log_message(
                f"LLM call ({candidate.provider} / {candidate.model_name}) "
                f"failed after {elapsed:.2f}s: {e}",
                always_print=True,
            )
            is_credit_error = _is_insufficient_credit_error(e)
            is_rate_limited = _is_rate_limit_error(e)
            is_missing_key = _is_missing_key_error(e)
            if is_rate_limited or is_credit_error:
                # Prefer the provider's own Retry-After value over the
                # user-configured blind guess, when it sent one — clamped
                # so a provider reporting an hours-away quota reset doesn't
                # bench a key for the rest of the process's lifetime.
                retry_after = getattr(e, "retry_after_seconds", None)
                rate_limit_cooldown = (
                    min(max(retry_after, 1.0), _MAX_RATE_LIMIT_COOLDOWN_SECONDS)
                    if retry_after is not None
                    else config.cooldown_seconds
                )
                _mark_cooldown(
                    candidate.provider,
                    _candidate_key(candidate),
                    candidate.model_name,
                    is_credit_error,
                    rate_limit_cooldown,
                )
            if not is_last and (is_rate_limited or is_credit_error or is_missing_key):
                reason = (
                    "is out of credit/quota" if is_credit_error
                    else "has no key/endpoint configured" if is_missing_key
                    else "was rate limited"
                )
                log_message(
                    f"Candidate {idx + 1}/{len(candidates)} ({candidate.provider}) "
                    f"{reason} — rotating to next key/provider.",
                    always_print=True,
                )
                continue
            # Last candidate, and it's a credit issue: give a clear summary
            # instead of just the final provider's raw error, so the user
            # isn't left guessing why translation stopped working.
            if is_credit_error and len(candidates) > 1:
                raise TranslationError(
                    f"All {len(candidates)} configured API key(s)/provider(s) are "
                    f"rate-limited or out of credit. Last error: {e}"
                ) from e
            raise
    # Unreachable: candidates is non-empty at this point (checked above),
    # and every branch in the loop returns or raises.
    raise TranslationError("LLM call failed: no candidates were configured.")


def _call_llm_endpoint_impl(
    config: TranslationConfig,
    parts: List[Dict[str, Any]],
    prompt_text: str,
    debug: bool = False,
    system_prompt: Optional[str] = None,
) -> Optional[str]:
    """Internal helper to dispatch API calls based on provider."""
    provider = config.provider
    model_name = config.model_name
    api_parts = parts + [{"text": prompt_text}]

    try:
        if provider == "Google":
            api_key = config.google_api_key
            if not api_key:
                raise TranslationError("Google API key is missing.")
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_gemini_endpoint(
                api_key=api_key,
                model_name=model_name,
                parts=api_parts,
                generation_config=generation_config,
                system_prompt=system_prompt,
                debug=debug,
                enable_web_search=config.enable_web_search,
            )
        elif provider == "OpenAI":
            api_key = config.openai_api_key
            if not api_key:
                raise TranslationError("OpenAI API key is missing.")
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_openai_endpoint(
                api_key=api_key,
                model_name=model_name,
                parts=api_parts,
                generation_config=generation_config,
                system_prompt=system_prompt,
                debug=debug,
                enable_web_search=config.enable_web_search,
            )
        elif provider == "Azure OpenAI":
            endpoint = config.azure_openai_endpoint
            api_key = config.azure_openai_api_key
            if not endpoint:
                raise TranslationError("Azure OpenAI endpoint is missing.")
            if not api_key:
                raise TranslationError("Azure OpenAI API key is missing.")
            if config.azure_openai_is_v1:
                # Azure AI Foundry "v1" surface is wire-compatible with
                # OpenAI's own Responses API (Bearer auth, deployment name
                # passed as "model"), so it reuses the OpenAI call path.
                generation_config = _build_generation_config(
                    "OpenAI", model_name, config, debug
                )
                return call_openai_endpoint(
                    api_key=api_key,
                    model_name=model_name,
                    parts=api_parts,
                    generation_config=generation_config,
                    system_prompt=system_prompt,
                    debug=debug,
                    base_url=endpoint,
                )
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_azure_openai_endpoint(
                endpoint=endpoint,
                deployment=model_name,
                api_key=api_key,
                parts=api_parts,
                generation_config=generation_config,
                api_version=config.azure_openai_api_version or None,
                system_prompt=system_prompt,
                debug=debug,
            )
        elif provider == "Anthropic":
            api_key = config.anthropic_api_key
            if not api_key:
                raise TranslationError("Anthropic API key is missing.")
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_anthropic_endpoint(
                api_key=api_key,
                model_name=model_name,
                parts=api_parts,
                generation_config=generation_config,
                system_prompt=system_prompt,
                debug=debug,
                enable_web_search=config.enable_web_search,
            )
        elif provider == "xAI":
            api_key = config.xai_api_key
            if not api_key:
                raise TranslationError("xAI API key is missing.")
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_xai_endpoint(
                api_key=api_key,
                model_name=model_name,
                parts=api_parts,
                generation_config=generation_config,
                system_prompt=system_prompt,
                debug=debug,
                enable_web_search=config.enable_web_search,
            )
        elif provider == "DeepSeek":
            api_key = config.deepseek_api_key
            if not api_key:
                raise TranslationError("DeepSeek API key is missing.")
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_deepseek_endpoint(
                api_key=api_key,
                model_name=model_name,
                parts=api_parts,
                generation_config=generation_config,
                system_prompt=system_prompt,
                debug=debug,
            )
        elif provider == "Z.ai":
            api_key = config.zai_api_key
            if not api_key:
                raise TranslationError("Z.ai API key is missing.")
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_zai_endpoint(
                api_key=api_key,
                model_name=model_name,
                parts=api_parts,
                generation_config=generation_config,
                system_prompt=system_prompt,
                debug=debug,
                enable_web_search=config.enable_web_search,
            )
        elif provider == "Moonshot AI":
            api_key = config.moonshot_api_key
            if not api_key:
                raise TranslationError("Moonshot API key is missing.")
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_moonshot_endpoint(
                api_key=api_key,
                model_name=model_name,
                parts=api_parts,
                generation_config=generation_config,
                system_prompt=system_prompt,
                debug=debug,
                enable_web_search=config.enable_web_search,
            )
        elif provider == "OpenRouter":
            api_key = config.openrouter_api_key
            if not api_key:
                raise TranslationError("OpenRouter API key is missing.")
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_openrouter_endpoint(
                api_key=api_key,
                model_name=model_name,
                parts=api_parts,
                generation_config=generation_config,
                system_prompt=system_prompt,
                debug=debug,
                enable_web_search=config.enable_web_search,
            )
        elif provider == "OpenAI-Compatible":
            base_url = config.openai_compatible_url
            api_key = config.openai_compatible_api_key  # Optional
            if not base_url:
                raise TranslationError("OpenAI-Compatible URL is missing.")
            generation_config = _build_generation_config(
                provider, model_name, config, debug
            )
            return call_openai_compatible_endpoint(
                base_url=base_url,
                api_key=api_key,
                model_name=model_name,
                parts=api_parts,
                generation_config=generation_config,
                system_prompt=system_prompt,
                debug=debug,
            )
        else:
            raise TranslationError(
                f"Unknown translation provider specified: {provider}"
            )

    except (ValueError, RuntimeError):
        raise


def _parse_llm_response_unified(
    response_text: Optional[str],
    total_elements: int,
    provider: str,
    debug: bool = False,
) -> List[str]:
    """Parse LLM response with a single numbered list."""
    if response_text is None:
        log_message(f"API call failed: {provider} returned None", always_print=True)
        raise TranslationError(f"{provider}: API failed (returned None)")
    elif response_text == "":
        log_message(f"API call returned empty response: {provider}", always_print=True)
        raise TranslationError(f"{provider}: Empty response")

    try:
        log_message(
            f"Parsing {provider} unified response: {len(response_text)} chars",
            verbose=debug,
        )
        log_message(f"Raw response:\n---\n{response_text}\n---", always_print=True)

        # Pattern matches "1: text" or "1. text" or "1 text" etc.
        pattern = re.compile(
            r'^\s*(\d+)\s*[:.]\s*"?\s*(.*?)\s*"?\s*(?=\s*\n\s*\d+\s*[:.]|\s*$)',
            re.MULTILINE | re.DOTALL,
        )

        matches = pattern.findall(response_text)
        result_dict = {}

        for num_str, text in matches:
            try:
                num = int(num_str)
                if 1 <= num <= total_elements:
                    result_dict[num] = text.strip()
            except ValueError:
                continue

        final_list = []
        for i in range(1, total_elements + 1):
            if i in result_dict:
                final_list.append(result_dict[i])
            else:
                final_list.append(f"[{provider}: Missing item {i}]")

        log_message(
            f"Parsed {len(result_dict)} items from unified response (expected {total_elements})",
            verbose=debug,
        )
        return final_list

    except Exception as e:
        log_message(
            f"Failed to parse {provider} unified response: {str(e)}",
            always_print=True,
        )
        return [f"[{provider}: Parse error]"] * total_elements


_MEMORY_NOTE_PATTERN = re.compile(
    r"\n?[ \t]*MEMORY NOTE:[ \t]*(.*?)[ \t]*$",
    re.IGNORECASE | re.DOTALL,
)


def _extract_memory_note(response_text: Optional[str]) -> tuple[str, str]:
    """Strip the trailing `MEMORY NOTE:` section out of a raw LLM response.

    Must run before `_parse_llm_response_unified`, whose numbered-item regex
    otherwise swallows any trailing non-numbered text (like this section)
    into the last translated line instead of stopping at it.

    Returns: (response_text with the section removed, the note text or "").
    """
    if not response_text:
        return response_text or "", ""
    match = _MEMORY_NOTE_PATTERN.search(response_text)
    if not match:
        return response_text, ""
    return response_text[: match.start()], match.group(1).strip()


_PRONOUN_TAG_PATTERN = re.compile(r"^\s*\[([^\]]{0,40})\]\s*")


def _strip_pronoun_tag(text: str) -> str:
    """Strip a leading `[pronoun pair]` tag the model was told to prefix
    each Vietnamese translated line with (see PRONOUN MAP in the system
    prompt) — the tag is a forcing function to stop the model drifting back
    to a default pronoun mid-batch, not something the user should see.

    Must not touch the `[OCR FAILED]` sentinel, which also looks like a
    bracket tag.
    """
    if not text:
        return text
    if text.strip().upper().startswith("[OCR FAILED]"):
        return text
    match = _PRONOUN_TAG_PATTERN.match(text)
    if not match:
        return text
    return text[match.end():]


def _prepare_images_for_ocr(
    images_b64: List[str], verbose: bool = False
) -> List[Optional[Image.Image]]:
    """Prepare base64-encoded images for OCR by decoding and converting to RGB.

    Args:
        images_b64: List of base64-encoded image strings
        verbose: Whether to print verbose logging

    Returns:
        List of PIL Images (or None for decode failures), all in RGB mode
    """
    pil_images = []
    for img_b64 in images_b64:
        try:
            image_data = base64.b64decode(img_b64)
            pil_img = Image.open(BytesIO(image_data))
            if pil_img.mode != "RGB":
                pil_img = pil_img.convert("RGB")
            pil_images.append(pil_img)
        except Exception as e:
            log_message(
                f"Failed to decode image for manga-ocr: {e}",
                always_print=True,
            )
            pil_images.append(None)
    return pil_images


def _format_ocr_results(
    extracted_texts: List[str],
    bubble_metadata: List[Dict[str, Any]],
) -> None:
    """Format and log OCR results.

    Args:
        extracted_texts: List of extracted text strings
        bubble_metadata: List of metadata dicts for text elements
        verbose: Whether to print verbose logging
    """
    log_lines = []

    for i, text in enumerate(extracted_texts):
        metadata = bubble_metadata[i] if i < len(bubble_metadata) else {}
        is_osb = metadata.get("is_outside_text", False)
        prefix = f"{i + 1}"
        type_label = "[OSB]" if is_osb else "[Bubble]"

        log_lines.append(f"{prefix}: {type_label} {text}")

    if log_lines:
        log_message(
            f"Raw OCR output:\n---\n{chr(10).join(log_lines)}\n---",
            always_print=True,
        )


def _check_ocr_failure(texts: List[str], provider: Optional[str] = None) -> bool:
    """Check if all OCR results indicate failure.

    Args:
        texts: List of extracted text strings
        provider: Optional provider name for LLM OCR failure detection

    Returns:
        True if all texts indicate failure, False otherwise
    """
    if not texts:
        return True

    if provider:
        for text in texts:
            if f"[{provider}-OCR:" not in text:
                return False
        return True
    else:
        return all(text == "[OCR FAILED]" for text in texts)


def _format_previous_context_texts(
    previous_context_texts: Optional[List[List[str]]],
) -> str:
    """Format previous-page OCR transcripts as a labeled context block.

    Pages are listed oldest-to-newest (matching the previous-image convention).
    Empty/failed entries are omitted, and the section is suppressed entirely
    when no usable transcripts remain.
    """
    if not previous_context_texts:
        return ""

    page_blocks = []
    for page_index, page_texts in enumerate(previous_context_texts, start=1):
        if not page_texts:
            continue
        lines = []
        for idx, text in enumerate(page_texts, start=1):
            cleaned = (text or "").strip()
            if not cleaned or cleaned == "[OCR FAILED]":
                continue
            lines.append(f"{idx}: {cleaned}")
        if not lines:
            continue
        page_blocks.append(
            f"### Previous Page {page_index}\n" + "\n".join(lines)
        )

    if not page_blocks:
        return ""

    return (
        "\n## PREVIOUS PAGE TRANSCRIPTS\n"
        "Listed oldest-to-newest. These are reference only — do not translate or renumber.\n"
        + "\n\n".join(page_blocks)
        + "\n"
    )


def _format_special_instructions(config: TranslationConfig) -> str:
    """Format the user's instruction fields for prompts.

    Two independent, optional fields:
    - llm_instructions: persistent style/behavior guidance the user sets
      once and expects to apply regardless of which manga is being
      translated (e.g. "prefer literal translation of idioms").
    - special_instructions: notes specific to the current story (cast,
      relationships, glossary) — what "Suggest Notes" drafts.

    Returns a combined section (empty string if neither is set).
    """
    sections = []
    if config.llm_instructions and config.llm_instructions.strip():
        sections.append(f"## GENERAL INSTRUCTIONS\n{config.llm_instructions.strip()}")
    if config.special_instructions and config.special_instructions.strip():
        sections.append(f"## STORY NOTES\n{config.special_instructions.strip()}")
    if not sections:
        return ""
    return "\n\n" + "\n\n".join(sections) + "\n"


def _format_fix_hint(config: TranslationConfig) -> str:
    """Format a one-off correction requested by the user after seeing a bad
    translation (a full-page re-translate with this note attached).

    Two shapes:
    - Targeted (fix_hint_bubble_index set): fixes one specific bubble, the
      rest translate normally. Item numbering matches the 1-indexed
      ordering used elsewhere in the prompt (`Items [N]`, `## INPUT DATA`),
      so bubble_index (0-based, from the prior response's `bubbles` list)
      is offset by one. original_text is included as a visual/textual
      anchor since bubble order/count can shift slightly between calls.
    - General (no bubble_index): applied across the whole page — e.g. a
      recurring mistake (wrong character name, wrong pronoun pair) the user
      is fixing across several already-translated pages at once.
    """
    instruction = (config.fix_hint_instruction or "").strip()
    if not instruction:
        return ""
    bubble_index = config.fix_hint_bubble_index
    if bubble_index is None:
        return (
            "\n\n## CORRECTION\n"
            f"The previous translation of this page had a mistake. Apply this correction "
            f"throughout the page, to every item it's relevant to: {instruction}\n"
        )
    anchor = (config.fix_hint_original_text or "").strip()
    anchor_note = f' (original text: "{anchor}")' if anchor else ""
    return (
        "\n\n## TARGETED CORRECTION\n"
        f"The previous translation of item #{bubble_index + 1}{anchor_note} was wrong. "
        f"Apply this correction to that item: {instruction}\n"
        "If item numbering has shifted, use the original text quoted above to find the right one. "
        "Translate every other item normally, unaffected by this note.\n"
    )


def _build_rosetta_instruction(
    output_language: str,
    special_instructions: Optional[str] = None,
) -> str:
    """Build instruction prompt for YanoljaNEXT Rosetta translation models.

    Follows the Rosetta chat template format: concise instruction with target
    language, context, tone, optional glossary, and output format.
    Special instructions are mapped to the Glossary field.
    """
    instruction = (
        f"Translate the user's text to {output_language}. "
        f"Keep the JSON structure and keys.\n"
        f"Context: Manga dialogue, sound effects, and narration.\n"
        f"Tone: Natural-sounding manga localization"
    )

    if special_instructions and special_instructions.strip():
        glossary_lines = []
        for line in special_instructions.strip().splitlines():
            line = line.strip()
            if line:
                entry = line if line.startswith("- ") else f"- {line}"
                glossary_lines.append(entry)
        if glossary_lines:
            instruction += "\nGlossary:\n" + "\n".join(glossary_lines)

    instruction += (
        "\nOutput format: JSON\n"
        "Provide the final translation immediately without any other text."
    )
    return instruction


def _build_rosetta_source_prompt(extracted_texts: List[str]) -> str:
    """Format OCR texts as JSON for Rosetta models.

    Returns a JSON object with string keys "1", "2", etc.
    """
    data = {str(i + 1): text for i, text in enumerate(extracted_texts)}
    return json.dumps(data, ensure_ascii=False)


def _parse_rosetta_response(
    response_text: Optional[str],
    total_elements: int,
    provider: str,
    debug: bool = False,
) -> List[str]:
    """Parse JSON response from a Rosetta model.

    Falls back to _parse_llm_response_unified if JSON parsing fails.
    """
    if response_text is None:
        raise TranslationError(f"{provider}: API failed (returned None)")
    if response_text == "":
        raise TranslationError(f"{provider}: Empty response")

    log_message(f"Raw response:\n---\n{response_text}\n---", always_print=True)

    # Strip markdown code fences if present
    cleaned = response_text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            result = []
            for i in range(1, total_elements + 1):
                val = parsed.get(str(i))
                if val is not None:
                    result.append(str(val).strip())
                else:
                    result.append(f"[{provider}: Missing item {i}]")
            log_message(
                f"Parsed {len(parsed)} items from Rosetta JSON (expected {total_elements})",
                verbose=debug,
            )
            return result
    except (json.JSONDecodeError, TypeError):
        log_message(
            "Rosetta response is not valid JSON, falling back to numbered-list parser",
            verbose=debug,
        )

    return _parse_llm_response_unified(response_text, total_elements, provider, debug)


def _perform_manga_ocr(
    images_b64: List[str],
    bubble_metadata: List[Dict[str, Any]],
    debug: bool = False,
) -> List[str]:
    """Perform OCR using manga-ocr model.

    Args:
        images_b64: List of base64-encoded images
        bubble_metadata: List of metadata dicts for text elements
        debug: Whether to print verbose logging

    Returns:
        List of extracted text strings, or early return with failure list
    """
    total_elements = len(images_b64)
    log_message("Using manga-ocr for text extraction", verbose=debug)

    cache = get_cache()
    cache_key = cache.get_manga_ocr_cache_key(images_b64, total_elements)
    cached_ocr = cache.get_manga_ocr_result(cache_key)
    if cached_ocr is not None:
        if len(cached_ocr) == total_elements:
            log_message("Using cached manga-ocr results", verbose=debug)
            return cached_ocr
        log_message("Discarding manga-ocr cache due to length mismatch", verbose=debug)

    pil_images = _prepare_images_for_ocr(images_b64, verbose=debug)
    extracted_texts = extract_text_with_manga_ocr(pil_images, verbose=debug)

    formatted_texts = []
    for i, text in enumerate(extracted_texts):
        if text == "[OCR FAILED]" or not text:
            formatted_texts.append(text if text else "[OCR FAILED]")
        else:
            formatted_texts.append(text)

    extracted_texts = formatted_texts

    _format_ocr_results(extracted_texts, bubble_metadata)

    if len(extracted_texts) != total_elements:
        msg = (
            f"Warning: extracted_texts length ({len(extracted_texts)}) "
            f"doesn't match total_elements ({total_elements})"
        )
        log_message(msg, always_print=True)
        while len(extracted_texts) < total_elements:
            extracted_texts.append("[OCR FAILED]")
        extracted_texts = extracted_texts[:total_elements]

    if not extracted_texts:
        log_message("manga-ocr returned empty results", verbose=debug)
        failure_results = ["[OCR FAILED]"] * total_elements
        cache.set_manga_ocr_result(cache_key, failure_results, debug)
        return failure_results

    if _check_ocr_failure(extracted_texts):
        log_message("manga-ocr returned only failures", verbose=debug)
        cache.set_manga_ocr_result(cache_key, extracted_texts, debug)
        return extracted_texts

    cache.set_manga_ocr_result(cache_key, extracted_texts, debug)
    return extracted_texts


def _perform_paddle_ocr_vl(
    images_b64: List[str],
    bubble_metadata: List[Dict[str, Any]],
    debug: bool = False,
) -> List[str]:
    """Perform OCR using PaddleOCR-VL-1.5 model.

    Args:
        images_b64: List of base64-encoded images
        bubble_metadata: List of metadata dicts for text elements
        debug: Whether to print verbose logging

    Returns:
        List of extracted text strings, or early return with failure list
    """
    total_elements = len(images_b64)
    log_message("Using PaddleOCR-VL-1.5 for text extraction", verbose=debug)

    cache = get_cache()
    cache_key = cache.get_manga_ocr_cache_key(
        images_b64, total_elements, prefix="pocr_"
    )
    cached_ocr = cache.get_manga_ocr_result(cache_key)
    if cached_ocr is not None:
        if len(cached_ocr) == total_elements:
            log_message("Using cached PaddleOCR-VL-1.5 results", verbose=debug)
            return cached_ocr
        log_message(
            "Discarding PaddleOCR-VL-1.5 cache due to length mismatch", verbose=debug
        )

    pil_images = _prepare_images_for_ocr(images_b64, verbose=debug)
    extracted_texts = extract_text_with_paddle_ocr_vl(pil_images, verbose=debug)

    formatted_texts = []
    for i, text in enumerate(extracted_texts):
        if text == "[OCR FAILED]" or not text:
            formatted_texts.append(text if text else "[OCR FAILED]")
        else:
            # Collapse newlines hallucinated by PaddleOCR-VL
            formatted_texts.append(" ".join(text.split()))

    extracted_texts = formatted_texts

    _format_ocr_results(extracted_texts, bubble_metadata)

    if len(extracted_texts) != total_elements:
        msg = (
            f"Warning: extracted_texts length ({len(extracted_texts)}) "
            f"doesn't match total_elements ({total_elements})"
        )
        log_message(msg, always_print=True)
        while len(extracted_texts) < total_elements:
            extracted_texts.append("[OCR FAILED]")
        extracted_texts = extracted_texts[:total_elements]

    if not extracted_texts:
        log_message("PaddleOCR-VL-1.5 returned empty results", verbose=debug)
        failure_results = ["[OCR FAILED]"] * total_elements
        cache.set_manga_ocr_result(cache_key, failure_results, debug)
        return failure_results

    if _check_ocr_failure(extracted_texts):
        log_message("PaddleOCR-VL-1.5 returned only failures", verbose=debug)
        cache.set_manga_ocr_result(cache_key, extracted_texts, debug)
        return extracted_texts

    cache.set_manga_ocr_result(cache_key, extracted_texts, debug)
    return extracted_texts


def _perform_llm_ocr(
    config: TranslationConfig,
    images_b64: List[str],
    mime_types: List[str],
    ocr_prompt: str,
    provider: str,
    input_language: Optional[str],
    reading_direction: str,
    debug: bool = False,
) -> List[str]:
    """Perform OCR using vision LLM.

    Args:
        config: TranslationConfig
        images_b64: List of base64-encoded images
        mime_types: List of MIME types for each image
        ocr_prompt: OCR prompt text
        provider: Provider name
        input_language: Input language
        reading_direction: Reading direction
        debug: Whether to print verbose logging

    Returns:
        List of extracted text strings, or early return with failure list
    """
    total_elements = len(images_b64)
    ocr_parts = []
    for i, img_b64 in enumerate(images_b64):
        mime_type = mime_types[i] if i < len(mime_types) else "image/jpeg"
        bubble_part = {"inline_data": {"mime_type": mime_type, "data": img_b64}}
        supports_per_part_res = (
            provider == "Google" and is_gemini_3_model(config.model_name)
        ) or provider == "xAI"
        if supports_per_part_res:
            bubble_part = _add_media_resolution_to_part(
                bubble_part, config.media_resolution_bubbles
            )
        ocr_parts.append(bubble_part)

    ocr_system = _build_system_prompt_ocr(input_language, reading_direction)
    ocr_response_text = _call_llm_endpoint(
        config,
        ocr_parts,
        ocr_prompt,
        debug,
        system_prompt=ocr_system,
    )
    extracted_texts = _parse_llm_response_unified(
        ocr_response_text,
        total_elements,
        provider + "-OCR",
        debug,
    )

    if extracted_texts is None:
        log_message("OCR API call failed", always_print=True)
        return [f"[{provider}: OCR failed]"] * total_elements

    if _check_ocr_failure(extracted_texts, provider):
        log_message("OCR returned only placeholders", verbose=debug)
        return extracted_texts

    return extracted_texts


def call_translation_api_batch(
    config: TranslationConfig,
    images_b64: List[str],
    full_image_b64: str,
    mime_types: List[str],
    full_image_mime_type: str,
    bubble_metadata: List[Dict[str, Any]],
    previous_context_images: Optional[List[Dict[str, str]]] = None,
    previous_context_texts: Optional[List[List[str]]] = None,
    ocr_texts_output: Optional[List[str]] = None,
    memory_note_output: Optional[List[str]] = None,
    debug: bool = False,
) -> List[str]:
    """
    Generates prompts and calls the appropriate LLM API endpoint based on the provider and mode
    specified in the configuration, translating text from speech bubbles and outside-bubble text.

    Supports "one-step" (OCR+Translate+Style) and "two-step" (OCR then Translate+Style) modes.

    Args:
        config (TranslationConfig): Configuration object.
        images_b64 (list): List of base64 encoded images of all text elements, in reading order.
        full_image_b64 (str): Base64 encoded image of the full manga page.
        mime_types (List[str]): List of MIME types for each text element image.
        full_image_mime_type (str): MIME type of the full page image.
        bubble_metadata (List[Dict]): List of metadata dicts with 'is_outside_text' flags for each image.
        previous_context_images: Previous source page images, oldest-to-newest, as reference only.
        previous_context_texts: Per-previous-page OCR transcripts (oldest-to-newest) included as
            narrative reference only. Each inner list contains the OCR strings for that page in reading order.
        ocr_texts_output: Optional mutable list. When provided, OCR transcripts (source-language text) for
            the current page's bubbles are appended in reading order so callers can propagate them as
            previous-page text context for subsequent calls.
        memory_note_output: Optional mutable list. When config.context_memory_enabled is set, the model's
            one-sentence MEMORY NOTE summary for this page is appended here so callers can accumulate it
            as config.context_memory for subsequent pages of the same story.
        debug (bool): Whether to print debugging information.

    Returns:
        list: List of translated strings (potentially with style markers), one for each input text element.
              Returns placeholder messages on errors or empty responses.

    Raises:
        ValueError: If required config (API key, provider, URL) is missing or invalid.
        RuntimeError: If an API call fails irrecoverably after retries (raised by endpoint functions).
    """
    provider = config.provider
    input_language = config.input_language
    output_language = config.output_language
    reading_direction = config.reading_direction
    translation_mode = config.translation_mode
    previous_context_images = previous_context_images or []
    if not config.send_full_page_context or config.ocr_method != "LLM":
        previous_context_images = []

    if provider == "OpenAI-Compatible" and config.ocr_method == "LLM":
        has_full_page_context = config.send_full_page_context and bool(full_image_b64)
        current_page_media_count = len(images_b64) + (
            1 if has_full_page_context else 0
        )

        if current_page_media_count > OPENAI_COMPATIBLE_MAX_MEDIA_ITEMS:
            chunk_full_image_b64 = full_image_b64 if has_full_page_context else ""
            max_bubbles_per_request = OPENAI_COMPATIBLE_MAX_MEDIA_ITEMS - (
                1 if chunk_full_image_b64 else 0
            )
            if max_bubbles_per_request < 1:
                chunk_full_image_b64 = ""
                max_bubbles_per_request = OPENAI_COMPATIBLE_MAX_MEDIA_ITEMS

            log_message(
                "OpenAI-Compatible media limit: splitting "
                f"{len(images_b64)} text images into chunks of "
                f"{max_bubbles_per_request}.",
                always_print=True,
            )
            combined_translations: List[str] = []
            combined_ocr_texts: List[str] = []

            for start in range(0, len(images_b64), max_bubbles_per_request):
                end = min(start + max_bubbles_per_request, len(images_b64))
                chunk_ocr_texts: List[str] = []
                chunk_translations = call_translation_api_batch(
                    config=config,
                    images_b64=images_b64[start:end],
                    full_image_b64=chunk_full_image_b64,
                    mime_types=mime_types[start:end],
                    full_image_mime_type=full_image_mime_type,
                    bubble_metadata=bubble_metadata[start:end],
                    previous_context_images=[],
                    previous_context_texts=previous_context_texts,
                    ocr_texts_output=chunk_ocr_texts,
                    debug=debug,
                )
                combined_translations.extend(chunk_translations)
                combined_ocr_texts.extend(chunk_ocr_texts)

            if ocr_texts_output is not None:
                ocr_texts_output.extend(combined_ocr_texts)
            return combined_translations

        max_previous_images = (
            OPENAI_COMPATIBLE_MAX_MEDIA_ITEMS - current_page_media_count
        )
        if len(previous_context_images) > max_previous_images:
            log_message(
                "OpenAI-Compatible media limit: trimming previous-page "
                f"context images from {len(previous_context_images)} to "
                f"{max_previous_images}.",
                always_print=True,
            )
            previous_context_images = (
                previous_context_images[-max_previous_images:]
                if max_previous_images > 0
                else []
            )

    previous_context_image_count = len(previous_context_images)
    # Filter out empty pages (no usable OCR) and trim to configured cap so the
    # request order matches the prompt order regardless of upstream history gaps.
    cleaned_previous_texts: List[List[str]] = []
    configured_text_count = int(
        getattr(config, "previous_context_text_count", 0) or 0
    )
    if previous_context_texts and configured_text_count > 0:
        for page_texts in previous_context_texts:
            usable = [
                (t or "").strip()
                for t in (page_texts or [])
                if (t or "").strip() and (t or "").strip() != "[OCR FAILED]"
            ]
            if usable:
                cleaned_previous_texts.append(usable)
        cleaned_previous_texts = cleaned_previous_texts[-configured_text_count:]
    previous_context_text_count = len(cleaned_previous_texts)
    previous_text_section = _format_previous_context_texts(cleaned_previous_texts)

    # Include conditional bubble hints
    total_elements = len(images_b64)
    dialogue_indices = [
        i + 1
        for i, meta in enumerate(bubble_metadata)
        if not meta.get("is_outside_text", False)
    ]
    osb_indices = [
        i + 1
        for i, meta in enumerate(bubble_metadata)
        if meta.get("is_outside_text", False)
    ]

    hints = []
    if dialogue_indices:
        dialogue_list_str = ", ".join(map(str, dialogue_indices))
        hints.append(f"Items [{dialogue_list_str}] contain spoken dialogue.")
    if osb_indices:
        osb_list_str = ", ".join(map(str, osb_indices))
        hints.append(
            f"Items [{osb_list_str}] contain sound effects, mimetic effects, narration, or internal monologues."
        )

    context_hints = ""
    if hints:
        context_hints = "\nNote: " + " ".join(hints) + " Translate them accordingly."

    context_memory_section = ""
    if config.context_memory_enabled and (config.context_memory or "").strip():
        pronoun_map_reuse_note = (
            "\nIf any accumulated note above has an `XƯNG HÔ:` line, those pairs were already decided on an "
            "earlier page — reuse the same pair verbatim in this page's `PRONOUN MAP:` for the same "
            "speaker-listener direction if that pair reappears, instead of re-deciding it from this page's art "
            "alone. Only deviate if this page's dialogue gives a clear, specific reason the earlier call was "
            "wrong (e.g. a family address term appears that wasn't visible before)."
            if "vietnamese" in (output_language or "").lower()
            else ""
        )
        context_memory_section = (
            "\n## STORY MEMORY (accumulated from earlier pages of this story)\n"
            f"{config.context_memory.strip()}\n"
            f"{pronoun_map_reuse_note}"
        )

    cache = get_cache()
    cache_key = cache.get_translation_cache_key(
        images_b64,
        full_image_b64,
        config,
        previous_context_images=previous_context_images,
        previous_context_texts=cleaned_previous_texts,
    )
    cached_translation, cached_ocr_texts = cache.get_translation(cache_key)
    if cached_translation is not None:
        log_message("  - Using cached translation", verbose=debug)
        if ocr_texts_output is not None and cached_ocr_texts is not None:
            ocr_texts_output.extend(cached_ocr_texts)
        return cached_translation

    model_name = config.model_name
    is_gemini_3 = provider == "Google" and is_gemini_3_model(model_name)
    supports_per_part_res = is_gemini_3 or provider == "xAI"

    base_parts = []
    for i, img_b64 in enumerate(images_b64):
        mime_type = mime_types[i] if i < len(mime_types) else "image/jpeg"
        bubble_part = {"inline_data": {"mime_type": mime_type, "data": img_b64}}
        if supports_per_part_res:
            bubble_part = _add_media_resolution_to_part(
                bubble_part, config.media_resolution_bubbles
            )
        base_parts.append(bubble_part)

    if config.send_full_page_context and full_image_b64:
        context_part = {
            "inline_data": {
                "mime_type": full_image_mime_type,
                "data": full_image_b64,
            }
        }
        if supports_per_part_res:
            context_part = _add_media_resolution_to_part(
                context_part, config.media_resolution_context
            )
        base_parts.append(context_part)

    for image in previous_context_images:
        previous_part = {
            "inline_data": {
                "mime_type": image.get("mime_type", "image/jpeg"),
                "data": image.get("data", ""),
            }
        }
        if supports_per_part_res:
            previous_part = _add_media_resolution_to_part(
                previous_part, config.media_resolution_context
            )
        base_parts.append(previous_part)

    try:
        if translation_mode == "two-step":
            special_instructions_section = _format_special_instructions(config)

            ocr_prompt = f"""
## CONTEXT
You have been provided with {total_elements} individual text images from a manga page.

## TASK
Apply your OCR transcription rules to each image provided.{special_instructions_section}
"""  # noqa

            log_message("Starting OCR step", verbose=debug)

            if config.ocr_method == "manga-ocr":
                extracted_texts = _perform_manga_ocr(
                    images_b64,
                    bubble_metadata,
                    debug,
                )
            elif config.ocr_method == "paddleocr-vl":
                extracted_texts = _perform_paddle_ocr_vl(
                    images_b64,
                    bubble_metadata,
                    debug,
                )
            else:
                extracted_texts = _perform_llm_ocr(
                    config,
                    images_b64,
                    mime_types,
                    ocr_prompt,
                    provider,
                    input_language,
                    reading_direction,
                    debug,
                )

            log_message("Starting translation step", verbose=debug)

            formatted_texts = []
            ocr_failed_indices = set()
            for i, text in enumerate(extracted_texts):
                if f"[{provider}-OCR:" in text or text == "[OCR FAILED]":
                    formatted_texts.append("[OCR FAILED]")
                    ocr_failed_indices.add(i)
                else:
                    formatted_texts.append(text)

            ocr_input_section = """
## INPUT DATA
"""
            for i, text in enumerate(formatted_texts):
                ocr_input_section += f"{i + 1}: {text}\n"

            full_page_context = (
                "A full-page image is also provided for visual and narrative context."
                if (
                    config.ocr_method not in ("manga-ocr", "paddleocr-vl")
                    and config.send_full_page_context
                    and full_image_b64
                )
                else ""
            )
            previous_page_context = _format_previous_context_prompt_note(
                previous_context_image_count,
                previous_context_text_count,
                (
                    "current full page first (when present), then previous "
                    "source pages oldest-to-newest"
                ),
            )

            special_instructions_section = _format_special_instructions(config) + _format_fix_hint(config)

            translation_prompt = f"""
## CONTEXT
You have been provided with a list of {total_elements} transcribed text segments from a manga page. {full_page_context}{previous_page_context}
{context_hints}
{previous_text_section}
{context_memory_section}
{ocr_input_section}

## TASK
Apply your translation and styling rules to the text in the `## INPUT DATA` section.
The target language is {output_language}. Use the appropriate translation approach for each text type.{special_instructions_section}
"""  # noqa

            translation_parts = []
            if (
                config.ocr_method not in ("manga-ocr", "paddleocr-vl")
                and config.send_full_page_context
                and full_image_b64
            ):
                context_part = {
                    "inline_data": {
                        "mime_type": full_image_mime_type,
                        "data": full_image_b64,
                    }
                }
                if supports_per_part_res:
                    context_part = _add_media_resolution_to_part(
                        context_part, config.media_resolution_context
                    )
                translation_parts.append(context_part)

            for image in previous_context_images:
                previous_part = {
                    "inline_data": {
                        "mime_type": image.get("mime_type", "image/jpeg"),
                        "data": image.get("data", ""),
                    }
                }
                if supports_per_part_res:
                    previous_part = _add_media_resolution_to_part(
                        previous_part, config.media_resolution_context
                    )
                translation_parts.append(previous_part)

            use_rosetta = is_rosetta_model(model_name)
            if use_rosetta:
                log_message(
                    "YanoljaNEXT Rosetta model detected — using Rosetta prompt format",
                    always_print=True,
                )
                translation_system = _build_rosetta_instruction(
                    output_language,
                    config.special_instructions,
                )
                translation_prompt = _build_rosetta_source_prompt(formatted_texts)
                translation_parts = []  # text-only model, no image parts
            else:
                translation_system = _build_system_prompt_translation(
                    output_language,
                    mode="two-step",
                    reading_direction=reading_direction,
                    full_page_context=(
                        config.send_full_page_context and bool(full_image_b64)
                    ),
                    previous_context_image_count=previous_context_image_count,
                    previous_context_text_count=previous_context_text_count,
                    input_language=input_language,
                    context_memory_enabled=config.context_memory_enabled,
                )
            translation_response_text = _call_llm_endpoint(
                config,
                translation_parts,
                translation_prompt,
                debug,
                system_prompt=translation_system,
            )
            if config.context_memory_enabled and translation_response_text:
                translation_response_text, memory_note = _extract_memory_note(
                    translation_response_text
                )
                if memory_note_output is not None and memory_note:
                    memory_note_output.append(memory_note)
            if use_rosetta:
                final_translations = _parse_rosetta_response(
                    translation_response_text,
                    total_elements,
                    provider + "-Translate",
                    debug,
                )
            else:
                final_translations = _parse_llm_response_unified(
                    translation_response_text,
                    total_elements,
                    provider + "-Translate",
                    debug,
                )

            if final_translations is None:
                log_message("Translation API call failed", always_print=True)
                combined_results = []
                for i in range(total_elements):
                    if i in ocr_failed_indices:
                        combined_results.append(f"[{provider}: OCR Failed]")
                    else:
                        combined_results.append(f"[{provider}: Translation failed]")
                if ocr_texts_output is not None:
                    ocr_texts_output.extend(extracted_texts)
                return combined_results

            if "vietnamese" in (output_language or "").lower():
                final_translations = [_strip_pronoun_tag(t) for t in final_translations]

            combined_results = []
            for i in range(total_elements):
                if i in ocr_failed_indices:
                    if final_translations[i] == "[OCR FAILED]":
                        combined_results.append("[OCR FAILED]")
                    else:
                        log_message(
                            f"Element {i + 1}: LLM ignored OCR failure instruction",
                            verbose=debug,
                        )
                        combined_results.append("[OCR FAILED]")
                else:
                    combined_results.append(final_translations[i])

            cache.set_translation(
                cache_key, combined_results, ocr_texts=extracted_texts
            )
            if ocr_texts_output is not None:
                ocr_texts_output.extend(extracted_texts)
            return combined_results

        elif translation_mode == "one-step":
            log_message("Starting one-step translation", verbose=debug)

            full_page_context = (
                "A full-page image is also provided for visual and narrative context."
                if config.send_full_page_context
                else ""
            )
            previous_page_context = _format_previous_context_prompt_note(
                previous_context_image_count,
                previous_context_text_count,
                (
                    "text crops first, optional current full page, then previous "
                    "source pages oldest-to-newest"
                ),
            )

            special_instructions_section = _format_special_instructions(config) + _format_fix_hint(config)

            one_step_prompt = f"""
## CONTEXT
You have been provided with {total_elements} individual text images from a manga page. {full_page_context}{previous_page_context}
{context_hints}
{previous_text_section}
{context_memory_section}
## TASK
For each image, you must perform two steps:
1.  **Transcribe:** Extract the original text exactly as it appears.
2.  **Translate:** Translate the text you just transcribed into {output_language}, applying your translation and styling rules.{special_instructions_section}
"""  # noqa

            one_step_system = _build_system_prompt_translation(
                output_language,
                mode="one-step",
                reading_direction=reading_direction,
                full_page_context=(
                    config.send_full_page_context and bool(full_image_b64)
                ),
                previous_context_image_count=previous_context_image_count,
                previous_context_text_count=previous_context_text_count,
                input_language=input_language,
                context_memory_enabled=config.context_memory_enabled,
            )
            response_text = _call_llm_endpoint(
                config,
                base_parts,
                one_step_prompt,
                debug,
                system_prompt=one_step_system,
            )
            if config.context_memory_enabled and response_text:
                response_text, memory_note = _extract_memory_note(response_text)
                if memory_note_output is not None and memory_note:
                    memory_note_output.append(memory_note)

            # Parse one-step format ("Original || Translated")
            raw_lines = _parse_llm_response_unified(
                response_text, total_elements, provider, debug
            )

            is_vi_output = "vietnamese" in (output_language or "").lower()
            translations = []
            ocr_texts = []
            for line in raw_lines:
                if "||" in line:
                    parts = line.split("||", 1)
                    ocr_texts.append(parts[0].strip())
                    translated_part = parts[1].strip()
                    if is_vi_output:
                        translated_part = _strip_pronoun_tag(translated_part)
                    translations.append(translated_part)
                else:
                    # Model violated the format — keep the line as the translation
                    # and mark OCR as failed so it isn't reused as prior context.
                    ocr_texts.append("[OCR FAILED]")
                    translations.append(line)

            cache.set_translation(cache_key, translations, ocr_texts=ocr_texts)
            if ocr_texts_output is not None:
                ocr_texts_output.extend(ocr_texts)
            return translations
        else:
            raise TranslationError(
                f"Unknown translation_mode specified in config: {translation_mode}"
            )
    except TranslationError:
        raise
    except (ValueError, RuntimeError) as e:
        log_message(f"Translation error: {e}", always_print=True)
        return [f"[Translation Error: {e}]"] * total_elements


def generate_character_notes(
    config: TranslationConfig,
    images_b64: List[str],
    output_language: str,
    debug: bool = False,
) -> str:
    """One-off LLM call: look at a handful of sample manga pages and draft
    Special Instructions text (cast, apparent relationships, suggested
    pronoun/register choices, tone) for the user to review before saving.

    This is a single explicit, user-triggered call — not something that
    runs automatically per page — so it doesn't touch the translation
    cache or per-page pipeline at all.
    """
    if not images_b64:
        raise TranslationError("No sample images provided.")

    parts = [
        {"inline_data": {"mime_type": "image/jpeg", "data": img}}
        for img in images_b64
    ]

    system_prompt = (
        "You are a manga localization consultant. You will be shown several "
        "sample pages from the SAME manga/comic. Your job is only to draft "
        "concise notes a translator can paste into a style-guide field — "
        "you are not transcribing or translating any dialogue."
    )

    prompt_text = f"""
## TASK
Based only on these sample pages, draft short notes to guide translation
into {output_language}, covering only what you can actually tell from the
art/context (do not invent details you can't support):
- Main recurring characters you can identify (by appearance if no name is
  visible) and their apparent age/gender.
- Apparent relationships between characters (siblings, friends, romantic,
  boss/subordinate, family, strangers, etc.) and, if {output_language}
  uses relationship-based pronouns/register (e.g. Vietnamese xưng hô,
  Japanese pronoun choice), what pairing you'd suggest for each pair.
- Overall tone/register of the dialogue (casual/formal, blunt/polite, any
  recurring verbal tics).
- Any recurring proper nouns, titles, or made-up terms worth keeping
  consistent.

## OUTPUT
Plain bullet points only, no headers, no preamble, no closing remarks —
ready to be pasted directly into a "special instructions" field. If the
sample pages don't give you enough to say anything useful for a bullet,
omit it rather than guessing.
"""

    result = _call_llm_endpoint(
        config, parts, prompt_text, debug=debug, system_prompt=system_prompt
    )
    if not result or not result.strip():
        raise TranslationError("Empty response while generating suggested instructions.")
    return result.strip()


def prepare_bubble_images_for_translation(
    bubble_data: List[Dict[str, Any]],
    original_cv_image: np.ndarray,
    upscale_model: Any,
    device: Any,
    mime_type: str,
    bubble_min_side_pixels: int,
    upscale_method: str = "model_lite",
    whiteout_conjoined_bubbles: bool = True,
    verbose: bool = False,
) -> List[Dict[str, Any]]:
    """
    Prepare bubble images for translation by cropping, upscaling, color matching, and encoding.

    This function processes each speech bubble to prepare it for the translation API:
    1. Crops the bubble from the original image
    2. Upscales the bubble to meet minimum size requirements (based on upscale_method)
    3. Matches colors to preserve visual consistency (only for model upscaling)
    4. Encodes the processed bubble as base64 for API transmission

    Args:
        bubble_data: List of bubble detection dicts with 'bbox' keys
        original_cv_image: OpenCV image array of the original image
        upscale_model: Loaded upscaling model
        device: PyTorch device for model inference
        mime_type: MIME type for image encoding
        upscale_method: Method for upscaling - "model", "lanczos", or "none"
        verbose: Whether to print detailed logging

    Returns:
        List of bubble dicts with added 'image_b64' and 'mime_type' keys
        (immutable approach - returns new list without mutating input)
    """
    cv2_ext = ".png" if mime_type == "image/png" else ".jpg"

    prepared_bubbles = []

    mask_lookup = {}
    for b in bubble_data:
        b_bbox = tuple(int(round(v)) for v in b["bbox"])
        mask_lookup[b_bbox] = b.get("sam_mask")

    if upscale_method == "model":
        log_message(
            f"Upscaling {len(bubble_data)} bubble images with 2x-AnimeSharpV4_RCAN",
            always_print=True,
        )
    elif upscale_method == "model_lite":
        log_message(
            f"Upscaling {len(bubble_data)} bubble images with 2x-AnimeSharpV4_Fast_RCAN_PU (Lite)",
            always_print=True,
        )
    elif upscale_method == "lanczos":
        log_message(
            f"Upscaling {len(bubble_data)} bubble images with LANCZOS",
            always_print=True,
        )
    else:
        log_message(
            f"Processing {len(bubble_data)} bubble images without upscaling",
            always_print=True,
        )

    for bubble in bubble_data:
        prepared_bubble = bubble.copy()
        x1, y1, x2, y2 = bubble["bbox"]

        # Use the tight bbox of the mask
        _mask = bubble.get("sam_mask")
        _ma = None
        if _mask is not None:
            _ma = np.asarray(_mask)
            if _ma.ndim == 3:
                _ma = _ma[..., 0]
            if _ma.ndim == 2:
                _rows, _cols = np.where(_ma > 0)
                if _rows.size and _cols.size:
                    mx1, my1 = int(_cols.min()), int(_rows.min())
                    mx2, my2 = int(_cols.max()) + 1, int(_rows.max()) + 1
                    x1 = min(x1, mx1)
                    y1 = min(y1, my1)
                    x2 = max(x2, mx2)
                    y2 = max(y2, my2)

        bubble_image_cv = original_cv_image[y1:y2, x1:x2].copy()

        # White-out conjoined neighbor text regions visible in this crop
        neighbor_bboxes = bubble.get("conjoined_neighbor_bboxes")
        if whiteout_conjoined_bubbles and neighbor_bboxes:
            own_mask_crop = (
                _ma[y1:y2, x1:x2] > 0 if (_ma is not None and _ma.ndim == 2) else None
            )

            for nb in neighbor_bboxes:
                nb_tuple = tuple(int(round(v)) for v in nb)
                neighbor_mask = mask_lookup.get(nb_tuple)

                if neighbor_mask is not None:
                    _nm = np.asarray(neighbor_mask)
                    if _nm.ndim == 3:
                        _nm = _nm[..., 0]
                    if _nm.ndim == 2:
                        nm_crop = _nm[y1:y2, x1:x2] > 0

                        if own_mask_crop is not None:
                            region_mask = nm_crop & ~own_mask_crop
                        else:
                            region_mask = nm_crop

                        # Apply whiteout precisely on neighbor's mask pixels
                        bubble_image_cv[region_mask] = 255

        bubble_image_pil = cv2_to_pil(bubble_image_cv)

        if upscale_method == "model" or upscale_method == "model_lite":
            final_bubble_pil = process_bubble_image_cached(
                bubble_image_pil,
                upscale_model,
                device,
                bubble_min_side_pixels,
                "min",
                upscale_method,
                verbose,
            )
        elif upscale_method == "lanczos":
            w, h = bubble_image_pil.size
            min_side = min(w, h)
            if min_side < bubble_min_side_pixels:
                scale_factor = bubble_min_side_pixels / min_side
                new_w = int(w * scale_factor)
                new_h = int(h * scale_factor)
                resized_bubble = bubble_image_pil.resize((new_w, new_h), Image.LANCZOS)
            else:
                resized_bubble = bubble_image_pil
            final_bubble_pil = resized_bubble
        else:
            final_bubble_pil = bubble_image_pil

        final_bubble_cv = pil_to_cv2(final_bubble_pil)

        try:
            is_success, buffer = cv2.imencode(cv2_ext, final_bubble_cv)
            if is_success:
                image_b64 = base64.b64encode(buffer).decode("utf-8")
                prepared_bubble["image_b64"] = image_b64
                prepared_bubble["mime_type"] = mime_type
                log_message(
                    f"Bubble {x1},{y1} ({final_bubble_pil.size[0]}x{final_bubble_pil.size[1]})",
                    verbose=verbose,
                )
            else:
                log_message(
                    f"Failed to encode bubble {bubble['bbox']}", verbose=verbose
                )
                prepared_bubble["image_b64"] = None
        except Exception as e:
            log_message(f"Error encoding bubble {bubble['bbox']}: {e}", verbose=verbose)
            prepared_bubble["image_b64"] = None

        prepared_bubbles.append(prepared_bubble)

    return prepared_bubbles
