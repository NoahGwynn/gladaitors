"""SQLite episode/tick storage.

Every tick is stored so episodes can be replayed from stored state
without re-running model calls.
"""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).parent / "gladaitors.db"


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create tables if they don't exist."""
    conn = get_connection()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS episodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            challenge TEXT NOT NULL,
            models TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            winner TEXT,
            config TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ticks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            episode_id INTEGER NOT NULL,
            tick_number INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            game_state TEXT NOT NULL,
            model_responses TEXT NOT NULL,
            events TEXT,
            FOREIGN KEY (episode_id) REFERENCES episodes(id)
        );

        CREATE INDEX IF NOT EXISTS idx_ticks_episode
            ON ticks(episode_id, tick_number);
    """)
    conn.close()


def create_episode(
    challenge: str,
    models: list[str],
    config: dict[str, Any],
) -> int:
    """Create a new episode and return its ID."""
    conn = get_connection()
    cursor = conn.execute(
        "INSERT INTO episodes (challenge, models, started_at, config) VALUES (?, ?, ?, ?)",
        (
            challenge,
            json.dumps(models),
            datetime.now(timezone.utc).isoformat(),
            json.dumps(config),
        ),
    )
    episode_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return episode_id


def end_episode(episode_id: int, winner: str | None = None):
    """Mark an episode as finished."""
    conn = get_connection()
    conn.execute(
        "UPDATE episodes SET ended_at = ?, winner = ? WHERE id = ?",
        (datetime.now(timezone.utc).isoformat(), winner, episode_id),
    )
    conn.commit()
    conn.close()


def store_tick(
    episode_id: int,
    tick_number: int,
    game_state: dict[str, Any],
    model_responses: list[dict[str, Any]],
    events: list[str] | None = None,
):
    """Store a single tick for replay."""
    conn = get_connection()
    conn.execute(
        "INSERT INTO ticks (episode_id, tick_number, timestamp, game_state, model_responses, events) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            episode_id,
            tick_number,
            datetime.now(timezone.utc).isoformat(),
            json.dumps(game_state),
            json.dumps(model_responses),
            json.dumps(events) if events else None,
        ),
    )
    conn.commit()
    conn.close()


def get_episode_ticks(episode_id: int) -> list[dict[str, Any]]:
    """Retrieve all ticks for an episode (for replay)."""
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM ticks WHERE episode_id = ? ORDER BY tick_number",
        (episode_id,),
    ).fetchall()
    conn.close()
    return [
        {
            "tick_number": row["tick_number"],
            "timestamp": row["timestamp"],
            "game_state": json.loads(row["game_state"]),
            "model_responses": json.loads(row["model_responses"]),
            "events": json.loads(row["events"]) if row["events"] else None,
        }
        for row in rows
    ]


def get_episode(episode_id: int) -> dict[str, Any] | None:
    """Retrieve episode metadata."""
    conn = get_connection()
    row = conn.execute("SELECT * FROM episodes WHERE id = ?", (episode_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row["id"],
        "challenge": row["challenge"],
        "models": json.loads(row["models"]),
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "winner": row["winner"],
        "config": json.loads(row["config"]),
    }
