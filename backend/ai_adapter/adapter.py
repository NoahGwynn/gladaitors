"""AI Adapter — calls multiple models simultaneously, parses structured responses."""

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from google import genai

from pydantic import BaseModel, ValidationError
from ai_adapter.schemas import TradingPitResponse, TerritoryWarResponse


log = logging.getLogger(__name__)

CALL_TIMEOUT = 60.0  # seconds
PROMPTS_DIR = Path(__file__).parent / "prompts"

# Type alias: a prompt is either a plain string or a dict with "system" and "user" keys
Prompt = str | dict[str, str]


@dataclass
class ModelConfig:
    """Configuration for a single AI model."""
    name: str
    provider: str  # "anthropic", "openai", "google"
    model_id: str
    max_tokens: int = 8000
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


# Model tiers — grouped by capability/cost
MODEL_TIERS: dict[int, list[ModelConfig]] = {
    1: [
        ModelConfig(name="Claude", provider="anthropic", model_id="claude-haiku-4-5-20251001"),
        ModelConfig(name="ChatGPT", provider="openai", model_id="gpt-4o-mini"),
        ModelConfig(name="Gemini", provider="google", model_id="gemini-2.0-flash"),
    ],
    2: [
        # Tier 2: mid-range models — balanced cost and capability
        ModelConfig(name="Claude", provider="anthropic", model_id="claude-sonnet-4-6"),
        ModelConfig(name="ChatGPT", provider="openai", model_id="gpt-4o"),
        ModelConfig(name="Gemini", provider="google", model_id="gemini-2.5-flash"),
    ],
    3: [
        ModelConfig(name="Claude", provider="anthropic", model_id="claude-opus-4-6"),
        ModelConfig(name="ChatGPT", provider="openai", model_id="gpt-4o", max_tokens=8000),
        ModelConfig(name="Gemini", provider="google", model_id="gemini-2.5-pro", max_tokens=8000),
    ],
}

DEFAULT_MODELS = MODEL_TIERS[2]


def get_models_for_tier(tier: int) -> list[ModelConfig]:
    """Return the models for a given tier (1-3). Defaults to tier 2."""
    return MODEL_TIERS.get(tier, MODEL_TIERS[2])


def get_prompt_template(name: str) -> str:
    """Load a prompt template from the prompts directory."""
    path = PROMPTS_DIR / f"{name}.txt"
    return path.read_text(encoding="utf-8")


def _extract_json(raw: str) -> str:
    """Extract JSON from a model response that may contain markdown fences or prose."""
    content = raw.strip()

    # Handle markdown code fences
    if content.startswith("```"):
        content = content.split("\n", 1)[1]  # remove opening ```json
        content = content.rsplit("```", 1)[0]  # remove closing ```
        content = content.strip()
        return content

    # Handle JSON buried after prose — find the first { and match braces
    brace_start = content.find("{")
    if brace_start > 0:
        depth = 0
        for i in range(brace_start, len(content)):
            if content[i] == "{":
                depth += 1
            elif content[i] == "}":
                depth -= 1
                if depth == 0:
                    return content[brace_start:i + 1]

    return content


def build_trading_pit_prompts(state: dict[str, Any], model_names: list[str]) -> dict[str, Prompt]:
    """Build per-model prompts for the Trading Pit challenge.

    Returns a dict mapping model_name -> {"system": ..., "user": ...}.
    """
    system_template = get_prompt_template("trading_pit_system")
    user_template = get_prompt_template("trading_pit")

    prices = state["prices"]
    headline = state["headline"]
    tick = state["tick"]
    max_ticks = state["max_ticks"]
    portfolios = state.get("portfolios", {})

    prompts: dict[str, Prompt] = {}
    for name in model_names:
        portfolio = portfolios.get(name, {})
        cash = portfolio.get("cash", 0)
        holdings = portfolio.get("holdings", {})
        total_value = portfolio.get("total_value", 0)

        # Format holdings with current values
        holdings_str = json.dumps(
            {asset: {"units": round(units, 2), "value": round(units * prices.get(asset, 0), 2)}
             for asset, units in holdings.items()},
            indent=2,
        )

        system = system_template.format(model_name=name, max_ticks=max_ticks)
        user = user_template.format(
            tick=tick + 1,
            max_ticks=max_ticks,
            headline=headline,
            prices=json.dumps(prices, indent=2),
            cash=f"{cash:,.2f}",
            holdings=holdings_str,
            total_value=f"{total_value:,.2f}",
        )
        prompts[name] = {"system": system, "user": user}

    return prompts


