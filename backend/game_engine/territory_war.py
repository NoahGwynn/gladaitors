"""Territory War — state machine for the Territory War challenge.

20x20 grid map. Each model starts with 1 base + 3 units in opposite corners.
Resources (ore, food) scattered across the map. Backend owns all game state.
"""

import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


GRID_SIZE = 20
MAX_UNITS_PER_MODEL = 10
FORT_COST = 10  # ore
DIRECTIONS = {
    "up": (0, -1),
    "down": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
}

# Starting corners for up to 4 models
SPAWN_CORNERS = [
    (1, 1),                          # top-left
    (GRID_SIZE - 2, GRID_SIZE - 2),  # bottom-right
    (GRID_SIZE - 2, 1),              # top-right
    (1, GRID_SIZE - 2),              # bottom-left
]


class TileType(str, Enum):
    EMPTY = "empty"
    ORE = "ore"
    FOOD = "food"
    BASE = "base"
    FORT = "fort"


@dataclass
class Unit:
    id: int
    model_name: str
    x: int
    y: int
    hp: int = 3
    attack: int = 1
    is_barbarian: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "model": self.model_name,
            "x": self.x,
            "y": self.y,
            "hp": self.hp,
            "attack": self.attack,
            "is_barbarian": self.is_barbarian,
        }


@dataclass
class Tile:
    x: int
    y: int
    tile_type: TileType = TileType.EMPTY
    owner: str | None = None       # model_name that controls this tile
    resource_amount: int = 0       # remaining resource yield

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"x": self.x, "y": self.y, "type": self.tile_type.value}
        if self.owner:
            d["owner"] = self.owner
        if self.resource_amount > 0:
            d["resources"] = self.resource_amount
        return d


@dataclass
class ModelState:
    """Per-model resource and territory tracking."""
    name: str
    ore: int = 0
    food: int = 0
    base_x: int = 0
    base_y: int = 0
    eliminated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "ore": self.ore,
            "food": self.food,
            "base": {"x": self.base_x, "y": self.base_y},
            "eliminated": self.eliminated,
        }


# Scripted events: (tick_number, event_type, data)
SCRIPTED_EVENTS = [
    (24, "barbarian", {}),       # T+8min (20s ticks): barbarian attacks leader
    (42, "resource_reveal", {}),  # T+14min: high-value deposit in centre
]


