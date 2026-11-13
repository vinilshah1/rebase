"""Real Channels/ASGI WebSocket integration tests, without a database or server."""

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Protocol, cast

import pytest
from channels.layers import InMemoryChannelLayer, channel_layers
from channels.testing import WebsocketCommunicator

from core.asgi import application
from sync import consumers
from sync.id_list import MAX_SAFE_INTEGER, ElementId
from sync.room_manager import RoomManager, WireOp
from sync.test_room import delete, insert


class Socket(Protocol):
    """Typed JSON-result boundary around the Channels testing API."""

    async def connect(self, timeout: float = 1) -> tuple[bool, object]: ...
    async def send_json_to(self, data: object) -> None: ...
    async def send_input(self, message: dict[str, object]) -> None: ...
    async def send_to(
        self, text_data: str | None = None, bytes_data: bytes | None = None
    ) -> None: ...
    async def receive_json_from(self, timeout: float = 1) -> dict[str, object]: ...
    async def receive_output(self, timeout: float = 1) -> dict[str, object]: ...
    async def receive_nothing(self, timeout: float = 0.1) -> bool: ...
    async def disconnect(self) -> None: ...


@dataclass
class Session:
    manager: RoomManager
    layer: InMemoryChannelLayer
    sockets: list[Socket] = field(default_factory=list)

    async def connect(self, name: str = "test") -> tuple[Socket, dict[str, object]]:
        socket = cast(Socket, WebsocketCommunicator(application, f"/ws/doc/{name}/"))
        self.sockets.append(socket)
        connected, _ = await socket.connect()
        assert connected
        return socket, await socket.receive_json_from()


@pytest.fixture
async def session(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Session]:
    manager = RoomManager()
    layer = InMemoryChannelLayer(capacity=1000)
    monkeypatch.setattr(consumers, "room_manager", manager)
    monkeypatch.setitem(cast(dict[str, object], channel_layers.backends), "default", layer)
    result = Session(manager, layer)
    yield result
    for socket in result.sockets:
        await socket.disconnect()


async def test_connect_echoes_gapless_sequence_and_late_snapshot(session: Session) -> None:
    a, initial = await session.connect()
    assert initial == {"type": "init", "seq": 0, "text": "", "idListState": []}
    b, second = await session.connect()
    assert second == initial
    room = session.manager.get_or_create("test")
    assert len(session.layer.groups["doc_test"]) == 2
    operations = [insert("seed", "abc"), delete("first", 1), delete("again", 1)]
    for seq, op in enumerate(operations, 1):
        await a.send_json_to(op)
        expected = {**op, "seq": seq}
        assert await a.receive_json_from() == expected
        assert await b.receive_json_from() == expected
    assert room.text == ["a", "c"] and room.seq == 3
    _, snapshot = await session.connect()
    assert snapshot == room.snapshot()
    assert session.manager.get_or_create("test") is room
    # opId is not a deduplication key: this known no-op delete is still acknowledged.
    await b.send_json_to(operations[-1])
    assert (await a.receive_json_from())["seq"] == 4
    assert (await b.receive_json_from())["seq"] == 4


async def test_disconnect_discards_membership_but_keeps_document(session: Session) -> None:
    a, _ = await session.connect()
    room = session.manager.get_or_create("test")
    await a.send_json_to(insert("seed", "X"))
    _ = await a.receive_json_from()
    state = room.snapshot()
    await a.disconnect()
    session.sockets.remove(a)
    assert "doc_test" not in session.layer.groups
    assert session.manager.get_or_create("test") is room
    assert room.snapshot() == state
    _, snapshot = await session.connect()
    assert snapshot == state


async def test_rooms_are_isolated(session: Session) -> None:
    a, _ = await session.connect("one")
    b, _ = await session.connect("two")
    await a.send_json_to(insert("seed", "A"))
    assert (await a.receive_json_from())["seq"] == 1
    assert await b.receive_nothing(timeout=0.02)
    assert session.manager.get_or_create("two").snapshot()["text"] == ""


def invalid_operations() -> list[object]:
    base = insert("fresh", "X")
    invalid: list[object] = [
        None,
        [],
        7,
        "insert",
        {},
        {**base, "type": "wat"},
        {**base, "seq": 99},
        {**base, "extra": True},
    ]
    for key in base:
        invalid.append({k: v for k, v in base.items() if k != key})
    for key in ("opId", "senderId"):
        for bad in ("", "x" * 129, 7, None, True):
            invalid.append({**base, key: bad})
    for key in ("beforeId", "newId"):
        for bad_id in (
            {},
            "bad",
            {"bunchId": "x"},
            {"bunchId": "x", "counter": 0, "extra": 1},
            *({"bunchId": bad, "counter": 0} for bad in ("", "x" * 129, 1, None)),
            *(
                {"bunchId": "x", "counter": bad}
                for bad in (-1, True, 0.5, MAX_SAFE_INTEGER + 1, None)
            ),
        ):
            invalid.append({**base, key: bad_id})
    invalid.extend(
        [
            {**base, "newId": None},
            {**base, "beforeId": {"bunchId": "missing", "counter": 0}},
            {**base, "newId": {"bunchId": "seed", "counter": 0}},
            {**base, "newId": {"bunchId": "seed", "counter": 2}, "content": "XY", "count": 2},
            {
                **base,
                "newId": {"bunchId": "fresh", "counter": MAX_SAFE_INTEGER},
                "count": 2,
                "content": "XY",
            },
            *(
                {**base, "count": bad}
                for bad in (0, -1, True, 1.5, 2, 100_001, MAX_SAFE_INTEGER + 1)
            ),
            *(
                {**base, "content": bad}
                for bad in (None, 1, cast(list[object], []), "", "\U0001f600")
            ),
        ]
    )
    delete_base = delete("delete", 0)
    invalid.extend(
        {**delete_base, "targetIds": bad}
        for bad in (
            cast(list[object], []),
            None,
            cast(dict[str, object], {}),
            [None],
            [{"bunchId": "seed", "counter": 99}],
            [{"bunchId": "seed", "counter": 0}, {"bunchId": "missing", "counter": 0}],
            [{"bunchId": "seed", "counter": True}],
            [{"bunchId": "seed", "counter": 0}] * 100_001,
        )
    )
    return invalid


