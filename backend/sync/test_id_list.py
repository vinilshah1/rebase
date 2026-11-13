"""Unit, differential, and property coverage for the Python identity list."""

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Literal, TypedDict, cast

import pytest
from hypothesis import given
from hypothesis import strategies as st

from sync.id_list import (
    MAX_SAFE_INTEGER,
    Bias,
    ElementId,
    IdList,
    IdListError,
    SavedRun,
    utf16_len,
    utf16_units,
)


class WireId(TypedDict):
    bunchId: str
    counter: int


class FixtureOp(TypedDict):
    type: Literal["insert", "delete"]
    beforeId: WireId | None
    newId: WireId
    count: int
    targetId: WireId


class IndexEntry(TypedDict):
    id: WireId
    none: int
    left: int
    right: int


class Checkpoint(TypedDict):
    opCount: int
    save: list[SavedRun]
    known: list[tuple[str, int, bool]]
    at: list[WireId]
    indexOf: list[IndexEntry]


class ErrorArgs(TypedDict):
    beforeId: WireId | None
    newId: WireId
    count: int
    id: WireId
    bias: Bias
    index: int


class ErrorCase(TypedDict):
    case: str
    args: ErrorArgs
    throws: bool
    message: str | None


class FixtureCase(TypedDict):
    seed: int
    ops: list[FixtureOp]
    checkpoints: list[Checkpoint]
    errors: list[ErrorCase]


class FixtureSet(TypedDict):
    format: str
    cases: list[FixtureCase]


def element_id(value: WireId) -> ElementId:
    return ElementId(value["bunchId"], value["counter"])


def fixture_cases() -> list[FixtureCase]:
    path = Path(__file__).resolve().parents[2] / "shared/fixtures/idlist_vectors.json"
    fixture = cast(FixtureSet, json.loads(path.read_text()))
    assert fixture["format"] == "idlist-vectors-v1"
    return fixture["cases"]


def assert_checkpoint(ids: IdList, checkpoint: Checkpoint) -> None:
    assert ids.expand() == [tuple(row) for row in checkpoint["known"]]
    assert ids.known_length == len(checkpoint["known"])
    assert len(ids) == len(checkpoint["at"])
    assert [ids.at(i) for i in range(len(ids))] == [element_id(x) for x in checkpoint["at"]]
    for entry in checkpoint["indexOf"]:
        target = element_id(entry["id"])
        for bias in ("none", "left", "right"):
            assert ids.index_of(target, bias) == entry[bias]
        assert ids.is_known(target)
        assert ids.has(target) == (entry["none"] >= 0)
        assert ids.visible_index_after(target) == entry["left"] + 1
    assert IdList.load(checkpoint["save"]).expand() == ids.expand()
    assert IdList.load(ids.save()).expand() == ids.expand()


def error_action(ids: IdList, error: ErrorCase) -> Callable[[], object]:
    args = error["args"]
    match error["case"]:
        case "insertAfter-unknown-anchor" | "insertAfter-known-newId":
            anchor = args["beforeId"]
            return lambda: ids.insert_after(
                None if anchor is None else element_id(anchor),
                element_id(args["newId"]),
                args["count"],
            )
        case "indexOf-unknown-id":
            return lambda: ids.index_of(element_id(args["id"]), args["bias"])
        case "at-out-of-bounds":
            return lambda: ids.at(args["index"])
        case "delete-unknown-id":
            return lambda: ids.delete(element_id(args["id"]))
        case _:
            raise AssertionError(f"Unhandled fixture error: {error['case']}")


@pytest.mark.parametrize("fixture", fixture_cases(), ids=lambda f: str(f["seed"]))
def test_differential_vectors(fixture: FixtureCase, tmp_path: Path) -> None:
    ids = IdList()
    checkpoints = {c["opCount"]: c for c in fixture["checkpoints"]}
    assert_checkpoint(ids, checkpoints[0])
    for count, op in enumerate(fixture["ops"], 1):
        if op["type"] == "insert":
            anchor = op["beforeId"]
            ids.insert_after(
                None if anchor is None else element_id(anchor), element_id(op["newId"]), op["count"]
            )
        else:
            ids.delete(element_id(op["targetId"]))
        if count in checkpoints:
            assert_checkpoint(ids, checkpoints[count])
    for error in fixture["errors"]:
        before = ids.expand()
        action = error_action(ids, error)
        if error["throws"]:
            expected_type = IndexError if error["case"] == "at-out-of-bounds" else IdListError
            with pytest.raises(expected_type, match=f"^{re.escape(error['message'] or '')}$"):
                action()
        else:
            action()
        assert ids.expand() == before
    # Exercise the JSON boundary without modifying the committed shared fixtures.
    output = tmp_path / "python_roundtrip.json"
    _ = output.write_text(json.dumps(ids.save()))
    saved = cast(list[SavedRun], json.loads(output.read_text()))
    assert IdList.load(saved).expand() == ids.expand()


