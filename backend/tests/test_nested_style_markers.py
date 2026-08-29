"""core/text/text_processing.py — a real production bubble came back from
the LLM as "**Cậu ấy làm sao mà biết rõ *đến thế* được.**": the whole line
bolded, with an inner *italic* span nested inside it (instead of the
explicit ***bold-italic*** the prompt asks for). parse_styled_segments()
only resolved one marker level, so the inner *...* was left as literal,
unparsed text inside the outer bold segment — and tokenize_styled_text()'s
naive per-word rewrap (using only the outer "**" marker) split the inner
pair across two separate word tokens whenever a line broke between them,
leaving stray "*" characters baked into the rendered image."""
from core.text.text_processing import parse_styled_segments, tokenize_styled_text


def test_nested_bold_and_italic_resolves_to_combined_style():
    text = "**Cậu ấy làm sao mà biết rõ *đến thế* được.**"
    segments = parse_styled_segments(text)

    assert segments == [
        ("Cậu ấy làm sao mà biết rõ ", "bold"),
        ("đến thế", "bold_italic"),
        (" được.", "bold"),
    ]
    # No literal asterisk should survive into any segment's text.
    assert all("*" not in txt for txt, _ in segments)


def test_non_nested_markers_still_parse_as_before():
    text = "Cậu ấy làm sao mà biết rõ *đến thế* được."
    assert parse_styled_segments(text) == [
        ("Cậu ấy làm sao mà biết rõ ", "regular"),
        ("đến thế", "italic"),
        (" được.", "regular"),
    ]


def test_explicit_bold_italic_marker_still_works():
    assert parse_styled_segments("***BOOM***") == [("BOOM", "bold_italic")]


def test_tokenized_nested_words_carry_their_own_self_contained_markers():
    # Each word from the nested italic span must be individually wrapped
    # with its OWN resolved marker (***) rather than only the outer bold
    # marker (**) — otherwise, whichever word a line-break lands between,
    # the other half of the inner *...* pair is stranded on a different
    # line and can never be re-parsed back out.
    tokens = tokenize_styled_text("**Cậu ấy *đến thế* được.**")
    token_texts = [t for t, _ in tokens]

    assert "***đến***" in token_texts
    assert "***thế***" in token_texts
    # No token should carry a lone, unpaired asterisk.
    for t in token_texts:
        assert t.count("*") in (0, 2, 4, 6)


def test_line_broken_mid_nested_span_still_parses_clean_on_each_line():
    # Simulates what the line-wrapper produces when it breaks a line
    # between the two words of the inner nested italic span.
    tokens = [t for t, _ in tokenize_styled_text("**Cậu ấy *đến thế* được.**")]
    idx = tokens.index("***đến***")
    line1 = " ".join(tokens[: idx + 1])
    line2 = " ".join(tokens[idx + 1 :])

    for line in (line1, line2):
        segments = parse_styled_segments(line)
        assert all("*" not in txt for txt, _ in segments)
