"""AI Adapter — calls multiple models simultaneously, parses structured responses."""

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from google import genai

from pydantic import BaseModel
from ai_adapter.schemas import TradingPitResponse, TerritoryWarResponse


CALL_TIMEOUT = 60.0  # seconds — all episodes pre-recorded, latency not a constraint


@dataclass
class ModelConfig:
    """Configuration for a single AI model."""
    name: str
    provider: str  # "anthropic", "openai", "google"
    model_id: str
    max_tokens: int = 300
    temperature: float = 0.3


@dataclass
class ModelResult:
    """Result from a single model call."""
    model_name: str
    response: dict | None = None
    latency_ms: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    error: str | None = None
    timed_out: bool = False


# Default test models (cheap tier for PoC)
DEFAULT_MODELS = [
    ModelConfig(
        name="Claude",
        provider="anthropic",
        model_id="claude-haiku-4-5-20251001",
    ),
    ModelConfig(
        name="ChatGPT",
        provider="openai",
        model_id="gpt-4o-mini",
    ),
    ModelConfig(
        name="Gemini",
        provider="google",
        model_id="gemini-2.5-flash",
    ),
]


def build_trading_pit_prompt(state: dict[str, Any]) -> str:
    """Build a structured prompt for the Trading Pit challenge.

    Accepts the dict returned by TradingPitEngine.get_prompt_state().
    """
    prices = state["prices"]
    headline = state["headline"]
    tick = state["tick"]
    max_ticks = state["max_ticks"]

    return f"""You are an AI trader competing in a live trading game.

Turn {tick + 1} of {max_ticks}.

Current asset prices:
{json.dumps(prices, indent=2)}

Breaking news headline: "{headline}"

For each asset, decide whether to buy, sell, or hold, and specify an amount in £ (max 5000 per trade).

Respond ONLY with valid JSON matching this exact schema:
{{
  "decisions": [
    {{
      "asset": "<asset name>",
      "action": "buy" | "sell" | "hold",
      "amount": <integer 0-5000>,
      "reasoning": "<brief reasoning, max 100 chars>"
    }}
  ]
}}

You must include exactly one decision per asset. Amount must be 0 for hold actions."""