def test_empty_and_unknown() -> None:
    ids = IdList()
    unknown = ElementId("unknown", 0)
    assert len(ids) == ids.known_length == 0
    assert ids.save() == ids.expand() == []
    assert not ids.has(unknown) and not ids.is_known(unknown)
    assert ids.visible_index_after(None) == 0
    ids.delete(unknown)
    for bias in ("none", "left", "right"):
        with pytest.raises(IdListError, match="id is not known"):
            ids.index_of(unknown, bias)
    with pytest.raises(IdListError):
        ids.visible_index_after(unknown)
    for index in (-1, 0, 1):
        with pytest.raises(IndexError):
            ids.at(index)


def test_tombstones_and_position_rule() -> None:
    ids = IdList()
    ids.insert_after(None, ElementId("a", 0), 5)
    for counter in (0, 2, 3, 4):
        ids.delete(ElementId("a", counter))
        ids.delete(ElementId("a", counter))
    assert ids.known_length == 5 and len(ids) == 1
    assert ids.at(0) == ElementId("a", 1)
    for counter, expected in [(0, (-1, -1, 0)), (1, (0, 0, 0)), (2, (-1, 0, 1)),
                              (3, (-1, 0, 1)), (4, (-1, 0, 1))]:
        target = ElementId("a", counter)
        assert tuple(ids.index_of(target, b) for b in ("none", "left", "right")) == expected
    anchor = ElementId("a", 2)
    assert ids.visible_index_after(anchor) == 1
    ids.insert_after(anchor, ElementId("b", 0), 2)
    assert [ids.at(i) for i in range(len(ids))] == [
        ElementId("a", 1), ElementId("b", 0), ElementId("b", 1)
    ]
    ids.insert_after(None, ElementId("c", 0))
    assert ids.expand()[0] == ("c", 0, False)
    ids.delete(ElementId("a", 1))
    assert ids.is_known(ElementId("a", 1)) and not ids.has(ElementId("a", 1))


def test_same_anchor_reverse_order() -> None:
    ids = IdList()
    anchor = ElementId("x", 0)
    ids.insert_after(None, anchor)
    ids.insert_after(anchor, ElementId("a", 0))
    ids.insert_after(anchor, ElementId("b", 0))
    assert ids.expand() == [("x", 0, False), ("b", 0, False), ("a", 0, False)]


@pytest.mark.parametrize("deleted", [False, True])
def test_insert_atomicity(deleted: bool) -> None:
    ids = IdList()
    ids.insert_after(None, ElementId("a", 3))
    if deleted:
        ids.delete(ElementId("a", 3))
    before = ids.expand()
    # Duplicate is late in the range: the fresh prefix must not be inserted.
    with pytest.raises(IdListError, match="An inserted id is already known"):
        ids.insert_after(None, ElementId("a", 0), 5)
    assert ids.expand() == before
    with pytest.raises(IdListError, match="before is not known"):
        ids.insert_after(ElementId("missing", 0), ElementId("fresh", 0), 3)
    assert ids.expand() == before


@pytest.mark.parametrize("counter,count", [(-1, 1), (0, 0), (0, -1), (True, 1),
                                           (0, True), (MAX_SAFE_INTEGER + 1, 1),
                                           (MAX_SAFE_INTEGER, 2)])
def test_invalid_insert_ranges(counter: int, count: int) -> None:
    ids = IdList()
    with pytest.raises(IdListError):
        ids.insert_after(None, ElementId("a", counter), count)
    assert ids.expand() == []


