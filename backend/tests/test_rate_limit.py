from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from unittest.mock import MagicMock

import pytest
from requests.structures import CaseInsensitiveDict

from utils.rate_limit import extract_retry_after_seconds


def _response(headers: dict):
    resp = MagicMock()
    resp.headers = CaseInsensitiveDict(headers)
    return resp


@pytest.mark.parametrize(
    "header_value,expected",
    [
        ("42", 42.0),
        ("12.5", 12.5),
        ("0", 0.0),
        ("-30", 0.0),  # negative delta clamps to 0, never a negative cooldown
        ("  15  ", 15.0),  # surrounding whitespace tolerated
    ],
)
def test_delta_seconds_form(header_value, expected):
    assert extract_retry_after_seconds(_response({"Retry-After": header_value})) == expected


def test_missing_header_returns_none():
    assert extract_retry_after_seconds(_response({})) is None


def test_unparseable_value_returns_none():
    assert extract_retry_after_seconds(_response({"Retry-After": "banana"})) is None


@pytest.mark.parametrize("header_name", ["Retry-After", "retry-after", "rEtRy-AfTeR"])
def test_header_lookup_is_case_insensitive(header_name):
    # requests.Response.headers is a CaseInsensitiveDict in production — a
    # server sending a lowercase header (common over HTTP/2) must still be
    # found regardless of the exact casing used here.
    assert extract_retry_after_seconds(_response({header_name: "99"})) == 99.0


def test_http_date_form_in_the_future():
    future = datetime.now(timezone.utc) + timedelta(seconds=180)
    result = extract_retry_after_seconds(_response({"Retry-After": format_datetime(future)}))
    assert result is not None
    assert 170 <= result <= 190


def test_http_date_form_in_the_past_clamps_to_zero():
    past = datetime.now(timezone.utc) - timedelta(seconds=180)
    assert extract_retry_after_seconds(_response({"Retry-After": format_datetime(past)})) == 0.0
