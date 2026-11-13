"""Document WebSocket routes; room names also form short ASCII group names."""

from collections.abc import Callable
from typing import cast

from django.urls import URLPattern, re_path

from sync.consumers import DocumentConsumer

# Django's re_path stubs describe HTTP callbacks only. Channels uses the same
# runtime URLPattern with an ASGI callback. Cast only this framework boundary.
asgi_path = cast(Callable[[str, object], URLPattern], re_path)
websocket_urlpatterns: list[URLPattern] = [
    asgi_path(r"^ws/doc/(?P<room_name>[A-Za-z0-9_-]{1,64})/\Z", DocumentConsumer.as_asgi()),
]
