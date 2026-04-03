"""Pydantic action schemas per challenge."""

from pydantic import BaseModel, Field
from typing import Literal


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
