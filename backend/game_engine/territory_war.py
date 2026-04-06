"""Territory War — state machine for the Territory War challenge.

20x20 grid map. Each model starts with 1 base + 3 pieces in opposite corners.
Resources (ore, food) scattered across the map. Backend owns all game state.
"""

import logging
import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


log = logging.getLogger(__name__)

# =============================================================================
# Game constants — adjust these to change game balance
# =============================================================================
GRID_SIZE = 30              # Grid dimensions (GRID_SIZE x GRID_SIZE)
PIECES_PER_MODEL = 3        # Starting pieces per model
MAX_PIECES_PER_MODEL = 10   # Maximum pieces a model can have

# Piece stats
PIECE_HP = 3                # Starting and maximum HP per piece
PIECE_ATTACK = 1            # Damage dealt per attack

# Resources
ORE_TILE_COUNT = 30         # Number of ore tiles scattered on the map
FOOD_TILE_COUNT = 15        # Number of food tiles scattered on the map
ORE_PER_TILE_MIN = 5        # Minimum ore per tile
ORE_PER_TILE_MAX = 15       # Maximum ore per tile
FOOD_PER_TILE_MIN = 3       # Minimum food per tile
FOOD_PER_TILE_MAX = 10      # Maximum food per tile
HARVEST_AMOUNT = 3          # Resources collected per harvest action

# Forts
FORT_COST = 10              # Ore required to build a fort
FORT_HP = 5                 # HP of a newly built fort

# Healing
HEAL_COST = 5               # Food required to heal
HEAL_AMOUNT = 1             # HP restored per heal action

# Win conditions
WIN_SCORE_THRESHOLD = 0.6   # Fraction of max possible score to win (0.6 = 60%)

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

# Clockwise order for sequential turns
CLOCKWISE_CORNER_ORDER = [0, 2, 1, 3]  # TL, TR, BR, BL


class TileType(str, Enum):
    EMPTY = "empty"
    ORE = "ore"
    FOOD = "food"
    BASE = "base"
    FORT = "fort"


@dataclass
class Piece:
    id: int
    model_name: str
    x: int
    y: int
    hp: int = PIECE_HP
    attack: int = PIECE_ATTACK

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "model": self.model_name,
            "x": self.x,
            "y": self.y,
            "hp": self.hp,
            "attack": self.attack,
        }


@dataclass
class Tile:
    x: int
    y: int
    tile_type: TileType = TileType.EMPTY
    owner: str | None = None       # model_name that controls this tile
    resource_amount: int = 0       # remaining resource yield
    fort_hp: int = 0               # fort hit points (0 = no fort)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"x": self.x, "y": self.y, "type": self.tile_type.value}
        if self.owner:
            d["owner"] = self.owner
        if self.resource_amount > 0:
            d["resources"] = self.resource_amount
        if self.fort_hp > 0:
            d["fort_hp"] = self.fort_hp
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
    (42, "resource_reveal", {}),  # T+14min: high-value deposit in centre
]


