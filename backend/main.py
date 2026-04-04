"""FastAPI app — WebSocket endpoint for live game state."""

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from storage.db import init_db
from ai_adapter.adapter import DEFAULT_MODELS, ModelResult, build_trading_pit_prompt, build_territory_war_prompt
from ai_adapter.schemas import TradingPitResponse, TerritoryWarResponse
from game_engine.trading_pit import TradingPitEngine
from game_engine.territory_war import TerritoryWarEngine
from game_engine.runner import ChallengeRunner, RunnerConfig


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="gladAItors", lifespan=lifespan)

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

    def disconnect(self, websocket: WebSocket):
        self.active.remove(websocket)

    async def broadcast(self, data: dict):
        message = json.dumps(data)
        for ws in list(self.active):
            try:
                await ws.send_text(message)
            except Exception:
                self.active.remove(ws)


manager = ConnectionManager()
active_runner: ChallengeRunner | None = None


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep connection alive; clients only receive, they don't send game commands
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


@app.get("/health")
async def health():
    return {"status": "ok"}


def parse_trading_pit_response(result: ModelResult) -> list[dict]:
    """Extract trade decisions from a validated model response."""
    if not result.response:
        return []
    return result.response.get("decisions", [])


@app.post("/games/trading-pit")
async def start_trading_pit():
    """Launch a Trading Pit challenge with the default models."""
    model_names = [m.name for m in DEFAULT_MODELS]
    engine = TradingPitEngine(model_names)

    config = RunnerConfig(
        challenge_name="trading_pit",
        models=DEFAULT_MODELS,
        tick_interval=15.0,
        max_ticks=40,
        engine_config={"assets": 5, "starting_cash": 10_000},
    )

    runner = ChallengeRunner(
        config=config,
        engine=engine,
        prompt_builder=build_trading_pit_prompt,
        response_parser=parse_trading_pit_response,
        broadcast=manager.broadcast,
    )

    global active_runner
    active_runner = runner
    asyncio.create_task(runner.run())

    return {
        "status": "started",
        "episode_id": runner.episode_id,
        "models": model_names,
        "ticks": config.max_ticks,
        "tick_interval": config.tick_interval,
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


def parse_territory_war_response(result: ModelResult) -> list[dict]:
    """Extract unit actions from a validated model response."""
    if not result.response:
        return []
    return result.response.get("actions", [])


@app.post("/games/territory-war")
async def start_territory_war():
    """Launch a Territory War challenge with the default models."""
    model_names = [m.name for m in DEFAULT_MODELS]
    engine = TerritoryWarEngine(model_names)

    config = RunnerConfig(
        challenge_name="territory_war",
        models=DEFAULT_MODELS,
        tick_interval=20.0,
        max_ticks=60,
        response_schema=TerritoryWarResponse,
        engine_config={"grid_size": 20, "starting_units": 3},
    )

    runner = ChallengeRunner(
        config=config,
        engine=engine,
        prompt_builder=build_territory_war_prompt,
        response_parser=parse_territory_war_response,
        broadcast=manager.broadcast,
    )

    global active_runner
    active_runner = runner
    asyncio.create_task(runner.run())

    return {
        "status": "started",
        "episode_id": runner.episode_id,
        "models": model_names,
        "ticks": config.max_ticks,
        "tick_interval": config.tick_interval,
    }
