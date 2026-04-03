"""Challenge Runner — orchestrates a full challenge: engine + adapter + storage + WebSocket.

Manages timing, simultaneous API calls, scoring, and state management.
Models never see each other's responses mid-turn.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Callable, Awaitable

from ai_adapter.adapter import AIAdapter, ModelConfig, ModelResult
from storage.db import create_episode, store_tick, end_episode

log = logging.getLogger(__name__)


@dataclass
class RunnerConfig:
    """Configuration for a challenge run."""
    challenge_name: str
    models: list[ModelConfig]
    tick_interval: float  # seconds between ticks
    max_ticks: int
    # Engine-specific config passed through to storage
    engine_config: dict[str, Any] | None = None


class ChallengeRunner:
    """Runs a challenge end-to-end.

    Requires:
    - An engine with get_prompt_state(), apply_actions(), and state.finished/winner
    - A prompt builder: (engine_state) -> str
    - A response parser: (ModelResult) -> list[dict] (parsed actions)
    - An optional broadcast callback for WebSocket
    """

    def __init__(
        self,
        config: RunnerConfig,
        engine: Any,
        prompt_builder: Callable[[dict[str, Any]], str],
        response_parser: Callable[[ModelResult], list[dict[str, Any]]],
        broadcast: Callable[[dict], Awaitable[None]] | None = None,
    ):
        self.config = config
        self.engine = engine
        self.adapter = AIAdapter(config.models)
        self.prompt_builder = prompt_builder
        self.response_parser = response_parser
        self.broadcast = broadcast
        self.episode_id: int | None = None

    async def run(self) -> dict[str, Any]:
        """Run the full challenge. Returns final game state."""
        model_names = [m.name for m in self.config.models]
        self.episode_id = create_episode(
            challenge=self.config.challenge_name,
            models=model_names,
            config=self.config.engine_config or {},
        )

        log.info(
            "Starting %s — episode %d — models: %s",
            self.config.challenge_name, self.episode_id, model_names,
        )

        tick = 0
        while not self.engine.state.finished and tick < self.config.max_ticks:
            await self._run_tick(tick)
            tick += 1

            if not self.engine.state.finished:
                await asyncio.sleep(self.config.tick_interval)

        # Finalise
        winner = self.engine.state.winner
        end_episode(self.episode_id, winner)

        final_state = self.engine.state.to_dict()
        log.info("Episode %d finished — winner: %s", self.episode_id, winner)

        if self.broadcast:
            await self.broadcast({"type": "game_over", "state": final_state})

        return final_state

    async def _run_tick(self, tick: int):
        """Execute a single tick: prompt → call all models → apply actions → store → broadcast."""
        # Build prompt from current engine state (same for all models)
        prompt_state = self.engine.get_prompt_state()
        prompt = self.prompt_builder(prompt_state)

        # Call all models simultaneously
        results = await self.adapter.call_all(prompt)

        # Parse responses into actions per model
        actions: dict[str, list[dict[str, Any]]] = {}
        events: list[str] = []

        for result in results:
            if result.response:
                actions[result.model_name] = self.response_parser(result)
            else:
                # Failed or timed out — skip turn
                actions[result.model_name] = []
                event = f"{result.model_name}: {result.error}"
                events.append(event)
                log.warning("Tick %d — %s", tick, event)

        # Apply all actions to engine simultaneously
        self.engine.apply_actions(actions)

        # Store tick for replay
        game_state = self.engine.state.to_dict()
        model_responses = [
            {
                "model": r.model_name,
                "latency_ms": r.latency_ms,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
                "response": r.response,
                "error": r.error,
                "timed_out": r.timed_out,
            }
            for r in results
        ]
        store_tick(self.episode_id, tick, game_state, model_responses, events or None)

        # Broadcast to WebSocket clients
        if self.broadcast:
            await self.broadcast({
                "type": "tick",
                "tick": tick,
                "state": game_state,
                "results": model_responses,
            })

        log.info(
            "Tick %d — %s",
            tick,
            " | ".join(
                f"{r.model_name}: {'OK' if r.response else 'SKIP'} ({r.latency_ms:.0f}ms)"
                for r in results
            ),
        )
