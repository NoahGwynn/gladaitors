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
        max_length=300,
        description="Brief reasoning for this decision",
    )


class TradingPitResponse(BaseModel):
    """Complete response from a model for one Trading Pit tick."""
    decisions: list[TradeDecision] = Field(
        description="One decision per asset in the portfolio",
    )


# --- Territory War ---

class PieceAction(BaseModel):
    """A single action for one piece."""
    unit_id: int = Field(description="ID of the piece to command")
    action: Literal["move", "attack", "harvest", "build", "heal"] = Field(
        description="The action type",
    )
    direction: Literal["up", "down", "left", "right"] | None = Field(
        default=None,
        description="Direction for move action",
    )
    target_id: int | None = Field(
        default=None,
        description="Target piece ID for attack action",
    )
    target_x: int | None = Field(
        default=None,
        description="Target X coordinate for fort attack",
    )
    target_y: int | None = Field(
        default=None,
        description="Target Y coordinate for fort attack",
    )
    reasoning: str = Field(
        max_length=300,
        description="Brief reasoning for this action",
    )


class TerritoryWarResponse(BaseModel):
    """Complete response from a model for one Territory War turn."""
    actions: list[PieceAction] = Field(
        max_length=3,
        description="Up to 3 piece actions per turn",
    )
