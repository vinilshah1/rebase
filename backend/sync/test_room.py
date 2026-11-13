"""Canonical Room ordering, snapshot replay, and UTF-16 behavior."""

import asyncio
from collections.abc import Callable

import pytest

from sync.id_list import MAX_SAFE_INTEGER, IdList, IdListError, utf16_units
from sync.room_manager import Room, RoomManager, WireOp


def insert(bunch: str, content: str, before: object = None, counter: int = 0) -> WireOp:
    return {
        "type": "insert",
        "opId": f"insert-{bunch}-{counter}",
        "senderId": bunch,
        "beforeId": before,
        "newId": {"bunchId": bunch, "counter": counter},
        "count": len(utf16_units(content)),
        "content": content,
    }


def delete(op_id: str, *counters: int) -> WireOp:
    return {
        "type": "delete",
        "opId": op_id,
        "senderId": "deleter",
        "targetIds": [{"bunchId": "seed", "counter": c} for c in counters],
    }


async def ignore_broadcast(op: WireOp) -> None:
    pass


def test_registry_identity_and_independent_locks() -> None:
    manager = RoomManager()
    first = manager.get_or_create("one")
    assert manager.get_or_create("one") is first
    second = manager.get_or_create("two")
    assert second is not first
    assert second.lock is not first.lock
    assert second.id_list is not first.id_list
    assert second.text is not first.text


@pytest.mark.parametrize("order", [("A", "B"), ("B", "A")])
async def test_concurrent_history_and_late_joiner(order: tuple[str, str]) -> None:
    room = Room()
    history: list[WireOp] = []

    async def broadcast(op: WireOp) -> None:
        assert room.lock.locked()
        assert len(room.id_list) == len(room.text)
        history.append(op)
        # Yield while broadcasting to exercise serialization of concurrent callers.
        await asyncio.sleep(0)

    seed = insert("seed", "Xyz")
    _ = await room.apply(seed, broadcast)
    anchor = {"bunchId": "seed", "counter": 0}
    inserts = {name: insert(name, name, anchor) for name in order}
    # Queue both clients at the lock in the chosen order.
    async with room.lock:
        first = asyncio.create_task(room.apply(inserts[order[0]], broadcast))
        second = asyncio.create_task(room.apply(inserts[order[1]], broadcast))
        await asyncio.sleep(0)
    _ = await asyncio.gather(first, second)
    assert "".join(room.text) == f"X{order[1]}{order[0]}yz"
    snapshot = room.snapshot()
    _ = await asyncio.gather(
        room.apply(delete("delete-A", 1, 2), broadcast),
        room.apply(delete("delete-B", 2, 1, 1), broadcast),
    )
    assert "".join(room.text) == f"X{order[1]}{order[0]}"
    assert [op["seq"] for op in history] == [1, 2, 3, 4, 5]
    late = Room(
        id_list=IdList.load(snapshot["idListState"]), text=utf16_units(str(snapshot["text"])), seq=3
    )
    replicas = [Room(), Room()]
    for op in history:
        client_op = {k: v for k, v in op.items() if k != "seq"}
        for replica in replicas:
            _ = await replica.apply(client_op, ignore_broadcast)
        if int(str(op["seq"])) > 3:
            _ = await late.apply(client_op, ignore_broadcast)
    for replica in [*replicas, late]:
        assert replica.snapshot() == room.snapshot()
        assert replica.id_list.expand() == room.id_list.expand()


async def test_broadcast_is_awaited_under_lock_and_rooms_progress_independently() -> None:
    first, other = Room(), Room()
    entered, release = asyncio.Event(), asyncio.Event()

    async def blocked(op: WireOp) -> None:
        assert first.lock.locked()
        entered.set()
        await release.wait()

    task = asyncio.create_task(first.apply(insert("a", "A"), blocked))
    await entered.wait()
    second = asyncio.create_task(first.apply(insert("b", "B"), ignore_broadcast))
    try:
        _ = await asyncio.wait_for(other.apply(insert("c", "C"), ignore_broadcast), 1)
        assert first.seq == 1 and not second.done()
    finally:
        release.set()
        _ = await asyncio.gather(task, second)
    assert first.seq == 2 and other.seq == 1


async def test_utf16_and_tombstone_anchor() -> None:
    room = Room()
    _ = await room.apply(insert("seed", "a\U0001f600z"), ignore_broadcast)
    assert room.text == ["a", "\ud83d", "\ude00", "z"]
    assert len(room.id_list) == len(room.text) == 4
    _ = await room.apply(delete("emoji", 1, 2), ignore_broadcast)
    assert room.text == ["a", "z"]
    # Tombstone insertion is at slot 1, never right + 1 (which would be slot 2).
    _ = await room.apply(
        insert("after-emoji", "Q", {"bunchId": "seed", "counter": 2}), ignore_broadcast
    )
    assert room.text == ["a", "Q", "z"]
    assert len(room.id_list) == len(room.text)


@pytest.mark.parametrize(
    "invalid",
    [
        lambda: delete("partial-unknown", 0, 99),
        lambda: insert("seed", "duplicate", counter=0),
        lambda: insert("seed", "range-overlap", counter=0),
        lambda: insert("fresh", "x", {"bunchId": "missing", "counter": 0}),
    ],
)
async def test_invalid_is_atomic(invalid: Callable[[], WireOp]) -> None:
    room = Room()
    _ = await room.apply(insert("seed", "abc", counter=3), ignore_broadcast)
    # Include a known target followed by an unknown one to guard full delete validation.
    _ = await room.apply(insert("seed", "X"), ignore_broadcast)
    before = room.snapshot()
    known = room.id_list.expand()
    broadcasts: list[WireOp] = []

    async def record(op: WireOp) -> None:
        broadcasts.append(op)

    with pytest.raises(IdListError):
        _ = await room.apply(invalid(), record)
    assert room.snapshot() == before
    assert room.id_list.expand() == known
    assert broadcasts == []


async def test_sequence_overflow_is_atomic() -> None:
    room = Room(seq=MAX_SAFE_INTEGER)
    with pytest.raises(IdListError):
        _ = await room.apply(insert("a", "A"), ignore_broadcast)
    assert room.seq == MAX_SAFE_INTEGER and not room.text
