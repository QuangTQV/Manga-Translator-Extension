"""User replacement dictionaries (Pro tab) — core/text/replacements.py and
where they're applied: the two-step translate prompt (pre, exact), the
one-step prompt (pre, as a hint), /region/translate (pre + post) and the
page pipeline (post, after the translation cache)."""
import base64
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
from core.caching import get_cache
from core.config import TranslationConfig
from core.text.replacements import apply_rules, format_rules_for_prompt, parse_rules

client = TestClient(main.app, raise_server_exceptions=False)
OPTS = {"provider": "Google", "input_language": "Japanese", "output_language": "English"}


def test_literal_and_regex_rules_run_in_order():
    rules = """
# names
Akila => Akira
/\\bmr\\.?\\s+(\\w+)/i => $1-san
colour => color
um... =>
"""
    assert apply_rules("um...Mr. Tanaka met Akila, colour!", rules) == "Tanaka-san met Akira, color!"
    # Each rule sees the previous one's output.
    assert apply_rules("a", "a => b\nb => c") == "c"


def test_bad_lines_are_skipped_not_fatal():
    rules = parse_rules("no arrow here\n => nothing to find\n/(unclosed/ => x\n/x/g => y\nok => fine")
    # "/x/g" has an unsupported flag, so it's taken as a literal "/x/g".
    assert [(r.find, r.is_regex) for r in rules] == [("/x/g", False), ("ok", False)]
    assert apply_rules("ok", rules) == "fine"


def test_missing_group_reference_skips_that_rule():
    assert apply_rules("abc", "/(b)/ => \\2\nc => C") == "abC"


def test_catastrophic_regex_times_out_instead_of_hanging():
    start = time.monotonic()
    out = apply_rules("a" * 40 + "!", "/(a+)+$/ => x")
    assert out == "a" * 40 + "!"
    assert time.monotonic() - start < 5


def test_prompt_hint_lists_only_literal_rules():
    hint = format_rules_for_prompt("Akila => Akira\n/\\d+/ => N\nuh =>")
    assert '"Akila" → "Akira"' in hint and '"uh" → (remove)' in hint
    assert "\\d" not in hint
    assert format_rules_for_prompt("/\\d+/ => N") == ""
    assert format_rules_for_prompt("") == ""


def test_cache_key_tracks_pre_rules_but_not_post_rules():
    cache = get_cache()

    def key(**kw):
        return cache.get_translation_cache_key(["AAAA"], "", TranslationConfig(temperature=0.0, **kw))  # deterministic, so cached

    assert key() != key(pre_replacements="a => b")
    assert key() == key(post_replacements="a => b")


# ---------------------------------------------------------------------------
# call_translation_api_batch prompts
# ---------------------------------------------------------------------------
def _capture(monkeypatch, config, ocr_texts=None):
    import core.services.translation as tr

    calls = []

    def fake_call(cfg, parts, prompt, *args, **kwargs):
        calls.append(prompt)
        return "1: hello"

    monkeypatch.setattr(tr, "_call_llm_endpoint", fake_call)
    monkeypatch.setattr(tr, "_perform_manga_ocr", lambda *a, **k: list(ocr_texts or []))
    monkeypatch.setattr(tr, "get_cache", lambda: type("C", (), {
        "get_translation_cache_key": lambda *a, **k: None,
        "get_translation": lambda *a, **k: (None, None),
        "set_translation": lambda *a, **k: None,
    })())
    ocr_out = []
    try:
        tr.call_translation_api_batch(
            config, ["AAAA"], "", ["image/png"], "image/png", [{}], ocr_texts_output=ocr_out,
        )
    except Exception:
        pass  # response parsing isn't under test — only what was sent
    return calls, ocr_out


def _config(**kw):
    return TranslationConfig(
        provider="Google", google_api_key="k", model_name="gemini-2.5-flash",
        send_full_page_context=False, pre_replacements="Akila => Akira", **kw,
    )


def test_two_step_rewrites_the_ocr_text_sent_for_translation(monkeypatch):
    calls, ocr_out = _capture(
        monkeypatch, _config(translation_mode="two-step", ocr_method="manga-ocr"), ["Akila desu"]
    )
    assert "1: Akira desu" in calls[-1]
    assert "Akila" not in calls[-1]
    assert ocr_out == ["Akila desu"]  # reported OCR stays what was actually read


def test_one_step_passes_the_rules_as_a_prompt_hint(monkeypatch):
    calls, _ = _capture(monkeypatch, _config(translation_mode="one-step", ocr_method="LLM"))
    assert "## SOURCE TEXT CORRECTIONS" in calls[-1]
    assert '"Akila" → "Akira"' in calls[-1]


# ---------------------------------------------------------------------------
# /region/translate
# ---------------------------------------------------------------------------
def test_region_translate_applies_pre_and_post_rules(monkeypatch):
    import endpoints.regions as regions

    captured = {}

    def fake_call(config, parts, prompt, *args, **kwargs):
        captured["prompt"] = prompt
        return "Hello Akira-kun"

    monkeypatch.setattr(regions, "_call_llm_endpoint", fake_call)
    resp = client.post("/region/translate", json={
        **OPTS, "text": "アキラくん", "pre_replacements": "アキラ => 晃",
        "post_replacements": "-kun =>",
    })
    assert resp.status_code == 200
    assert "晃くん" in captured["prompt"]
    assert resp.json() == {"translation": "Hello Akira"}


# ---------------------------------------------------------------------------
# Page pipeline: post rules land in the rendered bubbles (needs the YOLO
# detector weights; skipped on a fresh checkout without them).
# ---------------------------------------------------------------------------
PAGE = Path(__file__).resolve().parents[2] / "extension/tests/fixtures/test-site/page1.jpg"
YOLO_DIR = Path(__file__).resolve().parents[1] / "models/yolo"


@pytest.mark.skipif(
    not PAGE.exists() or not any(YOLO_DIR.glob("*.pt")), reason="needs the sample page and YOLO weights"
)
def test_translate_applies_post_rules_to_every_valid_bubble(monkeypatch):
    import core.pipeline as pipeline

    def fake_batch(config, images_b64, *args, **kwargs):
        texts = ["Hello Akila!"] * len(images_b64)
        if len(texts) > 1:
            texts[-1] = "[Translation Error: boom]"  # error text is left alone
        return texts

    monkeypatch.setattr(pipeline, "call_translation_api_batch", fake_batch)
    resp = client.post("/translate", json={
        **OPTS, "api_key": "k", "image": base64.b64encode(PAGE.read_bytes()).decode(),
        "post_replacements": "Akila => Akira",
    })
    assert resp.status_code == 200, resp.text
    translations = [b["translated_text"] for b in resp.json()["bubbles"]]
    assert translations, "expected detected bubbles on the sample page"
    assert all("Akila" not in t for t in translations)
    assert "Hello Akira!" in translations
