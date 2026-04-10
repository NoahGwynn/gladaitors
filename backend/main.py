"""FastAPI app — WebSocket endpoint for live game state."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from storage.db import init_db
from ai_adapter.adapter import (
    ModelResult,
    get_models_for_tier,
    get_prompt_template,
    build_trading_pit_prompts,
    build_territory_war_prompts,
)
from ai_adapter.schemas import TradingPitResponse, TerritoryWarResponse
from game_engine.trading_pit import TradingPitEngine
from game_engine.territory_war import TerritoryWarEngine
from game_engine.runner import ChallengeRunner, RunnerConfig


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="gladaitor", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Lock down in production
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    """Manages WebSocket connections for broadcasting game state."""

    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active.append(websocket)

    async def disconnect(self, websocket: WebSocket):
        try:
            self.active.remove(websocket)
        except ValueError:
            pass

    async def broadcast(self, data: dict):
        message = json.dumps(data)
        for ws in list(self.active):
            try:
                await ws.send_text(message)
            except Exception:
                try:
                    self.active.remove(ws)
                except ValueError:
                    pass


manager = ConnectionManager()
active_runner: ChallengeRunner | None = None
current_tier: int = 2


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send initial state if there's an active runner
        if active_runner:
            game_state = active_runner.engine.state.to_dict()
            frontend_state = active_runner._to_frontend_state(game_state, [])
            await websocket.send_text(json.dumps({"type": "tick", "state": frontend_state}))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/prompts/{name}")
async def get_prompt(name: str):
    """Return a prompt template by name. Handles system+turn split."""
    try:
        system = get_prompt_template(f"{name}_system")
        turn = get_prompt_template(name)
        return {"game": name, "system_template": system, "turn_template": turn}
    except FileNotFoundError:
        try:
            template = get_prompt_template(name)
            return {"template": template}
        except FileNotFoundError:
            return {"error": f"Prompt '{name}' not found"}


@app.post("/models/tier")
async def set_model_tier(tier: int):
    """Set the model tier for future games."""
    global current_tier
    if tier not in (1, 2, 3):
        return {"error": "Tier must be 1, 2, or 3"}
    current_tier = tier
    models = get_models_for_tier(tier)
    return {
        "tier": tier,
        "models": [{"name": m.name, "model_id": m.model_id} for m in models],
    }


@app.get("/models/tier")
async def get_model_tier():
    """Get the current model tier."""
    models = get_models_for_tier(current_tier)
    return {
        "tier": current_tier,
        "models": [{"name": m.name, "model_id": m.model_id} for m in models],
    }


def create_runner(game_name: str, rounds: int | None = None) -> ChallengeRunner:
    """Create a runner for the given game name using the current tier."""
    models = get_models_for_tier(current_tier)
    model_names = [m.name for m in models]
    # Normalise: URL uses dashes, internal uses underscores
    challenge = game_name.replace("-", "_")

    if challenge == "territory_war":
        engine = TerritoryWarEngine(model_names)
        config = RunnerConfig(
            challenge_name="territory_war",
            models=models,
            tick_interval=2.0,
            max_ticks=rounds or 100,
            response_schema=TerritoryWarResponse,
            engine_config={"grid_size": 20, "starting_units": 3},
            simultaneous=False,
        )
        return ChallengeRunner(
            config=config,
            engine=engine,
            prompt_builder=build_territory_war_prompts,
            response_parser=parse_territory_war_response,
            broadcast=manager.broadcast,
        )

    elif challenge == "trading_pit":
        engine = TradingPitEngine(model_names)
        config = RunnerConfig(
            challenge_name="trading_pit",
            models=models,
            tick_interval=2.0,
            max_ticks=rounds or 40,
            response_schema=TradingPitResponse,
            engine_config={"assets": 5, "starting_cash": 10_000},
            simultaneous=True,
        )
        return ChallengeRunner(
            config=config,
            engine=engine,
            prompt_builder=build_trading_pit_prompts,
            response_parser=parse_trading_pit_response,
            broadcast=manager.broadcast,
        )

    else:
        raise ValueError(f"Unknown challenge: {challenge}")


def parse_trading_pit_response(result: ModelResult) -> list[dict]:
    """Extract trade decisions from a validated model response."""
    if not result.response:
        return []
    return result.response.get("decisions", [])


def parse_territory_war_response(result: ModelResult) -> list[dict]:
    """Extract piece actions from a validated model response."""
    if not result.response:
        return []
    return result.response.get("actions", [])


@app.post("/games/load/{challenge}")
async def load_game(challenge: str, rounds: int | None = None):
    """Load a game (create runner) without starting it. Optional rounds override."""
    global active_runner
    if active_runner and not active_runner.stopped:
        active_runner.stopped = True

    runner = create_runner(challenge, rounds=rounds)
    active_runner = runner

    await runner.broadcast_initial_state()

    return {
        "status": "loaded",
        "game": challenge,
        "tier": current_tier,
        "ticks": runner.config.max_ticks,
        "models": [{"name": m.name, "model_id": m.model_id} for m in runner.config.models],
    }


@app.post("/games/start")
async def start_game():
    """Start the currently loaded game."""
    global active_runner
    if not active_runner:
        return {"error": "No game loaded"}
    if not active_runner.waiting:
        return {"error": "Game already started"}

    asyncio.create_task(active_runner.run())
    # Small delay to let run() begin and create episode
    await asyncio.sleep(0.1)
    await active_runner.go()

    return {
        "status": "started",
        "game": active_runner.config.challenge_name,
        "episode_id": active_runner.episode_id,
    }


@app.post("/games/rotate/{challenge}")
async def rotate_game(challenge: str):
    """Stop current game and load a new one."""
    global active_runner
    if active_runner and not active_runner.stopped:
        active_runner.stopped = True
        await asyncio.sleep(0.2)

    runner = create_runner(challenge)
    active_runner = runner
    await runner.broadcast_initial_state()

    return {
        "status": "loaded",
        "game": challenge,
        "tier": current_tier,
        "ticks": runner.config.max_ticks,
        "models": [{"name": m.name, "model_id": m.model_id} for m in runner.config.models],
    }


@app.post("/games/stop")
async def stop_game():
    """Stop the currently running game."""
    global active_runner
    if active_runner and not active_runner.stopped:
        active_runner.stopped = True
        active_runner = None
        return {"status": "stopped"}
    return {"status": "no active game"}


@app.post("/games/pause")
async def pause_game():
    """Toggle pause on the current game."""
    global active_runner
    if not active_runner:
        return {"error": "No active game"}
    active_runner.paused = not active_runner.paused
    return {"status": "paused" if active_runner.paused else "resumed"}


@app.get("/games/status")
async def game_status():
    """Get the current game status."""
    if not active_runner:
        return {"status": "idle"}
    return {
        "status": "paused" if active_runner.paused else ("waiting" if active_runner.waiting else "running"),
        "episode_id": active_runner.episode_id,
        "challenge": active_runner.config.challenge_name,
        "stopped": active_runner.stopped,
    }


# --- Legacy endpoints (load + start in one call) ---

@app.post("/games/trading-pit")
async def start_trading_pit():
    """Launch a Trading Pit challenge."""
    global active_runner
    if active_runner and not active_runner.stopped:
        active_runner.stopped = True

    runner = create_runner("trading_pit")
    active_runner = runner
    asyncio.create_task(runner.run())
    await asyncio.sleep(0.1)
    await runner.go()

    return {
        "status": "started",
        "episode_id": runner.episode_id,
        "models": [m.name for m in runner.config.models],
        "ticks": runner.config.max_ticks,
        "tick_interval": runner.config.tick_interval,
    }


@app.post("/games/territory-war")
async def start_territory_war():
    """Launch a Territory War challenge."""
    global active_runner
    if active_runner and not active_runner.stopped:
        active_runner.stopped = True

    runner = create_runner("territory_war")
    active_runner = runner
    asyncio.create_task(runner.run())
    await asyncio.sleep(0.1)
    await runner.go()

    return {
        "status": "started",
        "episode_id": runner.episode_id,
        "models": [m.name for m in runner.config.models],
        "ticks": runner.config.max_ticks,
        "tick_interval": runner.config.tick_interval,
    }
