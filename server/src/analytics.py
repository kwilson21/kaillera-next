"""PostHog analytics wrapper -- optional, no-op if POSTHOG_API_KEY is unset."""

from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

_enabled = False


def init_posthog() -> None:
    """Initialize PostHog SDK. No-op if POSTHOG_API_KEY env var is not set."""
    global _enabled
    key = os.environ.get("POSTHOG_API_KEY")
    if not key:
        log.info("PostHog disabled (POSTHOG_API_KEY not set)")
        return
    import posthog

    posthog.project_api_key = key
    posthog.host = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com")
    _enabled = True
    log.info("PostHog enabled (host: %s)", posthog.host)


def capture_session_ended(persistent_id: str, properties: dict) -> None:
    """Fire a session_ended event to PostHog. No-op if disabled."""
    if not _enabled:
        return
    import posthog

    posthog.capture(distinct_id=persistent_id, event="session_ended", properties=properties)
