"""User replacement dictionaries (popup Pro tab): deterministic find/replace
rules applied to the source text before translation ("pre") and to the
translation before rendering ("post") — for the fixes an LLM keeps getting
wrong no matter how it's prompted (a name's romanisation, a forbidden word,
a punctuation habit).

One rule per line:

    find => replace            literal, case-sensitive
    /pattern/ => replace       regular expression (\\1 or $1 for groups)
    /pattern/i => replace      ... case-insensitive
    # comment                  ignored, as are blank lines

The replacement may be empty (deletes the match). Rules run top to bottom,
each on the previous one's output. Lines that don't parse (no "=>", invalid
regex) are skipped rather than failing the request.

Uses the third-party `regex` module rather than `re` for its per-call
timeout: patterns are user-supplied, and on a hosted deployment one
catastrophically-backtracking pattern must not pin a worker thread.
"""
from dataclasses import dataclass
from typing import List, Optional, Union

import regex

from utils.logging import log_message

MAX_RULES = 200
MAX_LINE_CHARS = 500
REGEX_TIMEOUT_SECONDS = 0.2

_REGEX_LINE = regex.compile(r"^/(.+)/([a-z]*)$")
_DOLLAR_GROUP = regex.compile(r"\$(\d+)")


@dataclass(frozen=True)
class Rule:
    find: str
    replace: str
    pattern: Optional["regex.Pattern"] = None  # set for /regex/ rules

    @property
    def is_regex(self) -> bool:
        return self.pattern is not None


def parse_rules(text: Optional[str]) -> List[Rule]:
    rules: List[Rule] = []
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or len(line) > MAX_LINE_CHARS:
            continue
        if "=>" not in line:
            continue
        find, replace = line.split("=>", 1)
        find, replace = find.strip(), replace.strip()
        if not find:
            continue
        m = _REGEX_LINE.match(find)
        if m and set(m.group(2)) <= {"i"}:
            flags = regex.IGNORECASE if "i" in m.group(2) else 0
            try:
                pattern = regex.compile(m.group(1), flags | regex.V0)
            except regex.error as e:
                log_message(f"Replacement rule skipped (invalid regex {find!r}): {e}", always_print=True)
                continue
            rules.append(Rule(find, _DOLLAR_GROUP.sub(r"\\g<\1>", replace), pattern))
        else:
            rules.append(Rule(find, replace))
        if len(rules) >= MAX_RULES:
            break
    return rules


def apply_rules(text: str, rules: Union[str, List[Rule], None]) -> str:
    if isinstance(rules, str) or rules is None:
        rules = parse_rules(rules)
    if not text or not rules:
        return text
    for rule in rules:
        if rule.pattern is None:
            text = text.replace(rule.find, rule.replace)
            continue
        try:
            text = rule.pattern.sub(rule.replace, text, timeout=REGEX_TIMEOUT_SECONDS)
        except TimeoutError:
            log_message(f"Replacement rule {rule.find!r} timed out; skipped", always_print=True)
        except (regex.error, IndexError) as e:  # e.g. \2 with only one group
            log_message(f"Replacement rule {rule.find!r} failed ({e}); skipped", always_print=True)
    return text


def format_rules_for_prompt(rules: Union[str, List[Rule], None]) -> str:
    """For one-step mode, where the model reads the text straight off the
    image and there's no source string to rewrite: pass the literal pre
    rules along as instructions instead (best effort, not deterministic).
    Regex rules are left out — a model can't be relied on to apply them."""
    if isinstance(rules, str) or rules is None:
        rules = parse_rules(rules)
    literal = [r for r in rules if not r.is_regex]
    if not literal:
        return ""
    lines = "\n".join(
        f'- "{r.find}" → "{r.replace}"' if r.replace else f'- "{r.find}" → (remove)' for r in literal
    )
    return (
        "\n\n## SOURCE TEXT CORRECTIONS\n"
        "When you read these strings in the source text, treat them as the replacement "
        "before translating:\n" + lines + "\n"
    )


_WORD_CHAR = "A-Za-z0-9_"


def _guarded(literal: str) -> str:
    """Escape `literal` and, where its edge is a Latin word character, keep the
    match from starting/ending in the middle of a longer word ("Kage" must not
    fire inside "Kagerou"). CJK edges get no guard — there are no spaces to
    anchor to, and \\w would wrongly treat neighbouring CJK text as a word."""
    out = regex.escape(literal)
    if regex.match(f"[{_WORD_CHAR}]", literal[0]):
        out = f"(?<![{_WORD_CHAR}])" + out
    if regex.match(f"[{_WORD_CHAR}]", literal[-1]):
        out = out + f"(?![{_WORD_CHAR}])"
    return out


def _glossary_variants(value: Optional[str]) -> List[str]:
    return [v.strip() for v in regex.split(r"[,\n;，、；]", value or "") if v.strip()]


def apply_glossary(text: str, terms) -> str:
    """Story DB glossary "enforce exactly" (rows with `enforce` set): rewrite
    each such row's `term` and `variants` found in the translation to the
    row's `translation`, case-insensitively.

    Deliberately can only fix what the model actually wrote — the term's own
    spelling (typically the source/romanised form left in the output) or a
    variant the user listed. An alternative translation nobody listed is
    unknowable here.

    One pass over `text` with one alternation, longest match first: text a
    rule just produced is never re-scanned (so "Shadow" -> "Shadow Style"
    can't expand into "Shadow Style Style"), and the row's own translation is
    an identity alternative so it also wins over a shorter variant inside it.
    """
    if not text:
        return text
    mapping: dict = {}
    for row in terms or []:
        if not getattr(row, "enforce", False):
            continue
        target = (getattr(row, "translation", "") or "").strip()
        if not target:
            continue
        for source in [target, (row.term or "").strip(), *_glossary_variants(getattr(row, "variants", None))]:
            if source:
                mapping.setdefault(source.casefold(), (source, target))
    if not mapping:
        return text
    alternatives = sorted((source for source, _ in mapping.values()), key=len, reverse=True)
    pattern = regex.compile("|".join(_guarded(s) for s in alternatives), regex.IGNORECASE | regex.V0)
    try:
        return pattern.sub(lambda m: mapping.get(m.group(0).casefold(), (None, m.group(0)))[1], text, timeout=REGEX_TIMEOUT_SECONDS)
    except TimeoutError:
        log_message("Glossary enforcement timed out; skipped", always_print=True)
        return text
