"""Connection adapters; canonical document state lives exclusively in Rooms."""

import json
import logging
from typing import cast

from channels.generic.websocket import AsyncWebsocketConsumer

from sync.id_list import IdListError
from sync.room_manager import Room, RoomInvariantError, WireOp, room_manager

logger = logging.getLogger(__name__)


class DocumentConsumer(AsyncWebsocketConsumer):
    room: Room
    group_name: str
    closing: bool = False

    async def connect(self) -> None:
        assert "url_route" in self.scope, "DocumentConsumer requires URLRouter"
        kwargs = cast(dict[str, str], self.scope["url_route"]["kwargs"])
        name = kwargs["room_name"]
        self.room = room_manager.get_or_create(name)
        self.group_name = f"doc_{name}"
        await self.accept()
        async with self.room.lock:
            await self.channel_layer.group_add(self.group_name, self.channel_name)
            await self.send(text_data=json.dumps(self.room.snapshot()))

    async def disconnect(self, code: int) -> None:
        self.closing = True
        await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(self, text_data: str | None = None, bytes_data: bytes | None = None) -> None:
        if self.closing:
            return
        try:
            if text_data is None or bytes_data is not None:
                raise IdListError("Only JSON text frames are accepted")
            try:
                message = cast(object, json.loads(text_data))
            except (ValueError, RecursionError) as error:
                raise IdListError("Invalid JSON") from error
            _ = await self.room.apply(message, self.broadcast)
        except IdListError as error:
            logger.warning("Invalid operation in %s: %s", self.group_name, error)
            self.closing = True
            await self.close(code=4400)
        except RoomInvariantError:
            logger.exception("Server invariant failure in %s", self.group_name)
            self.closing = True
            await self.close(code=4500)

    async def broadcast(self, wire_op: WireOp) -> None:
        # Room.apply awaits this callback before releasing the Room lock.
        await self.channel_layer.group_send(
            self.group_name, {"type": "doc.operation", "payload": wire_op}
        )

    async def doc_operation(self, event: dict[str, object]) -> None:
        if not self.closing:
            await self.send(text_data=json.dumps(event["payload"]))
