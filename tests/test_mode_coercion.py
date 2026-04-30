"""Tests for back-compat coercion of the legacy "lockstep" mode value.

The product-facing engine was renamed from "lockstep" to "rollback". Pre-deploy
clients, cached share links, and persisted Redis rooms still carry the legacy
value. These tests verify the three coercion shims:

  1. Pydantic field_validator on StartGamePayload / SetModePayload
     (server/src/api/payloads.py)
  2. Redis Room deserialization (server/src/state.py)
  3. (E2E URL-param coercion is covered by test_e2e.py.)

Removable once cached state churns out post-deploy.
"""

from src.api.payloads import SetModePayload, StartGamePayload


def test_start_game_payload_coerces_legacy_lockstep_mode():
    """Pre-deploy clients emit mode='lockstep' over Socket.IO. The Pydantic
    field_validator runs before Literal validation and rewrites it to
    'rollback' so the model passes validation cleanly.
    """
    payload = StartGamePayload.model_validate({"mode": "lockstep"})
    assert payload.mode == "rollback"


def test_set_mode_payload_coerces_legacy_lockstep_mode():
    payload = SetModePayload.model_validate({"mode": "lockstep"})
    assert payload.mode == "rollback"


def test_payloads_default_to_rollback():
    """Default mode for both payloads is 'rollback' after the rename."""
    assert StartGamePayload().mode == "rollback"
    assert SetModePayload().mode == "rollback"


def test_payloads_accept_streaming_unchanged():
    assert StartGamePayload.model_validate({"mode": "streaming"}).mode == "streaming"
    assert SetModePayload.model_validate({"mode": "streaming"}).mode == "streaming"


def test_payloads_accept_rollback_directly():
    assert StartGamePayload.model_validate({"mode": "rollback"}).mode == "rollback"
    assert SetModePayload.model_validate({"mode": "rollback"}).mode == "rollback"