def build_territory_war_prompts(state: dict[str, Any], model_names: list[str]) -> dict[str, Prompt]:
    """Build per-model prompts for the Territory War challenge.

    Each model sees its own pieces as 'Your pieces' and enemies as 'Enemy pieces'.
    Returns a dict mapping model_name -> {"system": ..., "user": ...}.
    """
    system_template = get_prompt_template("territory_war_system")
    user_template = get_prompt_template("territory_war")

    tick = state["tick"]
    max_ticks = state["max_ticks"]
    territory = state.get("territory", {})
    territory_score = state.get("territory_score", {})
    units = state.get("units", [])
    models = state.get("models", {})
    events = state.get("event_log", [])
    grid = state.get("grid", [])

    # Build resource tile list
    resource_tiles = []
    for row in grid:
        for tile in row:
            if tile.get("type") in ("ore", "food"):
                resource_tiles.append(tile)

    prompts: dict[str, Prompt] = {}
    for name in model_names:
        model_data = models.get(name, {})
        if model_data.get("eliminated"):
            continue

        # Split units into mine vs enemy
        my_units = [u for u in units if u.get("model") == name]
        enemy_units = [u for u in units if u.get("model") != name]

        # Claimed tiles per model
        my_territory = []
        enemy_territory = {}
        for row in grid:
            for tile in row:
                owner = tile.get("owner")
                if owner == name:
                    my_territory.append({"x": tile["x"], "y": tile["y"]})
                elif owner and owner != name:
                    if owner not in enemy_territory:
                        enemy_territory[owner] = []
                    enemy_territory[owner].append({"x": tile["x"], "y": tile["y"]})

        config = state.get("config", {})
        grid_size = state.get("grid_size", 20)
        system = system_template.format(
            model_name=name,
            max_ticks=max_ticks,
            grid_size=grid_size,
            grid_max=grid_size - 1,
            total_tiles=state.get("total_tiles", grid_size * grid_size),
            win_score=state.get("win_score", int(grid_size * grid_size * 0.6)),
            piece_hp=config.get("piece_hp", 3),
            piece_attack=config.get("piece_attack", 1),
            pieces_per_model=3,
            fort_cost=config.get("fort_cost", 10),
            fort_hp=config.get("fort_hp", 5),
            heal_cost=config.get("heal_cost", 5),
            heal_amount=1,
            harvest_amount=config.get("harvest_amount", 3),
        )
        user = user_template.format(
            tick=tick + 1,
            max_ticks=max_ticks,
            territory_score=json.dumps(territory_score),
            territory=json.dumps(territory),
            my_territory=json.dumps(my_territory),
            enemy_territory=json.dumps(enemy_territory),
            my_units=json.dumps(my_units, indent=2),
            enemy_units=json.dumps(enemy_units, indent=2),
            my_resources=json.dumps({"ore": model_data.get("ore", 0), "food": model_data.get("food", 0)}),
            resource_tiles=json.dumps(resource_tiles, indent=2),
            events=json.dumps(events[-10:], indent=2),
        )
        prompts[name] = {"system": system, "user": user}

    return prompts


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

    async def call_all(self, prompts: dict[str, Prompt]) -> list[ModelResult]:
        """Call all configured models simultaneously with per-model prompts."""
        tasks = [self._call_model(model, prompts.get(model.name, "")) for model in self.models]
        return await asyncio.gather(*tasks)

    async def call_single(self, model: ModelConfig, prompt: Prompt) -> ModelResult:
        """Call a single model and return the result."""
        return await self._call_model(model, prompt)

    async def _call_model(self, config: ModelConfig, prompt: Prompt) -> ModelResult:
        """Call a single model with timeout handling."""
        result = ModelResult(model_name=config.name)
        start = time.perf_counter()
        raw = None

        try:
            raw_response = await asyncio.wait_for(
                self._dispatch(config, prompt),
                timeout=CALL_TIMEOUT,
            )
            result.latency_ms = (time.perf_counter() - start) * 1000

            raw = raw_response["content"].strip()
            log.info(
                "%s raw response (%d chars): %s",
                config.name, len(raw), raw[:500],
            )

            # Extract JSON from response
            content = _extract_json(raw)

            # Parse and validate response
            parsed = json.loads(content)
            validated = self.response_schema.model_validate(parsed)
            result.response = validated.model_dump()
            result.input_tokens = raw_response.get("input_tokens", 0)
            result.output_tokens = raw_response.get("output_tokens", 0)

        except asyncio.TimeoutError:
            result.latency_ms = (time.perf_counter() - start) * 1000
            result.timed_out = True
            result.error = f"Timed out after {CALL_TIMEOUT}s"
            log.warning("%s timed out after %.1fs", config.name, CALL_TIMEOUT)

        except json.JSONDecodeError as e:
            result.latency_ms = (time.perf_counter() - start) * 1000
            result.error = f"Invalid JSON: {e}"
            log.warning("%s invalid JSON: %s — raw: %s", config.name, e, raw[:500] if raw else "None")

        except ValidationError as e:
            result.latency_ms = (time.perf_counter() - start) * 1000
            result.error = f"Validation error: {e}"
            log.warning("%s validation error: %s — raw: %s", config.name, e, raw[:500] if raw else "None")

        except Exception as e:
            result.latency_ms = (time.perf_counter() - start) * 1000
            result.error = f"{type(e).__name__}: {e}"
            log.warning("%s error: %s", config.name, e, exc_info=True)

        return result

    async def _dispatch(self, config: ModelConfig, prompt: Prompt) -> dict[str, Any]:
        """Route to the correct provider API. Normalises prompt to system + user."""
        if isinstance(prompt, dict):
            system = prompt.get("system", "")
            user = prompt.get("user", "")
        else:
            system = ""
            user = prompt

        if config.provider == "anthropic":
            return await self._call_anthropic(config, system, user)
        elif config.provider == "openai":
            return await self._call_openai(config, system, user)
        elif config.provider == "google":
            return await self._call_google(config, system, user)
        else:
            raise ValueError(f"Unknown provider: {config.provider}")

    async def _call_anthropic(self, config: ModelConfig, system: str, user: str) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": config.model_id,
            "max_tokens": config.max_tokens,
            "temperature": config.temperature,
            "messages": [{"role": "user", "content": user}],
        }
        if system:
            kwargs["system"] = system

        response = await self._anthropic.messages.create(**kwargs)
        # Iterate content blocks to find text
        text = ""
        for block in response.content:
            if hasattr(block, "text"):
                text += block.text
        return {
            "content": text,
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }

    async def _call_openai(self, config: ModelConfig, system: str, user: str) -> dict[str, Any]:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user})

        response = await self._openai.chat.completions.create(
            model=config.model_id,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
            messages=messages,
        )
        return {
            "content": response.choices[0].message.content,
            "input_tokens": response.usage.prompt_tokens,
            "output_tokens": response.usage.completion_tokens,
        }

    async def _call_google(self, config: ModelConfig, system: str, user: str) -> dict[str, Any]:
        gen_config = genai.types.GenerateContentConfig(
            max_output_tokens=config.max_tokens,
            temperature=config.temperature,
            thinking_config=genai.types.ThinkingConfig(thinking_budget=0),
        )
        if system:
            gen_config.system_instruction = system

        response = await self._google.aio.models.generate_content(
            model=config.model_id,
            contents=user,
            config=gen_config,
        )
        # Handle None .text from thinking mode
        text = response.text if response.text else ""
        return {
            "content": text,
            "input_tokens": response.usage_metadata.prompt_token_count,
            "output_tokens": response.usage_metadata.candidates_token_count,
        }
