"""ASGI entry point: run one Uvicorn worker, without reload, for this in-memory PoC."""

import os
from collections.abc import Callable
from typing import cast

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application
from django.urls import URLPattern

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django_asgi_application = get_asgi_application()

from sync.routing import websocket_urlpatterns  # noqa: E402

# Channels accepts Django URLPatterns with ASGI callbacks; the two frameworks
# annotate those callbacks differently. Adapt the constructor type at this boundary.
websocket_router = cast(Callable[[list[URLPattern]], URLRouter], URLRouter)

application = ProtocolTypeRouter(
    {
        "http": django_asgi_application,
        "websocket": websocket_router(websocket_urlpatterns),
    }
)
