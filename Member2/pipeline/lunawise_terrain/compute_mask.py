"""Generate a geodesic horizon mask from near- and far-field lunar DEMs."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import numpy as np

from .io import update_site_index, validate_site_id, write_json
from .terrain import (
    DEFAULT_AZIMUTH_STEP_DEG,
    DEFAULT_MAX_DISTANCE_M,
    DEFAULT_MAST_HEIGHTS_M,
    FarFieldDem,
    NearFieldDem,
    compute_horizon_profiles,
)


def _json_values(values: np.ndarray) -> list[float | None]:
    return [float(value) if np.isfinite(value) else None for value in values]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-id", required=True, type=validate_site_id)
    parser.add_argument("--lat", required=True, type=float, help="Verified site latitude")
    parser.add_argument("--lon", required=True, type=float, help="Verified east-positive longitude")
    parser.add_argument("--near", required=True, type=Path, help="Near-field GeoTIFF")
    parser.add_argument("--far", required=True, type=Path, help="Far-field PDS IMG file")
    parser.add_argument("--out", type=Path, default=Path("data_out"))
    parser.add_argument("--max-distance-km", type=float, default=200.0)
    parser.add_argument("--azimuth-step-deg", type=float, default=DEFAULT_AZIMUTH_STEP_DEG)
    parser.add_argument("--mast-heights-m", type=float, nargs="+", default=DEFAULT_MAST_HEIGHTS_M)
    parser.add_argument(
        "--allow-incomplete",
        action="store_true",
        help="Write diagnostic profiles even when some azimuths lack full DEM coverage",
    )
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    near_path = args.near.resolve()
    far_path = args.far.resolve()
    with NearFieldDem(near_path) as near_dem, FarFieldDem(far_path) as far_dem:
        result = compute_horizon_profiles(
            near_dem,
            far_dem,
            args.lat,
            args.lon,
            mast_heights_m=tuple(args.mast_heights_m),
            max_distance_m=args.max_distance_km * 1000.0,
            azimuth_step_deg=args.azimuth_step_deg,
        )

    incomplete = np.flatnonzero(~result["complete"])
    if incomplete.size and not args.allow_incomplete:
        sample = ", ".join(str(int(result["azimuth_deg"][i])) for i in incomplete[:12])
        raise ValueError(
            f"DEM coverage ends before {args.max_distance_km:g} km for "
            f"{incomplete.size} azimuth bins (first: {sample} degrees). "
            "Use --allow-incomplete only for diagnostic output."
        )

    mast_profiles = {
        height: _json_values(values)
        for height, values in result["horizon_deg"].items()
    }
    default_key = "2" if "2" in mast_profiles else next(iter(mast_profiles))
    payload = {
        "site_id": args.site_id,
        "azimuth_step_deg": result["azimuth_step_deg"],
        "azimuth_convention": "clockwise_from_north",
        "mast_heights_m": [float(value) for value in args.mast_heights_m],
        "default_mast_height_m": float(default_key),
        "horizon_deg": mast_profiles,
        "elev_deg": mast_profiles.get(default_key),
        "coverage_distance_m": _json_values(result["coverage_distance_m"]),
        "complete_coverage": bool(np.all(result["complete"])),
        "requested_max_distance_m": result["max_distance_m"],
        "ground_elevation_m": result["ground_elevation_m"],
        "sources": {
            "near_dem": str(near_path),
            "far_dem": str(far_path),
        },
    }

    out_dir = args.out.resolve()
    write_json(out_dir / "mask" / f"{args.site_id}.json", payload)
    update_site_index(
        out_dir,
        site_id=args.site_id,
        latitude_deg=args.lat,
        longitude_deg=args.lon,
        ground_elevation_m=result["ground_elevation_m"],
        near_dem=near_path,
    )
    return payload


def main() -> None:
    args = build_parser().parse_args()
    run(args)


if __name__ == "__main__":
    main()
