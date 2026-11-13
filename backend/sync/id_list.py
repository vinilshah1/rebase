"""Mutable, flat-list port of articulated's identity list (text is stored separately)."""

from dataclasses import dataclass
from typing import Literal, TypedDict, cast

MAX_SAFE_INTEGER = 2**53 - 1


class IdListError(ValueError):
    """Invalid identity-list input or an unknown required identity."""


@dataclass(frozen=True)
class ElementId:
    bunch_id: str
    counter: int


@dataclass
class Element:
    bunch_id: str
    counter: int
    is_deleted: bool = False


class SavedRun(TypedDict):
    bunchId: str
    startCounter: int
    count: int
    isDeleted: bool


Bias = Literal["none", "left", "right"]


def _validate_range(bunch_id: object, counter: int, count: int, *, allow_empty: bool) -> None:
    if not isinstance(bunch_id, str) or not 1 <= len(bunch_id) <= 128:
        raise IdListError("bunchId must be a non-empty string of at most 128 characters")
    for value in (counter, count):
        if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
            raise IdListError("Counters and counts must be non-negative safe integers")
    if not allow_empty and count == 0:
        raise IdListError("count must be positive")
    if count and counter + count - 1 > MAX_SAFE_INTEGER:
        raise IdListError("ID range exceeds the JavaScript safe-integer limit")


class IdList:
    """Known-list order includes tombstones; visible indices exclude them."""

    def __init__(self) -> None:
        self._elements: list[Element] = []

    def __len__(self) -> int:
        return sum(not element.is_deleted for element in self._elements)

    @property
    def known_length(self) -> int:
        return len(self._elements)

    def _find(self, target_id: ElementId) -> int | None:
        for index, element in enumerate(self._elements):
            if (element.bunch_id, element.counter) == (target_id.bunch_id, target_id.counter):
                return index
        return None

    def is_known(self, target_id: ElementId) -> bool:
        return self._find(target_id) is not None

    def has(self, target_id: ElementId) -> bool:
        index = self._find(target_id)
        return index is not None and not self._elements[index].is_deleted

    def at(self, index: int) -> ElementId:
        if type(index) is int and index >= 0:
            visible = 0
            for element in self._elements:
                if not element.is_deleted:
                    if visible == index:
                        return ElementId(element.bunch_id, element.counter)
                    visible += 1
        raise IndexError(f"Index out of bounds: {index} (length: {len(self)})")

    def index_of(self, target_id: ElementId, bias: Bias = "none") -> int:
        if bias not in ("none", "left", "right"):
            raise IdListError("Invalid index bias")
        visible = 0
        for element in self._elements:
            if (element.bunch_id, element.counter) == (target_id.bunch_id, target_id.counter):
                if not element.is_deleted:
                    return visible
                return {"none": -1, "left": visible - 1, "right": visible}[bias]
            if not element.is_deleted:
                visible += 1
        raise IdListError("id is not known")

    def visible_index_after(self, before_id: ElementId | None) -> int:
        return 0 if before_id is None else self.index_of(before_id, "left") + 1

    def insert_after(
        self, before_id: ElementId | None, new_id: ElementId, count: int = 1
    ) -> None:
        _validate_range(new_id.bunch_id, new_id.counter, count, allow_empty=False)
        index = 0
        if before_id is not None:
            anchor_index = self._find(before_id)
            if anchor_index is None:
                raise IdListError("before is not known")
            index = anchor_index + 1
        end_counter = new_id.counter + count
        if any(
            element.bunch_id == new_id.bunch_id
            and new_id.counter <= element.counter < end_counter
            for element in self._elements
        ):
            raise IdListError("An inserted id is already known")
        # Build the entire insertion before touching existing state.
        inserted = [
            Element(new_id.bunch_id, counter) for counter in range(new_id.counter, end_counter)
        ]
        self._elements[index:index] = inserted

    def delete(self, target_id: ElementId) -> None:
        index = self._find(target_id)
        if index is not None:
            self._elements[index].is_deleted = True

    def save(self) -> list[SavedRun]:
        runs: list[SavedRun] = []
        for element in self._elements:
            if runs:
                last = runs[-1]
                if (
                    last["bunchId"] == element.bunch_id
                    and last["isDeleted"] == element.is_deleted
                    and last["startCounter"] + last["count"] == element.counter
                ):
                    last["count"] += 1
                    continue
            runs.append(
                SavedRun(
                    bunchId=element.bunch_id,
                    startCounter=element.counter,
                    count=1,
                    isDeleted=element.is_deleted,
                )
            )
        return runs

    @classmethod
    def load(cls, saved: object) -> "IdList":
        result = cls()
        known: set[ElementId] = set()
        if not isinstance(saved, list):
            raise IdListError("SavedIdList must be an array")
        for raw_run in cast(list[object], saved):
            if not isinstance(raw_run, dict):
                raise IdListError("Saved runs must be objects")
            fields = cast(dict[str, object], raw_run)
            if not {"bunchId", "startCounter", "count", "isDeleted"} <= fields.keys():
                raise IdListError("Missing saved-run fields")
            # The validation below checks every field before it is used.
            run = cast(SavedRun, fields)
            _validate_range(run["bunchId"], run["startCounter"], run["count"], allow_empty=True)
            if type(run["isDeleted"]) is not bool:
                raise IdListError("isDeleted must be a boolean")
            for counter in range(run["startCounter"], run["startCounter"] + run["count"]):
                element_id = ElementId(run["bunchId"], counter)
                if element_id in known:
                    raise IdListError("An inserted id is already known")
                known.add(element_id)
                result._elements.append(Element(run["bunchId"], counter, run["isDeleted"]))
        return result

    def expand(self) -> list[tuple[str, int, bool]]:
        return [(e.bunch_id, e.counter, e.is_deleted) for e in self._elements]


def utf16_units(text: str) -> list[str]:
    """Split text into code units, preserving even unpaired surrogates."""
    encoded = text.encode("utf-16-le", "surrogatepass")
    return [chr(int.from_bytes(encoded[i : i + 2], "little")) for i in range(0, len(encoded), 2)]


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2
