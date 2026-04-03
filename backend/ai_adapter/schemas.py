"""Pydantic action schemas per challenge."""

from pydantic import BaseModel, Field
from typing import Literal


# --- Trading Pit ---

class TradeDecision(BaseModel):
    """A single trade decision for one asset."""
    asset: str = Field(description="The asset to trade")
    action: Literal["buy", "sell", "hold"] = Field(description="The trade action")
    amount: int = Field(
        ge=0,
        le=5000,
        description="Amount in £ to buy or sell (0 if holding)",
    )
    reasoning: str = Field(
        max_length=100,
        description="Brief reasoning for this decision",
    )


class TradingPitResponse(BaseModel):
    """Complete response from a model for one Trading Pit tick."""
    decisions: list[TradeDecision] = Field(
        description="One decision per asset in the portfolio",
    )


# --- Territory War ---

class UnitAction(BaseModel):
    """A single action for one unit."""
    unit_id: int = Field(description="ID of the unit to command")
    action: Literal["move", "attack", "harvest", "build", "trade"] = Field(
        description="The action type",
    )
    direction: Literal["up", "down", "left", "right"] | None = Field(
        default=None,
        description="Direction for move action",
    )
    target_id: int | None = Field(
        default=None,
        description="Target unit ID for attack action",
    )
    target_model: str | None = Field(
        default=None,
        description="Target model name for trade action",
    )
    offer: dict | None = Field(
        default=None,
        description="Resources to offer in trade (e.g. {'ore': 5})",
    )
    request: dict | None = Field(
        default=None,
        description="Resources to request in trade (e.g. {'food': 3})",
    )
    reasoning: str = Field(
        max_length=100,
        description="Brief reasoning for this action",
    )


class TerritoryWarResponse(BaseModel):
    """Complete response from a model for one Territory War turn."""
    actions: list[UnitAction] = Field(
        max_length=3,
        description="Up to 3 unit actions per turn",
    )
