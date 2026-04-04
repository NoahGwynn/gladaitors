"""Challenge Runner — orchestrates a full challenge: engine + adapter + storage + WebSocket.

Manages timing, simultaneous API calls, scoring, and state management.
Models never see each other's responses mid-turn.
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, Awaitable

from pydantic import BaseModel
from ai_adapter.adapter import AIAdapter, ModelConfig, ModelResult
from ai_adapter.schemas import TradingPitResponse
from storage.db import create_episode, store_tick, end_episode

log = logging.getLogger(__name__)

# Model identity colours — must match frontend/styles/_variables.scss
MODEL_COLOURS: dict[str, str] = {
    "Claude": "#7C3AED",
    "ChatGPT": "#10B981",
    "Gemini": "#3B82F6",
    "Grok": "#F59E0B",
}

# Map model display names to frontend IDs
MODEL_IDS: dict[str, str] = {
    "Claude": "claude",
    "ChatGPT": "gpt4o",
    "Gemini": "gemini",
    "Grok": "grok",
}


@dataclass
class RunnerConfig:
    """Configuration for a challenge run."""
    challenge_name: str
    models: list[ModelConfig]
    tick_interval: float  # seconds between ticks
    max_ticks: int
    response_schema: type[BaseModel] = TradingPitResponse
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
        self.adapter = AIAdapter(config.models, response_schema=config.response_schema)
        self.prompt_builder = prompt_builder
        self.response_parser = response_parser
        self.broadcast = broadcast
        self.episode_id: int | None = None
        self.stopped: bool = False
        self._start_time: float = 0.0
        self._last_results: dict[str, ModelResult] = {}  # model_name -> last result

    async def run(self) -> dict[str, Any]:
        """Run the full challenge. Returns final game state."""
        model_names = [m.name for m in self.config.models]
        self.episode_id = create_episode(
            challenge=self.config.challenge_name,
            models=model_names,
            config=self.config.engine_config or {},
        )

        self._start_time = time.time()

        log.info(
            "Starting %s — episode %d — models: %s",
            self.config.challenge_name, self.episode_id, model_names,
        )

        tick = 0
        while not self.engine.state.finished and tick < self.config.max_ticks and not self.stopped:
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
            # Use last known results for status mapping
            last_results = list(self._last_results.values())
            frontend_state = self._to_frontend_state(final_state, last_results)
            await self.broadcast({"type": "game_over", "state": frontend_state})

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

        # Track results for status mapping
        for r in results:
            self._last_results[r.model_name] = r

        # Broadcast to WebSocket clients (transformed to frontend GameState shape)
        if self.broadcast:
            frontend_state = self._to_frontend_state(game_state, results)
            await self.broadcast({
                "type": "tick",
                "tick": tick,
                "state": frontend_state,
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

    def _to_frontend_state(
        self,
        game_state: dict[str, Any],
        results: list[ModelResult],
    ) -> dict[str, Any]:
        """Transform raw engine state into the frontend GameState format."""
        elapsed = int(time.time() - self._start_time)
        challenge = self.config.challenge_name

        # Build model states array
        models_frontend = []
        for r in results:
            model_name = r.model_name
            model_id = MODEL_IDS.get(model_name, model_name.lower())
            colour = MODEL_COLOURS.get(model_name, "#FFFFFF")

            # Determine status
            if game_state.get("finished") and game_state.get("winner") == model_name:
                status = "winner"
            elif r.timed_out:
                status = "timeout"
            elif r.error and "rate" in r.error.lower():
                status = "rate_limited"
            elif r.error:
                status = "invalid"
            elif game_state.get("models", {}).get(model_name, {}).get("eliminated"):
                status = "eliminated"
            else:
                status = "active"

            # Challenge-specific metrics and stats
            if challenge == "territory_war":
                territory = game_state.get("territory", {})
                total_tiles = 20 * 20
                pct = round(territory.get(model_name, 0) / total_tiles * 100, 1)
                model_data = game_state.get("models", {}).get(model_name, {})
                primary_metric = pct
                primary_metric_label = "Territory"
                stats = {
                    "Ore": model_data.get("ore", 0),
                    "Food": model_data.get("food", 0),
                    "Units": sum(
                        1 for u in game_state.get("units", [])
                        if u.get("model") == model_name
                    ),
                }
            elif challenge == "trading_pit":
                portfolio = game_state.get("portfolios", {}).get(model_name, {})
                total_value = portfolio.get("total_value", 10000)
                primary_metric = round(total_value)
                primary_metric_label = "Portfolio"
                stats = {
                    "Cash": f"£{portfolio.get('cash', 0):,.0f}",
                }
            else:
                primary_metric = 0
                primary_metric_label = ""
                stats = {}

            # Last action summary
            last_action = ""
            if r.response:
                if challenge == "territory_war":
                    actions = r.response.get("actions", [])
                    if actions:
                        a = actions[0]
                        last_action = f"{a.get('action', '?')} {a.get('direction', '')}".strip()
                elif challenge == "trading_pit":
                    decisions = r.response.get("decisions", [])
                    active = [d for d in decisions if d.get("action") != "hold"]
                    if active:
                        d = active[0]
                        last_action = f"{d['action']} {d['asset']}"

            models_frontend.append({
                "id": model_id,
                "name": model_name,
                "colour": colour,
                "status": status,
                "primary_metric": primary_metric,
                "primary_metric_label": primary_metric_label,
                "stats": stats,
                "last_action": last_action,
            })

        # Build events array
        events_frontend = []
        for event in game_state.get("event_log", [])[-10:]:
            events_frontend.append({
                "tick": event.get("tick", 0),
                "message": event.get("headline") or event.get("message") or event.get("event", ""),
            })

        return {
            "tick": game_state.get("tick", 0),
            "max_ticks": game_state.get("max_ticks", 0),
            "elapsed_seconds": elapsed,
            "challenge": challenge,
            "models": models_frontend,
            "events": events_frontend,
            "canvas_data": game_state,
        }
