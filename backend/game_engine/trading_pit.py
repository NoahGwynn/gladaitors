"""Trading Pit — state machine for the Trading Pit challenge.

Market simulation with scripted events. Backend owns all game state.
"""

import random
from dataclasses import dataclass, field
from typing import Any


ASSETS = ["Tech Stock", "Energy", "Gold", "Crypto", "Bonds"]

STARTING_CASH = 10_000
STARTING_PRICES = {
    "Tech Stock": 142.50,
    "Energy": 87.20,
    "Gold": 203.00,
    "Crypto": 312.75,
    "Bonds": 98.40,
}

# Scripted events: (tick_number, headline, asset, price_change_pct)
SCRIPTED_EVENTS = [
    (8, "Tech giant announces record losses", "Tech Stock", -0.40),
    (20, "Energy crisis averted — supply floods market", "Energy", 0.60),
    (32, "Major crypto exchange hacked — funds frozen", "Crypto", -0.85),
]


@dataclass
class Portfolio:
    """A single model's portfolio."""
    model_name: str
    cash: float = 0.0
    holdings: dict[str, float] = field(default_factory=dict)  # asset -> units held

    def total_value(self, prices: dict[str, float]) -> float:
        return self.cash + sum(
            self.holdings.get(asset, 0) * price
            for asset, price in prices.items()
        )


@dataclass
class TradingPitState:
    """Complete game state for the Trading Pit challenge."""
    tick: int = 0
    max_ticks: int = 40  # 10 minutes at 15s intervals
    prices: dict[str, float] = field(default_factory=lambda: dict(STARTING_PRICES))
    portfolios: dict[str, Portfolio] = field(default_factory=dict)
    price_history: list[dict[str, float]] = field(default_factory=list)
    event_log: list[dict[str, Any]] = field(default_factory=list)
    finished: bool = False
    winner: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "tick": self.tick,
            "max_ticks": self.max_ticks,
            "prices": dict(self.prices),
            "portfolios": {
                name: {
                    "cash": p.cash,
                    "holdings": dict(p.holdings),
                    "total_value": p.total_value(self.prices),
                }
                for name, p in self.portfolios.items()
            },
            "price_history": self.price_history,
            "event_log": self.event_log,
            "finished": self.finished,
            "winner": self.winner,
        }


class TradingPitEngine:
    """Runs the Trading Pit challenge."""

    def __init__(self, model_names: list[str]):
        self.state = TradingPitState()
        # Initialise portfolios: split starting cash evenly across assets
        for name in model_names:
            portfolio = Portfolio(model_name=name, cash=0.0, holdings={})
            per_asset = STARTING_CASH / len(ASSETS)
            for asset in ASSETS:
                units = per_asset / self.state.prices[asset]
                portfolio.holdings[asset] = units
            self.state.portfolios[name] = portfolio

        self.state.price_history.append(dict(self.state.prices))

    @property
    def current_headline(self) -> str | None:
        """Return the scripted headline for the current tick, if any."""
        for tick, headline, _, _ in SCRIPTED_EVENTS:
            if tick == self.state.tick:
                return headline
        return None

    def get_prompt_state(self) -> dict[str, Any]:
        """State to send to models for decision-making (no other model info)."""
        return {
            "tick": self.state.tick,
            "max_ticks": self.state.max_ticks,
            "prices": dict(self.state.prices),
            "headline": self.current_headline or self._generate_noise_headline(),
        }

    def apply_actions(self, actions: dict[str, list[dict[str, Any]]]):
        """Apply trade decisions from all models, then advance the tick.

        actions: {model_name: [{"asset": ..., "action": ..., "amount": ...}, ...]}
        """
        # Apply trades
        for model_name, decisions in actions.items():
            portfolio = self.state.portfolios.get(model_name)
            if not portfolio:
                continue
            for decision in decisions:
                self._execute_trade(portfolio, decision)

        # Apply scripted price events
        headline = self._apply_scripted_events()

        # Apply random market drift
        self._apply_market_drift()

        # Record state
        self.state.price_history.append(dict(self.state.prices))
        self.state.tick += 1

        # Check end condition
        if self.state.tick >= self.state.max_ticks:
            self._finish()

    def _execute_trade(self, portfolio: Portfolio, decision: dict[str, Any]):
        """Execute a single trade decision for a portfolio."""
        asset = decision.get("asset")
        action = decision.get("action")
        amount = decision.get("amount", 0)

        if asset not in self.state.prices or action == "hold" or amount <= 0:
            return

        price = self.state.prices[asset]

        if action == "buy":
            # Check if model has enough value in other assets to sell
            # For simplicity, allow buying with cash from selling
            units = amount / price
            portfolio.holdings[asset] = portfolio.holdings.get(asset, 0) + units
            portfolio.cash -= amount

        elif action == "sell":
            current_units = portfolio.holdings.get(asset, 0)
            units_to_sell = min(amount / price, current_units)
            portfolio.holdings[asset] = current_units - units_to_sell
            portfolio.cash += units_to_sell * price

    def _apply_scripted_events(self) -> str | None:
        """Apply any scripted price changes for the current tick."""
        for tick, headline, asset, pct_change in SCRIPTED_EVENTS:
            if tick == self.state.tick:
                old_price = self.state.prices[asset]
                new_price = old_price * (1 + pct_change)
                self.state.prices[asset] = max(new_price, 0.01)
                self.state.event_log.append({
                    "tick": self.state.tick,
                    "headline": headline,
                    "asset": asset,
                    "old_price": round(old_price, 2),
                    "new_price": round(self.state.prices[asset], 2),
                })
                return headline
        return None

    def _apply_market_drift(self):
        """Small random price movements each tick."""
        for asset in ASSETS:
            drift = random.uniform(-0.03, 0.03)  # ±3%
            self.state.prices[asset] *= (1 + drift)
            self.state.prices[asset] = round(max(self.state.prices[asset], 0.01), 2)

    def _generate_noise_headline(self) -> str:
        """Generate a filler headline for non-event ticks."""
        headlines = [
            "Markets steady amid mixed economic signals",
            "Analysts divided on short-term outlook",
            "Trading volumes remain within normal range",
            "Regulatory review of financial sector continues",
            "Global supply chain concerns ease slightly",
            "Consumer confidence index holds steady",
            "Central bank signals patience on rate decisions",
            "Commodity prices fluctuate on weather reports",
        ]
        return random.choice(headlines)

    def _finish(self):
        """Determine the winner and mark the game as finished."""
        self.state.finished = True
        best_model = max(
            self.state.portfolios.values(),
            key=lambda p: p.total_value(self.state.prices),
        )
        self.state.winner = best_model.model_name