@dataclass
class TerritoryWarState:
    tick: int = 0
    max_ticks: int = 60  # 20 minutes at 20s intervals
    grid: list[list[Tile]] = field(default_factory=list)
    units: list[Unit] = field(default_factory=list)
    models: dict[str, ModelState] = field(default_factory=dict)
    event_log: list[dict[str, Any]] = field(default_factory=list)
    finished: bool = False
    winner: str | None = None
    _next_unit_id: int = 0

    def to_dict(self) -> dict[str, Any]:
        alive_models = {n: m for n, m in self.models.items() if not m.eliminated}
        territory = self._count_territory()
        return {
            "tick": self.tick,
            "max_ticks": self.max_ticks,
            "grid": [[tile.to_dict() for tile in row] for row in self.grid],
            "units": [u.to_dict() for u in self.units if u.hp > 0],
            "models": {n: m.to_dict() for n, m in self.models.items()},
            "territory": territory,
            "event_log": self.event_log[-10:],  # last 10 events
            "finished": self.finished,
            "winner": self.winner,
        }

    def _count_territory(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for row in self.grid:
            for tile in row:
                if tile.owner:
                    counts[tile.owner] = counts.get(tile.owner, 0) + 1
        return counts


class TerritoryWarEngine:
    """Runs the Territory War challenge."""

    def __init__(self, model_names: list[str]):
        if len(model_names) > len(SPAWN_CORNERS):
            raise ValueError(f"Max {len(SPAWN_CORNERS)} models supported")

        self.state = TerritoryWarState()
        self._init_grid()
        self._scatter_resources(ore_count=25, food_count=15)

        for i, name in enumerate(model_names):
            cx, cy = SPAWN_CORNERS[i]
            self._init_model(name, cx, cy)

    def _init_grid(self):
        self.state.grid = [
            [Tile(x=x, y=y) for x in range(GRID_SIZE)]
            for y in range(GRID_SIZE)
        ]

    def _scatter_resources(self, ore_count: int, food_count: int):
        """Place resources randomly, avoiding corners where models spawn."""
        avoid = set()
        for cx, cy in SPAWN_CORNERS:
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    avoid.add((cx + dx, cy + dy))

        available = [
            (x, y)
            for y in range(GRID_SIZE)
            for x in range(GRID_SIZE)
            if (x, y) not in avoid
        ]
        random.shuffle(available)

        for i in range(min(ore_count, len(available))):
            x, y = available[i]
            self.state.grid[y][x].tile_type = TileType.ORE
            self.state.grid[y][x].resource_amount = random.randint(5, 15)

        for i in range(ore_count, min(ore_count + food_count, len(available))):
            x, y = available[i]
            self.state.grid[y][x].tile_type = TileType.FOOD
            self.state.grid[y][x].resource_amount = random.randint(3, 10)

    def _init_model(self, name: str, base_x: int, base_y: int):
        """Set up a model's base and starting units."""
        model = ModelState(name=name, base_x=base_x, base_y=base_y)
        self.state.models[name] = model

        # Place base
        self.state.grid[base_y][base_x].tile_type = TileType.BASE
        self.state.grid[base_y][base_x].owner = name

        # Claim territory around base
        for dx in range(-1, 2):
            for dy in range(-1, 2):
                nx, ny = base_x + dx, base_y + dy
                if 0 <= nx < GRID_SIZE and 0 <= ny < GRID_SIZE:
                    self.state.grid[ny][nx].owner = name

        # Spawn 3 starting units adjacent to base
        offsets = [(1, 0), (0, 1), (1, 1)]
        for dx, dy in offsets:
            ux, uy = base_x + dx, base_y + dy
            if 0 <= ux < GRID_SIZE and 0 <= uy < GRID_SIZE:
                unit = Unit(
                    id=self._next_id(),
                    model_name=name,
                    x=ux, y=uy,
                )
                self.state.units.append(unit)

    def _next_id(self) -> int:
        self.state._next_unit_id += 1
        return self.state._next_unit_id

    def get_prompt_state(self) -> dict[str, Any]:
        """State to send to models. Full map visibility — no fog of war."""
        return self.state.to_dict()

    def apply_actions(self, actions: dict[str, list[dict[str, Any]]]):
        """Apply actions from all models, then advance the tick.

        actions: {model_name: [{"unit_id": ..., "action": ..., ...}, ...]}
        Each model can issue up to 3 unit actions per turn.
        """
        # Process actions per model (max 3 per model per turn)
        for model_name, unit_actions in actions.items():
            model = self.state.models.get(model_name)
            if not model or model.eliminated:
                continue
            for action in unit_actions[:3]:  # max 3 actions per turn
                self._execute_action(model_name, action)

        # Apply scripted events
        self._apply_scripted_events()

        # Update territory (units claim tiles they stand on)
        self._update_territory()

        # Remove dead units
        self.state.units = [u for u in self.state.units if u.hp > 0]

        self.state.tick += 1
        self._check_end_conditions()

    def _execute_action(self, model_name: str, action: dict[str, Any]):
        """Execute a single unit action."""
        unit_id = action.get("unit_id")
        action_type = action.get("action")

        unit = self._get_unit(unit_id, model_name)
        if not unit:
            return

        if action_type == "move":
            self._action_move(unit, action.get("direction", ""))
        elif action_type == "attack":
            self._action_attack(unit, action.get("target_id"))
        elif action_type == "harvest":
            self._action_harvest(unit, model_name)
        elif action_type == "build":
            self._action_build(unit, model_name)
        elif action_type == "trade":
            self._action_trade(model_name, action)

    def _get_unit(self, unit_id: int | None, model_name: str) -> Unit | None:
        """Find a unit owned by the given model."""
        if unit_id is None:
            return None
        for u in self.state.units:
            if u.id == unit_id and u.model_name == model_name and u.hp > 0:
                return u
        return None

    def _action_move(self, unit: Unit, direction: str):
        dx, dy = DIRECTIONS.get(direction, (0, 0))
        nx, ny = unit.x + dx, unit.y + dy
        if 0 <= nx < GRID_SIZE and 0 <= ny < GRID_SIZE:
            unit.x = nx
            unit.y = ny

    def _action_attack(self, unit: Unit, target_id: int | None):
        if target_id is None:
            return
        for target in self.state.units:
            if target.id == target_id and target.hp > 0:
                # Must be adjacent
                if abs(target.x - unit.x) <= 1 and abs(target.y - unit.y) <= 1:
                    target.hp -= unit.attack
                    if target.hp <= 0:
                        self.state.event_log.append({
                            "tick": self.state.tick,
                            "event": "unit_killed",
                            "attacker": unit.model_name,
                            "target": target.model_name,
                            "target_id": target.id,
                        })
                        # Check if target's base is now undefended
                        self._check_base_capture(target.model_name)
                break

    def _action_harvest(self, unit: Unit, model_name: str):
        tile = self.state.grid[unit.y][unit.x]
        if tile.resource_amount <= 0:
            return
        model = self.state.models[model_name]
        harvest = min(tile.resource_amount, 3)  # harvest up to 3 per tick
        if tile.tile_type == TileType.ORE:
            model.ore += harvest
        elif tile.tile_type == TileType.FOOD:
            model.food += harvest
        tile.resource_amount -= harvest
        if tile.resource_amount <= 0:
            tile.tile_type = TileType.EMPTY

    def _action_build(self, unit: Unit, model_name: str):
        model = self.state.models[model_name]
        if model.ore < FORT_COST:
            return
        tile = self.state.grid[unit.y][unit.x]
        if tile.tile_type != TileType.EMPTY:
            return
        model.ore -= FORT_COST
        tile.tile_type = TileType.FORT
        tile.owner = model_name
        self.state.event_log.append({
            "tick": self.state.tick,
            "event": "fort_built",
            "model": model_name,
            "x": unit.x, "y": unit.y,
        })

    def _action_trade(self, model_name: str, action: dict[str, Any]):
        """Record a trade offer. The recipient can accept next turn."""
        target_model = action.get("target_model")
        offer = action.get("offer", {})
        request = action.get("request", {})
        if target_model and target_model in self.state.models:
            self.state.event_log.append({
                "tick": self.state.tick,
                "event": "trade_offer",
                "from": model_name,
                "to": target_model,
                "offer": offer,
                "request": request,
            })

    def _update_territory(self):
        """Units claim the tile they stand on for their model."""
        for unit in self.state.units:
            if unit.hp > 0 and not unit.is_barbarian:
                tile = self.state.grid[unit.y][unit.x]
                if tile.tile_type not in (TileType.BASE,):
                    tile.owner = unit.model_name

    def _check_base_capture(self, model_name: str):
        """Check if a model's base has been captured (enemy unit on base, no defenders)."""
        model = self.state.models[model_name]
        base_tile = self.state.grid[model.base_y][model.base_x]

        # Check if any of this model's units are still alive
        alive = any(
            u for u in self.state.units
            if u.model_name == model_name and u.hp > 0
        )
        if not alive:
            model.eliminated = True
            base_tile.owner = None
            base_tile.tile_type = TileType.EMPTY
            self.state.event_log.append({
                "tick": self.state.tick,
                "event": "model_eliminated",
                "model": model_name,
            })

    def _apply_scripted_events(self):
        for tick, event_type, data in SCRIPTED_EVENTS:
            if tick != self.state.tick:
                continue

            if event_type == "barbarian":
                self._spawn_barbarian()
            elif event_type == "resource_reveal":
                self._reveal_centre_resources()

    def _spawn_barbarian(self):
        """Spawn a barbarian unit near the current leader."""
        territory = self.state._count_territory()
        if not territory:
            return
        leader = max(territory, key=territory.get)
        leader_model = self.state.models[leader]

        # Spawn 2 tiles from the leader's base
        bx = min(max(leader_model.base_x + random.choice([-3, 3]), 0), GRID_SIZE - 1)
        by = min(max(leader_model.base_y + random.choice([-3, 3]), 0), GRID_SIZE - 1)

        barbarian = Unit(
            id=self._next_id(),
            model_name="Barbarian",
            x=bx, y=by,
            hp=5, attack=2,
            is_barbarian=True,
        )
        self.state.units.append(barbarian)
        self.state.event_log.append({
            "tick": self.state.tick,
            "event": "barbarian_spawn",
            "target": leader,
            "x": bx, "y": by,
        })

    def _reveal_centre_resources(self):
        """Place a high-value ore deposit in the centre of the map."""
        cx, cy = GRID_SIZE // 2, GRID_SIZE // 2
        for dx in range(-1, 2):
            for dy in range(-1, 2):
                x, y = cx + dx, cy + dy
                tile = self.state.grid[y][x]
                if tile.tile_type in (TileType.EMPTY, TileType.ORE, TileType.FOOD):
                    tile.tile_type = TileType.ORE
                    tile.resource_amount = 25
                    tile.owner = None
        self.state.event_log.append({
            "tick": self.state.tick,
            "event": "resource_reveal",
            "x": cx, "y": cy,
            "message": "High-value ore deposit discovered in the centre!",
        })

    def _check_end_conditions(self):
        """Check win conditions: 60% territory, all bases eliminated, or time up."""
        territory = self.state._count_territory()
        total_tiles = GRID_SIZE * GRID_SIZE
        alive_models = [n for n, m in self.state.models.items() if not m.eliminated]

        # Single survivor
        if len(alive_models) == 1:
            self.state.finished = True
            self.state.winner = alive_models[0]
            return

        # 60% territory control
        for model_name, count in territory.items():
            if count >= total_tiles * 0.6:
                self.state.finished = True
                self.state.winner = model_name
                return

        # Time up — highest territory wins
        if self.state.tick >= self.state.max_ticks:
            self.state.finished = True
            if territory:
                self.state.winner = max(territory, key=territory.get)
