"""Export curvature-corrected Float32 near/far terrain grids for the browser."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import numpy as np
from pyproj import Geod

from .io import update_site_index, validate_site_id, write_json
from .terrain import MOON_RADIUS_M, FarFieldDem, NearFieldDem


def _sample_combined(
    near_dem: NearFieldDem,
    far_dem: FarFieldDem,
    x_m: np.ndarray,
    y_m: np.ndarray,
) -> np.ndarray:
    values = near_dem.sample_xy(x_m, y_m)
    missing = ~np.isfinite(values)
    if np.any(missing):
        values[missing] = far_dem.sample_xy(x_m[missing], y_m[missing])
    return values


def export_grid(
    near_dem: NearFieldDem,
    far_dem: FarFieldDem,
    latitude_deg: float,
    longitude_deg: float,
    ground_elevation_m: float,
    *,
    nx: int,
    ny: int,
    cell_m: float,
) -> tuple[np.ndarray, float]:
    if nx <= 0 or ny <= 0 or cell_m <= 0:
        raise ValueError("grid dimensions and cell size must be positive")

    east_m = (np.arange(nx, dtype=np.float64) + 0.5 - nx / 2.0) * cell_m
    north_m = (ny / 2.0 - np.arange(ny, dtype=np.float64) - 0.5) * cell_m
    east, north = np.meshgrid(east_m, north_m)
    distances = np.hypot(east, north)
    azimuths = np.rad2deg(np.arctan2(east, north))
    geod = Geod(a=MOON_RADIUS_M, b=MOON_RADIUS_M)
    longitudes, latitudes, _ = geod.fwd(
        np.full(distances.shape, longitude_deg),
        np.full(distances.shape, latitude_deg),
        azimuths,
        distances,
    )
    x_m, y_m = near_dem.projector(longitudes, latitudes)
    elevations = _sample_combined(near_dem, far_dem, x_m, y_m)
    sagitta_m = MOON_RADIUS_M * (1.0 - np.cos(distances / MOON_RADIUS_M))
    relative_heights = elevations - ground_elevation_m - sagitta_m
    valid_fraction = float(np.count_nonzero(np.isfinite(relative_heights)) / relative_heights.size)
    return np.asarray(relative_heights, dtype="<f4"), valid_fraction


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-id", required=True, type=validate_site_id)
    parser.add_argument("--lat", required=True, type=float, help="Verified site latitude")
    parser.add_argument("--lon", required=True, type=float, help="Verified east-positive longitude")
    parser.add_argument("--near", required=True, type=Path, help="Near-field GeoTIFF")
    parser.add_argument("--far", required=True, type=Path, help="Far-field PDS IMG file")
    parser.add_argument("--out", type=Path, default=Path("data_out"))
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--near-cell-m", type=float, default=10.0)
    parser.add_argument("--far-cell-m", type=float, default=120.0)
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    near_path = args.near.resolve()
    far_path = args.far.resolve()
    out_dir = args.out.resolve()
    with NearFieldDem(near_path) as near_dem, FarFieldDem(far_path) as far_dem:
        ground_elevation_m = near_dem.site_elevation(args.lat, args.lon)
        grids: dict[str, dict[str, Any]] = {}
        for field, cell_m in (
            ("near", args.near_cell_m),
            ("far", args.far_cell_m),
        ):
            data, valid_fraction = export_grid(
                near_dem,
                far_dem,
                args.lat,
                args.lon,
                ground_elevation_m,
                nx=args.size,
                ny=args.size,
                cell_m=cell_m,
            )
            filename = f"{args.site_id}_{field}.bin"
            destination = out_dir / "heightmap" / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            data.tofile(destination)
            grids[field] = {
                "file": filename,
                "nx": args.size,
                "ny": args.size,
                "cellM": cell_m,
                "sizeM": args.size * cell_m,
                "maxDist": args.size * cell_m / 2.0,
                "dataType": "float32le",
                "axisX": "east",
                "axisY": "north",
                "rowOrder": "north_to_south",
                "validFraction": valid_fraction,
            }

    metadata = {
        "site_id": args.site_id,
        "groundHeightM": ground_elevation_m,
        "heightReference": "relative_to_site_ground_with_spherical_curvature_removed",
        "near": grids["near"],
        "far": grids["far"],
        "sources": {
            "near_dem": str(near_path),
            "far_dem": str(far_path),
        },
    }
    write_json(out_dir / "heightmap" / f"{args.site_id}.json", metadata)
    update_site_index(
        out_dir,
        site_id=args.site_id,
        latitude_deg=args.lat,
        longitude_deg=args.lon,
        ground_elevation_m=ground_elevation_m,
        near_dem=near_path,
    )
    return metadata


def main() -> None:
    args = build_parser().parse_args()
    run(args)


if __name__ == "__main__":
    main()
