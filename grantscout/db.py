from __future__ import annotations

import sqlite3
from typing import Any


class GrantScoutDB:
    def __init__(self, path: str):
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path)
        con.row_factory = sqlite3.Row
        return con

    def init(self) -> None:
        with self._connect() as con:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  created_at TEXT NOT NULL,
                  profile_json TEXT NOT NULL,
                  report_json TEXT NOT NULL
                )
                """
            )

    def create_run(self, created_at: str, profile_json: str, report_json: str) -> int:
        with self._connect() as con:
            cur = con.execute(
                "INSERT INTO runs(created_at, profile_json, report_json) VALUES (?, ?, ?)",
                (created_at, profile_json, report_json),
            )
            return int(cur.lastrowid)

    def list_runs(self, limit: int = 25) -> list[dict[str, Any]]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT id, created_at FROM runs ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_run(self, run_id: int) -> dict[str, Any]:
        with self._connect() as con:
            row = con.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                raise KeyError(f"run {run_id} not found")
            return dict(row)