@pytest.mark.parametrize("invalid", invalid_operations(), ids=lambda _: None)
async def test_invalid_input_closes_without_mutation_or_broadcast(
    session: Session, invalid: object
) -> None:
    sender, _ = await session.connect()
    observer, _ = await session.connect()
    await observer.send_json_to(insert("seed", "abc"))
    _ = await observer.receive_json_from()
    _ = await sender.receive_json_from()
    room = session.manager.get_or_create("test")
    before = room.snapshot()
    known = room.id_list.expand()
    await sender.send_json_to(invalid)
    assert await sender.receive_output() == {"type": "websocket.close", "code": 4400}
    # Even a queued frame following the close cannot mutate state.
    await sender.send_json_to(insert("after-close", "Y"))
    assert await observer.receive_nothing(timeout=0.02)
    assert room.snapshot() == before and room.id_list.expand() == known


@pytest.mark.parametrize("raw", ["{", "", "NaN", "1" * 5000])
async def test_bad_json(session: Session, raw: str) -> None:
    sender, _ = await session.connect()
    # send_to rejects empty frames itself, so exercise the ASGI frame directly.
    await sender.send_input({"type": "websocket.receive", "text": raw})
    assert (await sender.receive_output())["code"] == 4400
    assert session.manager.get_or_create("test").seq == 0


async def test_invariant_failure_closes_4500(session: Session) -> None:
    sender, _ = await session.connect()
    observer, _ = await session.connect()
    room = session.manager.get_or_create("test")
    room.text.append("corruption")
    await sender.send_json_to(insert("seed", "X"))
    assert await sender.receive_output() == {"type": "websocket.close", "code": 4500}
    assert room.seq == 0
    assert await observer.receive_nothing(timeout=0.02)


async def test_simultaneous_senders_observe_identical_total_order(session: Session) -> None:
    a, _ = await session.connect()
    b, _ = await session.connect()
    _ = await asyncio.gather(a.send_json_to(insert("A", "A")), b.send_json_to(insert("B", "B")))
    seen_a = [await a.receive_json_from(), await a.receive_json_from()]
    seen_b = [await b.receive_json_from(), await b.receive_json_from()]
    assert seen_a == seen_b
    assert [op["seq"] for op in seen_a] == [1, 2]


async def test_connect_waits_for_inflight_broadcast_boundary(session: Session) -> None:
    room = session.manager.get_or_create("test")
    entered, release = asyncio.Event(), asyncio.Event()

    async def blocked(op: WireOp) -> None:
        entered.set()
        await release.wait()
        await session.layer.group_send("doc_test", {"type": "doc.operation", "payload": op})

    task = asyncio.create_task(room.apply(insert("seed", "X"), blocked))
    await entered.wait()
    joining = asyncio.create_task(session.connect())
    try:
        await asyncio.sleep(0)
        assert "doc_test" not in session.layer.groups
    finally:
        release.set()
        _ = await task
    socket, snapshot = await joining
    assert snapshot == room.snapshot() and snapshot["seq"] == 1
    assert await socket.receive_nothing(timeout=0.02)
    _ = await room.apply(
        delete("after-snapshot", 0),
        lambda op: session.layer.group_send("doc_test", {"type": "doc.operation", "payload": op}),
    )
    assert (await socket.receive_json_from())["seq"] == 2


async def test_unicode_wire_snapshot_and_safe_sequence_limit(session: Session) -> None:
    socket, _ = await session.connect()
    await socket.send_json_to(insert("seed", "\U0001f600"))
    assert (await socket.receive_json_from())["content"] == "\U0001f600"
    _, snapshot = await session.connect()
    assert snapshot["text"] == "\U0001f600"
    room = session.manager.get_or_create("test")
    assert room.text == ["\ud83d", "\ude00"] and len(room.id_list) == 2
    room.seq = MAX_SAFE_INTEGER
    before = room.snapshot()
    await socket.send_json_to(delete("overflow", 0))
    assert (await socket.receive_output())["code"] == 4400
    assert room.snapshot() == before


async def test_binary_frame_is_rejected(session: Session) -> None:
    sender, _ = await session.connect()
    await sender.send_to(bytes_data=b"binary")
    assert (await sender.receive_output())["code"] == 4400
    assert session.manager.get_or_create("test").seq == 0


async def test_invariant_failure_after_application(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    sender, _ = await session.connect()
    observer, _ = await session.connect()
    room = session.manager.get_or_create("test")
    original_insert = room.id_list.insert_after

    def faulty_insert(before_id: ElementId | None, new_id: ElementId, count: int = 1) -> None:
        original_insert(before_id, new_id, count)
        room.text.append("extra")

    monkeypatch.setattr(room.id_list, "insert_after", faulty_insert)
    await sender.send_json_to(insert("seed", "X"))
    assert (await sender.receive_output())["code"] == 4500
    assert room.seq == 0
    assert await observer.receive_nothing(timeout=0.02)
