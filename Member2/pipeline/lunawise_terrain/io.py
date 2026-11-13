"""Output helpers shared by the Member 2 command-line tools."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def validate_site_id(site_id: str) -> str:
    if not re.fullmatch(r"[a-z0-9_-]+", site_id):
        raise ValueError("site-id must contain only lowercase letters, digits, '_' or '-'")
    return site_id


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def update_site_index(
    out_dir: Path,
    *,
    site_id: str,
    latitude_deg: float,
    longitude_deg: float,
    ground_elevation_m: float,
    near_dem: Path,
    observer_height_m: float = 2.0,
) -> None:
    path = out_dir / "sites.json"
    sites: list[dict[str, Any]] = []
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(existing, list):
            raise ValueError(f"Expected a JSON array in {path}")
        sites = existing

    record = {
        "id": site_id,
        "name": site_id.replace("_", " ").replace("-", " ").title(),
        "lat": latitude_deg,
        "lon": longitude_deg,
        "ground_height_m": ground_elevation_m,
        "obs_height_m": observer_height_m,
        "dem": str(near_dem),
    }
    sites = [entry for entry in sites if entry.get("id") != site_id]
    sites.append(record)
    sites.sort(key=lambda entry: entry["id"])
    write_json(path, sites)
