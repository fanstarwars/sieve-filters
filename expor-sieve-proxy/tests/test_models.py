"""Pydantic-модели: краевые случаи."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from expor_sieve_proxy.models import (
    MAX_SCRIPT_BYTES,
    SCRIPT_WARN_THRESHOLD,
    AddFilterReq,
    DeleteFilterReq,
    EditAttrReq,
    EditFilterReq,
)

VALID_SCRIPT = "# expor-sieve v1 managed\nrequire [\"fileinto\"];\n"
VALID_SCRIPT_V2 = "# expor-sieve v2 managed\nrequire [\"fileinto\"];\n"


def test_add_filter_minimal_ok():
    f = AddFilterReq(
        active=1,
        username="user@example.com",
        script_desc="Спам в архив",
        script_data=VALID_SCRIPT,
    )
    assert f.filter_type == "prefilter"


def test_add_filter_active_zero_ok():
    AddFilterReq(active=0, username="x@y.ru", script_desc="d", script_data=VALID_SCRIPT)


def test_add_filter_active_two_invalid():
    with pytest.raises(ValidationError):
        AddFilterReq(active=2, username="x@y.ru", script_desc="d", script_data=VALID_SCRIPT)


def test_add_filter_bad_email():
    with pytest.raises(ValidationError):
        AddFilterReq(active=1, username="not-an-email", script_desc="d", script_data=VALID_SCRIPT)


def test_add_filter_empty_script():
    with pytest.raises(ValidationError):
        AddFilterReq(active=1, username="x@y.ru", script_desc="d", script_data="")


def test_add_filter_no_marker():
    bad = "require [\"fileinto\"];\n"
    with pytest.raises(ValidationError) as exc:
        AddFilterReq(active=1, username="x@y.ru", script_desc="d", script_data=bad)
    assert "marker" in str(exc.value)


def test_add_filter_marker_on_second_line_invalid():
    bad = "\n# expor-sieve v1 managed\nrequire [\"fileinto\"];\n"
    with pytest.raises(ValidationError):
        AddFilterReq(active=1, username="x@y.ru", script_desc="d", script_data=bad)


def test_add_filter_too_large():
    # Гарантированно превышает MAX_SCRIPT_BYTES (65_000 на v2).
    big = "# expor-sieve v1 managed\n" + "x" * (MAX_SCRIPT_BYTES + 100)
    with pytest.raises(ValidationError):
        AddFilterReq(active=1, username="x@y.ru", script_desc="d", script_data=big)


def test_max_script_bytes_is_65000():
    """Лимит подбит впритык к MySQL TEXT (65535) — оставляет запас на metadata."""
    assert MAX_SCRIPT_BYTES == 65_000


def test_warn_threshold_below_limit():
    """SCRIPT_WARN_THRESHOLD должен быть строго меньше MAX_SCRIPT_BYTES."""
    assert SCRIPT_WARN_THRESHOLD < MAX_SCRIPT_BYTES


def test_add_filter_just_under_limit_ok():
    """script ровно на границе MAX_SCRIPT_BYTES должен пройти."""
    # 24 bytes для маркера + перевода строки
    header = "# expor-sieve v2 managed\n"
    pad = "x" * (MAX_SCRIPT_BYTES - len(header.encode("utf-8")))
    AddFilterReq(active=1, username="x@y.ru", script_desc="d", script_data=header + pad)


def test_add_filter_v2_marker_ok():
    """v2 combined-script marker also accepted."""
    f = AddFilterReq(
        active=1,
        username="x@y.ru",
        script_desc="combined",
        script_data=VALID_SCRIPT_V2,
    )
    assert f.script_data.startswith("# expor-sieve v2 managed")


def test_add_filter_control_char_blocked():
    bad = "# expor-sieve v1 managed\nrequire \x07 evil;"
    with pytest.raises(ValidationError) as exc:
        AddFilterReq(active=1, username="x@y.ru", script_desc="d", script_data=bad)
    assert "control" in str(exc.value)


def test_add_filter_allowed_whitespace_ok():
    ok = "# expor-sieve v1 managed\n\trequire [\"fileinto\"];\r\n"
    AddFilterReq(active=1, username="x@y.ru", script_desc="d", script_data=ok)


def test_add_filter_long_desc_blocked():
    with pytest.raises(ValidationError):
        AddFilterReq(
            active=1, username="x@y.ru", script_desc="x" * 201, script_data=VALID_SCRIPT
        )


def test_add_filter_postfilter_ok():
    f = AddFilterReq(
        active=1,
        username="x@y.ru",
        script_desc="d",
        script_data=VALID_SCRIPT,
        filter_type="postfilter",
    )
    assert f.filter_type == "postfilter"


def test_add_filter_unknown_filter_type():
    with pytest.raises(ValidationError):
        AddFilterReq(
            active=1,
            username="x@y.ru",
            script_desc="d",
            script_data=VALID_SCRIPT,
            filter_type="weirdfilter",
        )


# ----- Edit ----- #


def test_edit_attr_partial_ok():
    a = EditAttrReq(active=0)
    assert a.script_data is None


def test_edit_attr_script_with_marker_ok():
    a = EditAttrReq(script_data=VALID_SCRIPT)
    assert a.script_data.startswith("# expor-sieve v1 managed")


def test_edit_attr_script_no_marker_invalid():
    with pytest.raises(ValidationError):
        EditAttrReq(script_data="bad")


def test_edit_attr_script_v2_marker_ok():
    a = EditAttrReq(script_data=VALID_SCRIPT_V2)
    assert a.script_data.startswith("# expor-sieve v2 managed")


def test_edit_filter_items_must_be_one():
    with pytest.raises(ValidationError):
        EditFilterReq(items=[], attr=EditAttrReq())
    with pytest.raises(ValidationError):
        EditFilterReq(items=[1, 2], attr=EditAttrReq())


def test_edit_filter_ok():
    e = EditFilterReq(items=[42], attr=EditAttrReq(active=0))
    assert e.items == [42]
    assert e.attr.active == 0


# ----- Delete ----- #


def test_delete_one_id():
    d = DeleteFilterReq.model_validate([5])
    assert d.root == [5]


def test_delete_must_have_one():
    with pytest.raises(ValidationError):
        DeleteFilterReq.model_validate([])
    with pytest.raises(ValidationError):
        DeleteFilterReq.model_validate([1, 2])