class AIAdapter:
    """Calls multiple AI models simultaneously and collects structured responses."""

    def __init__(
        self,
        models: list[ModelConfig] | None = None,
        response_schema: type[BaseModel] = TradingPitResponse,
    ):
        self.models = models or DEFAULT_MODELS
        self.response_schema = response_schema
        self._anthropic = AsyncAnthropic()
        self._openai = AsyncOpenAI()
        self._google = genai.Client()

    async def call_all(self, prompt: str) -> list[ModelResult]:
        """Call all configured models simultaneously and return results."""
        tasks = [self._call_model(model, prompt) for model in self.models]
        return await asyncio.gather(*tasks)

    async def _call_model(self, config: ModelConfig, prompt: str) -> ModelResult:
        """Call a single model with timeout handling."""
        result = ModelResult(model_name=config.name)
        start = time.perf_counter()

        try:
            raw = await asyncio.wait_for(
                self._dispatch(config, prompt),
                timeout=CALL_TIMEOUT,
            )
            result.latency_ms = (time.perf_counter() - start) * 1000

            # Strip markdown code fences if present
            content = raw["content"].strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[1]  # remove opening ```json
                content = content.rsplit("```", 1)[0]  # remove closing ```
                content = content.strip()

            # Parse and validate response
            parsed = json.loads(content)
            validated = self.response_schema.model_validate(parsed)
            result.response = validated.model_dump()
            result.input_tokens = raw.get("input_tokens", 0)
            result.output_tokens = raw.get("output_tokens", 0)

        except asyncio.TimeoutError:
            result.latency_ms = (time.perf_counter() - start) * 1000
            result.timed_out = True
            result.error = f"Timed out after {CALL_TIMEOUT}s"

        except json.JSONDecodeError as e:
            result.latency_ms = (time.perf_counter() - start) * 1000
            result.error = f"Invalid JSON: {e}"

        except Exception as e:
            result.latency_ms = (time.perf_counter() - start) * 1000
            result.error = f"{type(e).__name__}: {e}"

        return result

    async def _dispatch(self, config: ModelConfig, prompt: str) -> dict[str, Any]:
        """Route to the correct provider API."""
        if config.provider == "anthropic":
            return await self._call_anthropic(config, prompt)
        elif config.provider == "openai":
            return await self._call_openai(config, prompt)
        elif config.provider == "google":
            return await self._call_google(config, prompt)
        else:
            raise ValueError(f"Unknown provider: {config.provider}")

    async def _call_anthropic(self, config: ModelConfig, prompt: str) -> dict[str, Any]:
        response = await self._anthropic.messages.create(
            model=config.model_id,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
            messages=[{"role": "user", "content": prompt}],
        )
        return {
            "content": response.content[0].text,
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }

    async def _call_openai(self, config: ModelConfig, prompt: str) -> dict[str, Any]:
        response = await self._openai.chat.completions.create(
            model=config.model_id,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
            messages=[{"role": "user", "content": prompt}],
        )
        return {
            "content": response.choices[0].message.content,
            "input_tokens": response.usage.prompt_tokens,
            "output_tokens": response.usage.completion_tokens,
        }

    async def _call_google(self, config: ModelConfig, prompt: str) -> dict[str, Any]:
        response = await self._google.aio.models.generate_content(
            model=config.model_id,
            contents=prompt,
            config=genai.types.GenerateContentConfig(
                max_output_tokens=config.max_tokens,
                temperature=config.temperature,
                thinking_config=genai.types.ThinkingConfig(thinking_budget=0),
            ),
        )
        return {
            "content": response.text,
            "input_tokens": response.usage_metadata.prompt_token_count,
            "output_tokens": response.usage_metadata.candidates_token_count,
        }


def build_territory_war_prompt(state: dict[str, Any]) -> str:
    """Build a structured prompt for the Territory War challenge.

    Accepts the dict returned by TerritoryWarEngine.get_prompt_state().
    The prompt includes the full map, unit positions, and resources —
    but is built per-model so each model only sees its own units' IDs.
    """
    tick = state["tick"]
    max_ticks = state["max_ticks"]
    territory = state.get("territory", {})
    units = state.get("units", [])
    models = state.get("models", {})
    events = state.get("event_log", [])

    # Summarise map instead of sending full grid (saves tokens)
    resource_tiles = []
    for row in state.get("grid", []):
        for tile in row:
            if tile.get("type") in ("ore", "food"):
                resource_tiles.append(tile)

    return f"""You are an AI commander in a territory control game on a 20x20 grid.

Turn {tick + 1} of {max_ticks}.

TERRITORY CONTROL: {json.dumps(territory)}

YOUR UNITS:
{json.dumps(units, indent=2)}

MODEL RESOURCES:
{json.dumps(models, indent=2)}

RESOURCE TILES ON MAP:
{json.dumps(resource_tiles, indent=2)}

RECENT EVENTS:
{json.dumps(events, indent=2)}

AVAILABLE ACTIONS (up to 3 per turn):
- move: move a unit in a direction (up/down/left/right)
- attack: attack an adjacent enemy unit (target_id required)
- harvest: gather resources from the tile the unit stands on
- build: build a fort on the current tile (costs 10 ore)
- trade: send a trade offer to another model

Respond ONLY with valid JSON:
{{
  "actions": [
    {{
      "unit_id": <int>,
      "action": "move" | "attack" | "harvest" | "build" | "trade",
      "direction": "up" | "down" | "left" | "right",
      "target_id": <int or null>,
      "target_model": "<name or null>",
      "offer": {{"ore": <int>}} or null,
      "request": {{"food": <int>}} or null,
      "reasoning": "<brief reasoning, max 100 chars>"
    }}
  ]
}}

Only include fields relevant to the action. Maximum 3 actions per turn."""