@dataclass
class TerritoryWarState:
    tick: int = 0
    max_ticks: int = 100
    grid: list[list[Tile]] = field(default_factory=list)
    pieces: list[Piece] = field(default_factory=list)
    models: dict[str, ModelState] = field(default_factory=dict)
    event_log: list[dict[str, Any]] = field(default_factory=list)
    finished: bool = False
    winner: str | None = None
    _next_piece_id: int = 0

    def to_dict(self) -> dict[str, Any]:
        alive_models = {n: m for n, m in self.models.items() if not m.eliminated}
        territory = self._count_territory()
        territory_score = self._count_territory_score()
        total_tiles = GRID_SIZE * GRID_SIZE
        win_score = int(total_tiles * WIN_SCORE_THRESHOLD)
        return {
            "tick": self.tick,
            "max_ticks": self.max_ticks,
            "grid_size": GRID_SIZE,
            "total_tiles": total_tiles,
            "win_score": win_score,
            "grid": [[tile.to_dict() for tile in row] for row in self.grid],
            "units": [p.to_dict() for p in self.pieces if p.hp > 0],
            "models": {n: m.to_dict() for n, m in self.models.items()},
            "territory": territory,
            "territory_score": territory_score,
            "event_log": self.event_log[-10:],
            "finished": self.finished,
            "winner": self.winner,
            "config": {
                "piece_hp": PIECE_HP,
                "piece_attack": PIECE_ATTACK,
                "pieces_per_model": PIECES_PER_MODEL,
                "fort_cost": FORT_COST,
                "fort_hp": FORT_HP,
                "heal_cost": HEAL_COST,
                "heal_amount": HEAL_AMOUNT,
                "harvest_amount": HARVEST_AMOUNT,
            },
        }

    def _count_territory(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for row in self.grid:
            for tile in row:
                if tile.owner:
                    counts[tile.owner] = counts.get(tile.owner, 0) + 1
        return counts

    def _count_territory_score(self) -> dict[str, int]:
        """Count territory score: each tile = 1, fort-protected tiles = 2."""
        scores: dict[str, int] = {}
        for row in self.grid:
            for tile in row:
                if tile.owner:
                    points = 1
                    # Check if this tile is protected by a fort of the same owner
                    if self._is_tile_fort_protected(tile.x, tile.y, tile.owner):
                        points = 2
                    scores[tile.owner] = scores.get(tile.owner, 0) + points
        return scores

    def _is_tile_fort_protected(self, x: int, y: int, owner: str) -> bool:
        """Check if a tile is within range of a fort owned by the same model."""
        for dy in range(-1, 2):
            for dx in range(-1, 2):
                if dx == 0 and dy == 0:
                    continue
                fx, fy = x + dx, y + dy
                if 0 <= fx < GRID_SIZE and 0 <= fy < GRID_SIZE:
                    fort_tile = self.grid[fy][fx]
                    if fort_tile.tile_type == TileType.FORT and fort_tile.owner == owner and fort_tile.fort_hp > 0:
                        return True
        return False


class TerritoryWarEngine:
    """Runs the Territory War challenge."""

    def __init__(self, model_names: list[str]):
        if len(model_names) > len(SPAWN_CORNERS):
            raise ValueError(f"Max {len(SPAWN_CORNERS)} models supported")

        self.model_names = model_names
        self.state = TerritoryWarState()
        self._corners: dict[str, int] = {}  # model_name -> corner index
        self._init_grid()
        self._scatter_resources(ore_count=ORE_TILE_COUNT, food_count=FOOD_TILE_COUNT)

        for i, name in enumerate(model_names):
            self._corners[name] = i
            cx, cy = SPAWN_CORNERS[i]
            self._init_model(name, cx, cy)

    def get_clockwise_order(self) -> list[str]:
        """Return model names in clockwise corner order for sequential turns."""
        ordered = []
        for corner_idx in CLOCKWISE_CORNER_ORDER:
            for name, idx in self._corners.items():
                if idx == corner_idx and not self.state.models[name].eliminated:
                    ordered.append(name)
        return ordered

    def reassign_corners(self, model_order: list[str]):
        """Reassign corner indices based on a given order."""
        for i, name in enumerate(model_order):
            if name in self._corners:
                self._corners[name] = i

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
            self.state.grid[y][x].resource_amount = random.randint(ORE_PER_TILE_MIN, ORE_PER_TILE_MAX)

        for i in range(ore_count, min(ore_count + food_count, len(available))):
            x, y = available[i]
            self.state.grid[y][x].tile_type = TileType.FOOD
            self.state.grid[y][x].resource_amount = random.randint(FOOD_PER_TILE_MIN, FOOD_PER_TILE_MAX)

    def _init_model(self, name: str, base_x: int, base_y: int):
        """Set up a model's base and starting pieces."""
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

        # Spawn 3 starting pieces toward centre
        cx, cy = GRID_SIZE // 2, GRID_SIZE // 2
        dx_dir = 1 if cx > base_x else -1
        dy_dir = 1 if cy > base_y else -1
        offsets = [(dx_dir, 0), (0, dy_dir), (dx_dir, dy_dir)]
        for odx, ody in offsets:
            ux, uy = base_x + odx, base_y + ody
            if 0 <= ux < GRID_SIZE and 0 <= uy < GRID_SIZE:
                piece = Piece(
                    id=self._next_id(),
                    model_name=name,
                    x=ux, y=uy,
                )
                self.state.pieces.append(piece)

    def _next_id(self) -> int:
        self.state._next_piece_id += 1
        return self.state._next_piece_id

    def get_prompt_state(self) -> dict[str, Any]:
        """State to send to models. Full map visibility — no fog of war."""
        return self.state.to_dict()

    def apply_actions(self, actions: dict[str, list[dict[str, Any]]], advance_tick: bool = True):
        """Apply actions from models.

        actions: {model_name: [{"unit_id": ..., "action": ..., ...}, ...]}
        advance_tick: if True, increment the round counter and check win conditions.
                      Set to False when applying individual model actions in sequential mode.
        """
        for model_name, piece_actions in actions.items():
            model = self.state.models.get(model_name)
            if not model or model.eliminated:
                continue
            for action in piece_actions[:3]:
                self._execute_action(model_name, action)

        # Update territory (pieces claim tiles they stand on)
        self._update_territory()

        # Remove dead pieces
        self.state.pieces = [p for p in self.state.pieces if p.hp > 0]

        if advance_tick:
            # Apply scripted events and advance the round
            self._apply_scripted_events()
            self.state.tick += 1
            self._check_end_conditions()

    def _execute_action(self, model_name: str, action: dict[str, Any]):
        """Execute a single piece action."""
        unit_id = action.get("unit_id")
        action_type = action.get("action")

        piece = self._get_piece(unit_id, model_name)
        if not piece:
            return

        if action_type == "move":
            self._action_move(piece, action.get("direction", ""))
        elif action_type == "attack":
            self._action_attack(piece, action)
        elif action_type == "harvest":
            self._action_harvest(piece, model_name)
        elif action_type == "build":
            self._action_build(piece, model_name)
        elif action_type == "heal":
            self._action_heal(piece, model_name)

    def _get_piece(self, unit_id: int | None, model_name: str) -> Piece | None:
        """Find a piece owned by the given model."""
        if unit_id is None:
            return None
        for p in self.state.pieces:
            if p.id == unit_id and p.model_name == model_name and p.hp > 0:
                return p
        return None

    def _action_move(self, piece: Piece, direction: str):
        dx, dy = DIRECTIONS.get(direction, (0, 0))
        nx, ny = piece.x + dx, piece.y + dy
        if 0 <= nx < GRID_SIZE and 0 <= ny < GRID_SIZE:
            piece.x = nx
            piece.y = ny
        else:
            self.state.event_log.append({
                "tick": self.state.tick,
                "event": "move_blocked",
                "piece_id": piece.id,
                "model": piece.model_name,
                "direction": direction,
            })

    def _action_attack(self, piece: Piece, action: dict[str, Any]):
        target_id = action.get("target_id")
        target_x = action.get("target_x")
        target_y = action.get("target_y")

        # Attack a fort by coordinates
        if target_x is not None and target_y is not None:
            if 0 <= target_x < GRID_SIZE and 0 <= target_y < GRID_SIZE:
                if abs(target_x - piece.x) <= 1 and abs(target_y - piece.y) <= 1:
                    tile = self.state.grid[target_y][target_x]
                    if tile.tile_type == TileType.FORT and tile.owner != piece.model_name:
                        tile.fort_hp -= piece.attack
                        self.state.event_log.append({
                            "tick": self.state.tick,
                            "event": "fort_attacked",
                            "attacker": piece.model_name,
                            "x": target_x, "y": target_y,
                            "remaining_hp": tile.fort_hp,
                        })
                        if tile.fort_hp <= 0:
                            tile.tile_type = TileType.EMPTY
                            tile.fort_hp = 0
                            self.state.event_log.append({
                                "tick": self.state.tick,
                                "event": "fort_destroyed",
                                "attacker": piece.model_name,
                                "owner": tile.owner,
                                "x": target_x, "y": target_y,
                            })
                            tile.owner = None
            return

        # Attack a piece by ID
        if target_id is None:
            return
        for target in self.state.pieces:
            if target.id == target_id and target.hp > 0:
                # Must be adjacent
                if abs(target.x - piece.x) <= 1 and abs(target.y - piece.y) <= 1:
                    target.hp -= piece.attack
                    self.state.event_log.append({
                        "tick": self.state.tick,
                        "event": "piece_attacked",
                        "attacker": piece.model_name,
                        "target": target.model_name,
                        "target_id": target.id,
                        "remaining_hp": target.hp,
                    })
                    if target.hp <= 0:
                        self.state.event_log.append({
                            "tick": self.state.tick,
                            "event": "piece_killed",
                            "attacker": piece.model_name,
                            "target": target.model_name,
                            "target_id": target.id,
                        })
                        # Check if target model is eliminated
                        self._check_elimination(target.model_name)
                break

    def _action_harvest(self, piece: Piece, model_name: str):
        tile = self.state.grid[piece.y][piece.x]
        if tile.resource_amount <= 0:
            return
        model = self.state.models[model_name]
        harvest = min(tile.resource_amount, HARVEST_AMOUNT)
        if tile.tile_type == TileType.ORE:
            model.ore += harvest
        elif tile.tile_type == TileType.FOOD:
            model.food += harvest
        tile.resource_amount -= harvest
        if tile.resource_amount <= 0:
            tile.tile_type = TileType.EMPTY

    def _action_build(self, piece: Piece, model_name: str):
        model = self.state.models[model_name]
        tile = self.state.grid[piece.y][piece.x]

        if model.ore < FORT_COST:
            self.state.event_log.append({
                "tick": self.state.tick,
                "event": "build_failed",
                "model": model_name,
                "reason": "not enough ore",
                "x": piece.x, "y": piece.y,
            })
            return

        if tile.tile_type != TileType.EMPTY:
            self.state.event_log.append({
                "tick": self.state.tick,
                "event": "build_failed",
                "model": model_name,
                "reason": f"tile is {tile.tile_type.value}, must be empty",
                "x": piece.x, "y": piece.y,
            })
            return

        model.ore -= FORT_COST
        tile.tile_type = TileType.FORT
        tile.owner = model_name
        tile.fort_hp = FORT_HP
        # Fort claims all 8 neighbouring tiles (even unclaimed ones)
        for dx in range(-1, 2):
            for dy in range(-1, 2):
                nx, ny = piece.x + dx, piece.y + dy
                if 0 <= nx < GRID_SIZE and 0 <= ny < GRID_SIZE:
                    neighbour = self.state.grid[ny][nx]
                    if neighbour.tile_type not in (TileType.BASE, TileType.FORT):
                        neighbour.owner = model_name
        self.state.event_log.append({
            "tick": self.state.tick,
            "event": "fort_built",
            "model": model_name,
            "x": piece.x, "y": piece.y,
        })

    def _action_heal(self, piece: Piece, model_name: str):
        model = self.state.models[model_name]
        if model.food < HEAL_COST:
            return
        if piece.hp >= PIECE_HP:
            return
        model.food -= HEAL_COST
        piece.hp = min(piece.hp + HEAL_AMOUNT, PIECE_HP)

    def _is_fort_protected(self, x: int, y: int, exclude_owner: str) -> bool:
        """Check if a tile is near an enemy fort (protected from claiming)."""
        for dy in range(-1, 2):
            for dx in range(-1, 2):
                fx, fy = x + dx, y + dy
                if 0 <= fx < GRID_SIZE and 0 <= fy < GRID_SIZE:
                    fort_tile = self.state.grid[fy][fx]
                    if (fort_tile.tile_type == TileType.FORT
                            and fort_tile.owner != exclude_owner
                            and fort_tile.fort_hp > 0):
                        return True
        return False

    def _update_territory(self):
        """Pieces claim the tile they stand on for their model."""
        for piece in self.state.pieces:
            if piece.hp > 0:
                tile = self.state.grid[piece.y][piece.x]
                if tile.tile_type not in (TileType.BASE,):
                    # Cannot claim tiles protected by enemy forts
                    if not self._is_fort_protected(piece.x, piece.y, piece.model_name):
                        tile.owner = piece.model_name

    def _check_elimination(self, model_name: str):
        """Check if a model has been eliminated (no pieces left)."""
        model = self.state.models[model_name]
        alive = any(
            p for p in self.state.pieces
            if p.model_name == model_name and p.hp > 0
        )
        if not alive:
            model.eliminated = True
            # Clear base
            base_tile = self.state.grid[model.base_y][model.base_x]
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

            if event_type == "resource_reveal":
                self._reveal_centre_resources()

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
        """Check win conditions: territory score threshold, all eliminated, or time up."""
        territory_score = self.state._count_territory_score()
        total_tiles = GRID_SIZE * GRID_SIZE
        win_score = int(total_tiles * WIN_SCORE_THRESHOLD)
        alive_models = [n for n, m in self.state.models.items() if not m.eliminated]

        # Single survivor
        if len(alive_models) == 1:
            self.state.finished = True
            self.state.winner = alive_models[0]
            return

        # Territory score threshold
        for model_name, score in territory_score.items():
            if score >= win_score:
                self.state.finished = True
                self.state.winner = model_name
                return

        # Time up — highest territory score wins
        if self.state.tick >= self.state.max_ticks:
            self.state.finished = True
            if territory_score:
                self.state.winner = max(territory_score, key=territory_score.get)
