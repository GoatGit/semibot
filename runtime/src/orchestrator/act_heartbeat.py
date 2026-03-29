"""Backend ACT heartbeat emitter."""

from __future__ import annotations

import os
import time
from typing import Any

from src.orchestrator.runtime_middleware import ensure_step_runtime_state
from src.orchestrator.state import AgentState

_HEARTBEAT_INTERVAL_SECONDS = float(os.getenv("SEMIBOT_ACT_HEARTBEAT_INTERVAL_SECONDS") or "5")


async def maybe_emit_act_heartbeat(
    *,
    state: AgentState,
    action_id: str,
    iteration: int,
    act_phase: str,
    event_emitter: Any | None,
    turn_count: int,
) -> None:
    if event_emitter is None or _HEARTBEAT_INTERVAL_SECONDS <= 0:
        return
    step_state = ensure_step_runtime_state(state, action_id, iteration)
    heartbeat = step_state.setdefault("heartbeat", {})
    last_emit = float(heartbeat.get("last_emit_monotonic") or 0.0)
    now = time.monotonic()
    if now - last_emit < _HEARTBEAT_INTERVAL_SECONDS:
        return
    heartbeat["last_emit_monotonic"] = now
    heartbeat["count"] = int(heartbeat.get("count") or 0) + 1
    await event_emitter.emit(
        "act.heartbeat",
        {
            "session_id": state["session_id"],
            "agent_id": state.get("agent_id"),
            "step_id": action_id,
            "iteration": iteration,
            "act_phase": act_phase,
            "turn_count": turn_count,
            "heartbeat_count": heartbeat["count"],
        },
    )