def test_save_load_runs_and_independence() -> None:
    saved: list[SavedRun] = [
        {"bunchId": "a", "startCounter": 0, "count": 0, "isDeleted": False},
        {"bunchId": "a", "startCounter": 0, "count": 2, "isDeleted": False},
        {"bunchId": "a", "startCounter": 2, "count": 1, "isDeleted": False},
        {"bunchId": "a", "startCounter": 3, "count": 2, "isDeleted": True},
        {"bunchId": "a", "startCounter": 9, "count": 1, "isDeleted": True},
        {"bunchId": "b", "startCounter": 0, "count": 1, "isDeleted": True},
    ]
    ids = IdList.load(saved)
    assert ids.save() == [
        {"bunchId": "a", "startCounter": 0, "count": 3, "isDeleted": False},
        *saved[3:],
    ]
    clone = IdList.load(ids.save())
    clone.delete(ElementId("a", 0))
    assert ids.has(ElementId("a", 0))
    exported = ids.save()
    exported[0]["count"] = 99
    assert ids.known_length == 7
    ids.insert_after(None, ElementId("limit", MAX_SAFE_INTEGER))
    assert IdList.load(ids.save()).expand() == ids.expand()


@pytest.mark.parametrize("saved", [
    [{"bunchId": "a", "startCounter": 0, "count": 2, "isDeleted": False},
     {"bunchId": "a", "startCounter": 1, "count": 2, "isDeleted": True}],
    [{"bunchId": "a", "startCounter": -1, "count": 1, "isDeleted": False}],
    [{"bunchId": "a", "startCounter": 0, "count": -1, "isDeleted": False}],
    [{"bunchId": "a", "startCounter": MAX_SAFE_INTEGER, "count": 2, "isDeleted": False}],
])
def test_invalid_saved_runs(saved: list[SavedRun]) -> None:
    with pytest.raises(IdListError):
        IdList.load(saved)


@given(st.lists(st.tuples(st.booleans(), st.integers(0, 200), st.integers(1, 4)), max_size=80))
def test_properties(actions: list[tuple[bool, int, int]]) -> None:
    ids = IdList()
    model: list[tuple[str, int, bool]] = []
    next_counter = 0
    for insert, choice, count in actions:
        if insert or not model:
            position = choice % (len(model) + 1)
            anchor = None if position == 0 else ElementId("property", model[position - 1][1])
            ids.insert_after(anchor, ElementId("property", next_counter), count)
            model[position:position] = [
                ("property", c, False) for c in range(next_counter, next_counter + count)
            ]
            next_counter += count
        else:
            position = choice % len(model)
            bunch, counter, _ = model[position]
            ids.delete(ElementId(bunch, counter))
            model[position] = (bunch, counter, True)
        assert ids.expand() == model
        visible = [ElementId(b, c) for b, c, deleted in model if not deleted]
        assert len(ids) == len(visible)
        assert ids.known_length == len(model)
        for index, target in enumerate(visible):
            assert ids.at(index) == target
            assert ids.at(ids.index_of(target)) == target
        assert IdList.load(ids.save()).expand() == model


def test_utf16_units() -> None:
    text = "a\U0001f600\ud800z"
    units = utf16_units(text)
    assert units == ["a", "\ud83d", "\ude00", "\ud800", "z"]
    assert utf16_len(text) == len(units) == 5
    assert utf16_units("") == [] and utf16_len("") == 0
    assert utf16_units("".join(units)) == units
    ids = IdList()
    ids.insert_after(None, ElementId("unicode", 0), len(units))
    index = ids.index_of(ElementId("unicode", 1))
    del units[index]
    ids.delete(ElementId("unicode", 1))
    assert len(ids) == len(units) == 4
    assert units[1] == "\ude00"
    assert json.loads(json.dumps("".join(units))) == "".join(units)


@pytest.mark.parametrize("saved", [
    None, {}, [1], [{}],
    [{"bunchId": "", "startCounter": 0, "count": 1, "isDeleted": False}],
    [{"bunchId": "x" * 129, "startCounter": 0, "count": 1, "isDeleted": False}],
    [{"bunchId": 12, "startCounter": 0, "count": 1, "isDeleted": False}],
    [{"bunchId": "a", "startCounter": 0.5, "count": 1, "isDeleted": False}],
    [{"bunchId": "a", "startCounter": True, "count": 1, "isDeleted": False}],
    [{"bunchId": "a", "startCounter": 0, "count": 1.5, "isDeleted": False}],
    [{"bunchId": "a", "startCounter": 0, "count": True, "isDeleted": False}],
    [{"bunchId": "a", "startCounter": 0, "count": 1, "isDeleted": 1}],
])
def test_malformed_saved_state(saved: object) -> None:
    with pytest.raises(IdListError):
        IdList.load(saved)
