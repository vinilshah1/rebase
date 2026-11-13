"""Process-local canonical documents; correct only in one process / one worker."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import cast

from sync.id_list import MAX_SAFE_INTEGER, ElementId, IdList, IdListError, utf16_units

WireOp = dict[str, object]
Broadcast = Callable[[WireOp], Awaitable[None]]


class RoomInvariantError(RuntimeError):
    """Canonical identity and text lengths disagree."""


def _object(value: object, keys: set[str]) -> dict[str, object]:
    if not isinstance(value, dict):
        raise IdListError("Expected an object")
    result = cast(dict[str, object], value)
    if result.keys() != keys:
        raise IdListError("Unexpected or missing fields")
    return result


def _string(value: object) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        raise IdListError("IDs must be non-empty strings of at most 128 characters")
    return value


def _integer(value: object) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise IdListError("Expected a non-negative JavaScript safe integer")
    return value


def _id(value: object) -> ElementId:
    fields = _object(value, {"bunchId", "counter"})
    return ElementId(_string(fields["bunchId"]), _integer(fields["counter"]))


@dataclass
class Room:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    id_list: IdList = field(default_factory=IdList)
    text: list[str] = field(default_factory=list)
    seq: int = 0

    def snapshot(self) -> dict[str, object]:
        """Caller holds lock, including group membership changes and snapshot send."""
        return {
            "type": "init",
            "seq": self.seq,
            "text": "".join(self.text),
            "idListState": self.id_list.save(),
        }

    async def apply(self, message: object, broadcast: Broadcast) -> WireOp:
        """Validate, mutate, sequence, and broadcast as one per-document critical section."""
        async with self.lock:
            if not isinstance(message, dict):
                raise IdListError("Operation must be an object")
            fields = cast(dict[str, object], message)
            kind = fields.get("type")
            common = {"type", "opId", "senderId"}
            if kind == "insert":
                op = _object(fields, common | {"beforeId", "newId", "count", "content"})
            elif kind == "delete":
                op = _object(fields, common | {"targetIds"})
            else:
                raise IdListError("Unknown operation type")
            _ = _string(op["opId"])
            _ = _string(op["senderId"])
            if not 0 <= self.seq < MAX_SAFE_INTEGER:
                raise IdListError("Room sequence cannot be incremented safely")

            if len(self.id_list) != len(self.text):
                raise RoomInvariantError("I2: identity-list and UTF-16 text lengths disagree")
            if kind == "insert":
                before = None if op["beforeId"] is None else _id(op["beforeId"])
                new_id = _id(op["newId"])
                count = _integer(op["count"])
                content = op["content"]
                if not isinstance(content, str):
                    raise IdListError("content must be a string")
                units = utf16_units(content)
                if not 1 <= count <= 100_000 or len(units) != count:
                    raise IdListError("Invalid count or UTF-16 content length mismatch")
                if new_id.counter + count - 1 > MAX_SAFE_INTEGER:
                    raise IdListError("Inserted range exceeds the safe-integer limit")
                # insert_after validates the entire range atomically, before mutation.
                index = self.id_list.visible_index_after(before)
                self.id_list.insert_after(before, new_id, count)
                self.text[index:index] = units
            else:
                raw_targets = op["targetIds"]
                if not isinstance(raw_targets, list):
                    raise IdListError("targetIds must be an array")
                target_values = cast(list[object], raw_targets)
                if not 1 <= len(target_values) <= 100_000:
                    raise IdListError("targetIds must contain 1..100000 IDs")
                targets = [_id(target) for target in target_values]
                if any(not self.id_list.is_known(target) for target in targets):
                    raise IdListError("Unknown delete target")
                for target in targets:
                    if self.id_list.has(target):
                        index = self.id_list.index_of(target, "none")
                        del self.text[index]
                        self.id_list.delete(target)
            if len(self.id_list) != len(self.text):
                raise RoomInvariantError("I2: identity-list and UTF-16 text lengths disagree")
            self.seq += 1
            server_op = {**op, "seq": self.seq}
            await broadcast(server_op)
            return server_op


class RoomManager:
    """Synchronous registry: rooms survive socket disconnects until process exit."""

    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}

    def get_or_create(self, name: str) -> Room:
        if name not in self._rooms:
            self._rooms[name] = Room()
        return self._rooms[name]


room_manager = RoomManager()
