"""Challenge Runner — orchestrates a full challenge: engine + adapter + storage + WebSocket.

Manages timing, sequential/simultaneous API calls, scoring, and state management.
Models never see each other's responses mid-turn.
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Awaitable

from pydantic import BaseModel
from ai_adapter.adapter import AIAdapter, ModelConfig, ModelResult, Prompt
from ai_adapter.schemas import TradingPitResponse
from storage.db import create_episode, store_tick, end_episode

log = logging.getLogger(__name__)

GAME_LOGS_DIR = Path(__file__).parent.parent / "game_logs"

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
    simultaneous: bool = False


class GameLog:
    """Logs game events to a file for debugging and replay analysis."""

    def __init__(self, path: Path):
        GAME_LOGS_DIR.mkdir(exist_ok=True)
        self._file = open(path, "w", encoding="utf-8")

    def log_thinking(self, round: int, turn: int, name: str):
        self._file.write(f"\n--- Round {round} Turn {turn} --- {name} thinking...\n")
        self._file.flush()

    def log_turn(self, round: int, turn: int, name: str, result: ModelResult, actions: list[dict]):
        self._file.write(f"--- Round {round} Turn {turn} --- {name} ---\n")
        self._file.write(f"  Latency: {result.latency_ms:.0f}ms\n")
        self._file.write(f"  Tokens: {result.input_tokens} in / {result.output_tokens} out\n")
        if result.error:
            self._file.write(f"  Error: {result.error}\n")
        for a in actions:
            self._file.write(f"  Action: {json.dumps(a)}\n")
        self._file.flush()

    def log_round_end(self, round: int, order: list[str], state: dict[str, Any]):
        self._file.write(f"\n=== End of Round {round} === Order: {order}\n")
        scores = state.get("territory_score", state.get("territory", {}))
        for name, score in scores.items():
            self._file.write(f"  {name}: {score}\n")
        self._file.flush()

    def log_game_over(self, state: dict[str, Any]):
        self._file.write(f"\n{'='*60}\nGAME OVER\n{'='*60}\n")
        scores = state.get("territory_score", state.get("territory", {}))
        for name, score in sorted(scores.items(), key=lambda x: x[1], reverse=True):
            self._file.write(f"  {name}: {score}\n")
        winner = state.get("winner")
        self._file.write(f"  Winner: {winner}\n")
        self._file.flush()

    def close(self):
        self._file.close()


class ChallengeRunner:
    """Runs a challenge end-to-end.

    Requires:
    - An engine with get_prompt_state(), apply_actions(), and state.finished/winner
    - A prompt builder: (engine_state, model_names) -> dict[str, Prompt]
    - A response parser: (ModelResult) -> list[dict] (parsed actions)
    - An optional broadcast callback for WebSocket
    """

    def __init__(
        self,
        config: RunnerConfig,
        engine: Any,
        prompt_builder: Callable[..., dict[str, Prompt]],
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
        self.waiting: bool = True
        self.paused: bool = False
        self._start_time: float = 0.0
        self._last_results: dict[str, ModelResult] = {}

    async def broadcast_initial_state(self):
        """Broadcast the initial game state before the game starts."""
        if hasattr(self.engine.state, 'max_ticks'):
            self.engine.state.max_ticks = self.config.max_ticks
        if self.broadcast:
            game_state = self.engine.state.to_dict()
            frontend_state = self._to_frontend_state(game_state, [])
            await self.broadcast({"type": "tick", "state": frontend_state})

    async def go(self):
        """Signal the runner to start (called externally)."""
        self.waiting = False

    async def run(self) -> dict[str, Any]:
        """Run the full challenge. Returns final game state."""
        model_names = [m.name for m in self.config.models]
        self.episode_id = create_episode(
            challenge=self.config.challenge_name,
            models=model_names,
            config=self.config.engine_config or {},
        )

        self._start_time = time.time()

        # Sync engine's max_ticks with runner config
        if hasattr(self.engine.state, 'max_ticks'):
            self.engine.state.max_ticks = self.config.max_ticks

        # Create game log
        log_path = GAME_LOGS_DIR / f"episode_{self.episode_id}.log"
        game_log = GameLog(log_path)

        log.info(
            "Starting %s — episode %d — models: %s",
            self.config.challenge_name, self.episode_id, model_names,
        )

        # Wait for go signal
        while self.waiting and not self.stopped:
            await asyncio.sleep(0.1)

        tick = 0
        while not self.engine.state.finished and tick < self.config.max_ticks and not self.stopped:
            # Handle pause
            while self.paused and not self.stopped:
                await asyncio.sleep(0.1)

            if self.config.simultaneous:
                await self._run_tick_simultaneous(tick, game_log)
            else:
                await self._run_tick_sequential(tick, game_log)
            tick += 1

            if not self.engine.state.finished and not self.stopped:
                await asyncio.sleep(self.config.tick_interval)

        # Finalise
        winner = self.engine.state.winner
        end_episode(self.episode_id, winner)

        final_state = self.engine.state.to_dict()
        game_log.log_game_over(final_state)
        game_log.close()

        log.info("Episode %d finished — winner: %s", self.episode_id, winner)

        if self.broadcast:
            last_results = list(self._last_results.values())
            frontend_state = self._to_frontend_state(final_state, last_results)
            await self.broadcast({"type": "game_over", "state": frontend_state})

        return final_state

    async def _run_tick_sequential(self, tick: int, game_log: GameLog):
        """Execute a sequential tick: each model moves in clockwise order, seeing updated state."""
        # Get clockwise order from engine
        order = self.engine.get_clockwise_order()

        all_results = []
        actions_taken: dict[str, list[dict]] = {}

        for turn, model_name in enumerate(order):
            # Broadcast thinking status for this model
            if self.broadcast:
                per_status = {m: ("thinking" if m == model_name else None) for m in [mc.name for mc in self.config.models]}
                game_state = self.engine.state.to_dict()
                frontend_state = self._to_frontend_state(game_state, all_results, per_model_status=per_status)
                await self.broadcast({
                    "type": "tick",
                    "tick": tick,
                    "state": frontend_state,
                })

            game_log.log_thinking(tick, turn, model_name)

            # Build fresh prompt from current state (which includes previous actions this tick)
            prompt_state = self.engine.get_prompt_state()
            prompts = self.prompt_builder(prompt_state, [model_name])

            # Call single model
            model_config = next(m for m in self.config.models if m.name == model_name)
            result = await self.adapter.call_single(model_config, prompts.get(model_name, ""))

            # Parse actions
            if result.response:
                model_actions = self.response_parser(result)
            else:
                model_actions = []
                log.warning("Tick %d turn %d — %s: %s", tick, turn, model_name, result.error)

            # Apply actions immediately (don't advance tick — that happens at end of round)
            self.engine.apply_actions({model_name: model_actions}, advance_tick=False)
            actions_taken[model_name] = model_actions
            all_results.append(result)
            self._last_results[model_name] = result

            game_log.log_turn(tick, turn, model_name, result, model_actions)

            # Broadcast updated state with actions taken
            if self.broadcast:
                game_state = self.engine.state.to_dict()
                game_state["actions_taken"] = {
                    "model": model_name,
                    "actions": model_actions,
                }
                frontend_state = self._to_frontend_state(game_state, all_results)
                await self.broadcast({
                    "type": "tick",
                    "tick": tick,
                    "state": frontend_state,
                })

            if self.engine.state.finished or self.stopped:
                break

        # Advance the round after all models have played
        self.engine.apply_actions({}, advance_tick=True)

        game_log.log_round_end(tick, order, self.engine.state.to_dict())

        # Store tick
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
            for r in all_results
        ]
        store_tick(self.episode_id, tick, game_state, model_responses, None)

    async def _run_tick_simultaneous(self, tick: int, game_log: GameLog):
        """Execute a simultaneous tick: all models move at once."""
        model_names = [m.name for m in self.config.models]

        # Broadcast thinking for all models
        if self.broadcast:
            per_status = {name: "thinking" for name in model_names}
            game_state = self.engine.state.to_dict()
            frontend_state = self._to_frontend_state(game_state, [], per_model_status=per_status)
            await self.broadcast({
                "type": "tick",
                "tick": tick,
                "state": frontend_state,
            })

        # Build prompts and call all models
        prompt_state = self.engine.get_prompt_state()
        prompts = self.prompt_builder(prompt_state, model_names)
        results = await self.adapter.call_all(prompts)

        # Parse and apply all actions
        actions: dict[str, list[dict[str, Any]]] = {}
        actions_taken_all: dict[str, list[dict]] = {}

        for result in results:
            if result.response:
                model_actions = self.response_parser(result)
                actions[result.model_name] = model_actions
                actions_taken_all[result.model_name] = model_actions
            else:
                actions[result.model_name] = []
                actions_taken_all[result.model_name] = []
                log.warning("Tick %d — %s: %s", tick, result.model_name, result.error)
            self._last_results[result.model_name] = result

        self.engine.apply_actions(actions)

        # Store tick
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
        store_tick(self.episode_id, tick, game_state, model_responses, None)

        # Broadcast active with all actions
        if self.broadcast:
            game_state["actions_taken_all"] = actions_taken_all
            frontend_state = self._to_frontend_state(game_state, results)
            await self.broadcast({
                "type": "tick",
                "tick": tick,
                "state": frontend_state,
            })

        for turn, result in enumerate(results):
            model_actions = actions_taken_all.get(result.model_name, [])
            game_log.log_turn(tick, turn, result.model_name, result, model_actions)

        game_log.log_round_end(tick, model_names, game_state)

        log.info(
            "Tick %d — %s",
            tick,
            " | ".join(
                f"{r.model_name}: {'OK' if r.response else 'SKIP'} ({r.latency_ms:.0f}ms)"
                for r in results
            ),
        )

    def _determine_status(
        self,
        model_name: str,
        game_state: dict[str, Any],
        result: ModelResult | None,
        forced: str | None = None,
    ) -> str:
        """Determine the frontend status for a model."""
        if forced:
            return forced
        if game_state.get("finished") and game_state.get("winner") == model_name:
            return "winner"
        if result and result.timed_out:
            return "timeout"
        if result and result.error and "rate" in result.error.lower():
            return "rate_limited"
        if result and result.error:
            return "invalid"
        if game_state.get("models", {}).get(model_name, {}).get("eliminated"):
            return "eliminated"
        return "active"

    def _build_last_action(
        self,
        result: ModelResult | None,
        challenge: str,
    ) -> str:
        """Build a human-readable last action string."""
        if not result or not result.response:
            return ""

        if challenge == "territory_war":
            actions = result.response.get("actions", [])
            if actions:
                a = actions[0]
                direction = a.get("direction") or ""
                return f"{a.get('action', '?')} {direction}".strip()

        elif challenge == "trading_pit":
            decisions = result.response.get("decisions", [])
            active = [d for d in decisions if d.get("action") != "hold"]
            if active:
                d = active[0]
                return f"{d['action']} {d['asset']}"

        return ""

    def _to_frontend_state(
        self,
        game_state: dict[str, Any],
        results: list[ModelResult],
        per_model_status: dict[str, str | None] | None = None,
    ) -> dict[str, Any]:
        """Transform raw engine state into the frontend GameState format.

        per_model_status: optional dict mapping model name to a forced status
                          (e.g. "thinking"). None values use default logic.
        """
        elapsed = int(time.time() - self._start_time)
        challenge = self.config.challenge_name

        # Build result lookup
        result_map: dict[str, ModelResult] = {r.model_name: r for r in results}

        # Build model states array
        models_frontend = []
        for model_cfg in self.config.models:
            model_name = model_cfg.name
            model_id = MODEL_IDS.get(model_name, model_name.lower())
            colour = MODEL_COLOURS.get(model_name, "#FFFFFF")
            result = result_map.get(model_name)

            forced = (per_model_status or {}).get(model_name)
            status = self._determine_status(model_name, game_state, result, forced)
            last_action = "Deciding next move..." if forced == "thinking" else self._build_last_action(result, challenge)

            # Challenge-specific metrics and stats
            if challenge == "territory_war":
                territory_score = game_state.get("territory_score", {})
                territory = game_state.get("territory", {})
                grid = game_state.get("grid", [])
                total_tiles = len(grid) * len(grid[0]) if grid else 400
                model_data = game_state.get("models", {}).get(model_name, {})
                primary_metric = territory_score.get(model_name, 0)
                primary_metric_label = "Territory"
                tiles = territory.get(model_name, 0)
                stats = {
                    "Ore": model_data.get("ore", 0),
                    "Food": model_data.get("food", 0),
                    "Pieces": sum(
                        1 for u in game_state.get("units", [])
                        if u.get("model") == model_name
                    ),
                    "Tiles": tiles,
                }
            elif challenge == "trading_pit":
                portfolio = game_state.get("portfolios", {}).get(model_name, {})
                total_value = portfolio.get("total_value", 10000)
                primary_metric = round(total_value)
                primary_metric_label = "Portfolio"
                stats = {
                    "Cash": f"\u00a3{portfolio.get('cash', 0):,.0f}",
                }
            else:
                primary_metric = 0
                primary_metric_label = ""
                stats = {}

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
