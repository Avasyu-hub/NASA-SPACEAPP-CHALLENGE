"""DEM readers and spherical terrain-horizon calculations."""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from pyproj import Geod, Proj

MOON_RADIUS_M = 1_737_400.0
DEFAULT_MAST_HEIGHTS_M = (2.0, 5.0, 10.0)
DEFAULT_MAX_DISTANCE_M = 200_000.0
DEFAULT_AZIMUTH_STEP_DEG = 1.0


def _as_float_array(value: Any) -> np.ndarray:
    return np.asarray(value, dtype=np.float64)


class NearFieldDem:
    """Bilinear sampler for a projected, meter-valued GeoTIFF DEM."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._dataset = rasterio.open(self.path)
        if self._dataset.crs is None:
            self._dataset.close()
            raise ValueError(f"DEM has no coordinate reference system: {self.path}")

        self.projector = Proj(self._dataset.crs)
        masked = self._dataset.read(1, masked=True)
        self._values = np.asarray(masked.filled(np.nan), dtype=np.float64)
        self._transform_inverse = ~self._dataset.transform
        self.resolution_m = min(abs(self._dataset.res[0]), abs(self._dataset.res[1]))
        if not math.isfinite(self.resolution_m) or self.resolution_m <= 0:
            self.close()
            raise ValueError(f"DEM has an invalid pixel size: {self.path}")

    def close(self) -> None:
        if self._dataset is not None:
            self._dataset.close()
            self._dataset = None

    def __enter__(self) -> NearFieldDem:
        return self

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        self.close()

    def sample_xy(self, x_m: Any, y_m: Any) -> np.ndarray:
        """Return bilinear elevations in metres; out-of-bounds samples are NaN."""
        x_values, y_values = np.broadcast_arrays(_as_float_array(x_m), _as_float_array(y_m))
        inverse = self._transform_inverse
        col_corner = inverse.a * x_values + inverse.b * y_values + inverse.c
        row_corner = inverse.d * x_values + inverse.e * y_values + inverse.f
        col = np.asarray(col_corner, dtype=np.float64) - 0.5
        row = np.asarray(row_corner, dtype=np.float64) - 0.5

        rows, cols = self._values.shape
        finite = np.isfinite(row) & np.isfinite(col)
        inside = (
            finite
            & (row >= -0.5)
            & (row <= rows - 0.5)
            & (col >= -0.5)
            & (col <= cols - 0.5)
        )
        row = np.where(finite, row, 0.0)
        col = np.where(finite, col, 0.0)
        row = np.clip(row, 0, rows - 1)
        col = np.clip(col, 0, cols - 1)
        row0 = np.floor(row).astype(np.int64)
        col0 = np.floor(col).astype(np.int64)
        row1 = np.minimum(row0 + 1, rows - 1)
        col1 = np.minimum(col0 + 1, cols - 1)
        row_weight = row - row0
        col_weight = col - col0

        samples = (
            self._values[row0, col0],
            self._values[row0, col1],
            self._values[row1, col0],
            self._values[row1, col1],
        )
        weights = (
            (1 - row_weight) * (1 - col_weight),
            (1 - row_weight) * col_weight,
            row_weight * (1 - col_weight),
            row_weight * col_weight,
        )
        weighted_sum = np.zeros(x_values.shape, dtype=np.float64)
        total_weight = np.zeros(x_values.shape, dtype=np.float64)
        for sample, weight in zip(samples, weights):
            valid = np.isfinite(sample)
            weighted_sum += np.where(valid, sample * weight, 0.0)
            total_weight += np.where(valid, weight, 0.0)

        result = np.full(x_values.shape, np.nan, dtype=np.float64)
        valid = inside & (total_weight > 0)
        result[valid] = weighted_sum[valid] / total_weight[valid]
        return result

    def site_xy(self, latitude_deg: float, longitude_deg: float) -> tuple[float, float]:
        x_m, y_m = self.projector(longitude_deg, latitude_deg)
        return float(x_m), float(y_m)

    def site_elevation(self, latitude_deg: float, longitude_deg: float) -> float:
        x_m, y_m = self.site_xy(latitude_deg, longitude_deg)
        elevation = float(self.sample_xy(x_m, y_m))
        if not math.isfinite(elevation):
            raise ValueError(
                f"Site coordinate ({latitude_deg}, {longitude_deg}) is outside "
                f"valid near-field DEM pixels in {self.path}"
            )
        return elevation


class FarFieldDem:
    """Memory-mapped reader for the raw PDS3 LDEM float raster."""

    _KEY_VALUE = re.compile(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$")

    def __init__(self, image_path: str | Path, label_path: str | Path | None = None):
        self.path = Path(image_path)
        self.label_path = Path(label_path) if label_path else self.path.with_suffix(".LBL")
        if not self.label_path.is_file():
            raise FileNotFoundError(f"PDS label not found: {self.label_path}")

        self.label = self._read_label(self.label_path)
        self.height = self._required_int("LINES")
        self.width = self._required_int("LINE_SAMPLES")
        self.map_scale_m = self._required_float("MAP_SCALE")
        self.sample_offset = self._required_float("SAMPLE_PROJECTION_OFFSET")
        self.line_offset = self._required_float("LINE_PROJECTION_OFFSET")
        self.radius_m = self._required_float("A_AXIS_RADIUS") * 1000.0
        self.scale = self._required_float("SCALING_FACTOR")

        sample_type = self.label.get("SAMPLE_TYPE", "").upper()
        sample_bits = self._required_int("SAMPLE_BITS")
        if sample_type != "PC_REAL" or sample_bits != 32:
            raise ValueError(
                f"Expected a PDS PC_REAL 32-bit image, got {sample_type} {sample_bits}"
            )
        unit = self.label.get("UNIT", "").strip().upper()
        if unit not in {"KILOMETER", "KILOMETERS", "KM"}:
            raise ValueError(f"Unsupported PDS elevation unit: {unit}")
        self.unit_to_m = 1000.0

        expected_bytes = self.width * self.height * 4
        actual_bytes = self.path.stat().st_size
        if actual_bytes != expected_bytes:
            raise ValueError(
                f"PDS image size mismatch for {self.path}: "
                f"expected {expected_bytes} bytes, found {actual_bytes}"
            )

        self._values = np.memmap(
            self.path,
            dtype="<f4",
            mode="r",
            shape=(self.height, self.width),
        )
        self.projector = Proj(
            proj="stere",
            lat_0=-90,
            lat_ts=-90,
            lon_0=self._required_float("CENTER_LONGITUDE"),
            R=self.radius_m,
            units="m",
            no_defs=True,
        )

    @classmethod
    def _read_label(cls, path: Path) -> dict[str, str]:
        values: dict[str, str] = {}
        for line in path.read_text(encoding="ascii", errors="replace").splitlines():
            match = cls._KEY_VALUE.match(line)
            if not match:
                continue
            key, raw_value = match.groups()
            value = raw_value.split("/*", 1)[0].strip()
            values[key] = value.strip('"').strip("'")
        return values

    def _required_int(self, key: str) -> int:
        try:
            return int(self.label[key].split("<", 1)[0].strip())
        except (KeyError, ValueError) as exc:
            raise ValueError(f"Missing or invalid PDS label value: {key}") from exc

    def _required_float(self, key: str) -> float:
        try:
            return float(self.label[key].split("<", 1)[0].strip())
        except (KeyError, ValueError) as exc:
            raise ValueError(f"Missing or invalid PDS label value: {key}") from exc

    def sample_xy(self, x_m: Any, y_m: Any) -> np.ndarray:
        """Return nearest-cell topography in metres relative to the PDS radius."""
        x_values, y_values = np.broadcast_arrays(_as_float_array(x_m), _as_float_array(y_m))
        finite = np.isfinite(x_values) & np.isfinite(y_values)
        safe_x = np.where(finite, x_values, 0.0)
        safe_y = np.where(finite, y_values, 0.0)
        cols = np.rint(safe_x / self.map_scale_m + self.sample_offset).astype(np.int64)
        rows = np.rint(self.line_offset - safe_y / self.map_scale_m).astype(np.int64)
        valid = (
            finite
            & (rows >= 0)
            & (rows < self.height)
            & (cols >= 0)
            & (cols < self.width)
        )
        result = np.full(x_values.shape, np.nan, dtype=np.float64)
        if np.any(valid):
            raw = np.asarray(self._values[rows[valid], cols[valid]], dtype=np.float64)
            raw[~np.isfinite(raw)] = np.nan
            result[valid] = raw * self.scale * self.unit_to_m
        return result

    def close(self) -> None:
        mmap = getattr(self._values, "_mmap", None)
        if mmap is not None:
            mmap.close()

    def __enter__(self) -> FarFieldDem:
        return self

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        self.close()


def distance_samples(
    max_distance_m: float,
    initial_step_m: float,
    fractional_step: float = 0.005,
) -> np.ndarray:
    """Build outward samples with DEM-scale near steps and growing far steps."""
    if not math.isfinite(max_distance_m) or max_distance_m <= 0:
        raise ValueError("max_distance_m must be positive and finite")
    if not math.isfinite(initial_step_m) or initial_step_m <= 0:
        raise ValueError("initial_step_m must be positive and finite")
    if not math.isfinite(fractional_step) or fractional_step <= 0:
        raise ValueError("fractional_step must be positive and finite")

    samples = [min(initial_step_m, max_distance_m)]
    while samples[-1] < max_distance_m:
        next_distance = samples[-1] + max(initial_step_m, samples[-1] * fractional_step)
        samples.append(min(next_distance, max_distance_m))
    return np.asarray(samples, dtype=np.float64)


def terrain_elevation_angle(
    site_latitude_deg: float,
    site_longitude_deg: float,
    site_elevation_m: float,
    mast_height_m: float,
    sample_latitude_deg: Any,
    sample_longitude_deg: Any,
    sample_elevation_m: Any,
    moon_radius_m: float = MOON_RADIUS_M,
) -> np.ndarray:
    """Compute apparent elevation from the lander to sampled terrain in 3-D."""
    sample_lat = np.deg2rad(_as_float_array(sample_latitude_deg))
    sample_lon = np.deg2rad(_as_float_array(sample_longitude_deg))
    sample_height = _as_float_array(sample_elevation_m)
    sample_lat, sample_lon, sample_height = np.broadcast_arrays(
        sample_lat, sample_lon, sample_height
    )

    site_lat = math.radians(site_latitude_deg)
    site_lon = math.radians(site_longitude_deg)
    site_up = np.array(
        [
            math.cos(site_lat) * math.cos(site_lon),
            math.cos(site_lat) * math.sin(site_lon),
            math.sin(site_lat),
        ],
        dtype=np.float64,
    )
    sample_up = np.stack(
        (
            np.cos(sample_lat) * np.cos(sample_lon),
            np.cos(sample_lat) * np.sin(sample_lon),
            np.sin(sample_lat),
        ),
        axis=-1,
    )
    observer = (moon_radius_m + site_elevation_m + mast_height_m) * site_up
    terrain = (moon_radius_m + sample_height)[..., np.newaxis] * sample_up
    relative = terrain - observer
    distance = np.linalg.norm(relative, axis=-1)
    with np.errstate(divide="ignore", invalid="ignore"):
        sine_elevation = np.sum(relative * site_up, axis=-1) / distance
    return np.rad2deg(np.arcsin(np.clip(sine_elevation, -1.0, 1.0)))


def compute_horizon_profiles(
    near_dem: NearFieldDem,
    far_dem: FarFieldDem,
    latitude_deg: float,
    longitude_deg: float,
    *,
    mast_heights_m: tuple[float, ...] = DEFAULT_MAST_HEIGHTS_M,
    max_distance_m: float = DEFAULT_MAX_DISTANCE_M,
    azimuth_step_deg: float = DEFAULT_AZIMUTH_STEP_DEG,
) -> dict[str, Any]:
    """Compute mast-height horizon masks and coverage per azimuth."""
    if not -90.0 <= latitude_deg <= 90.0:
        raise ValueError("latitude_deg must be between -90 and 90")
    if not math.isfinite(longitude_deg):
        raise ValueError("longitude_deg must be finite")
    if not mast_heights_m or any(
        not math.isfinite(height) or height < 0 for height in mast_heights_m
    ):
        raise ValueError("mast heights must be finite, non-negative values")
    if not math.isfinite(azimuth_step_deg) or azimuth_step_deg <= 0:
        raise ValueError("azimuth_step_deg must be positive and finite")
    bins = 360.0 / azimuth_step_deg
    if not math.isclose(bins, round(bins), abs_tol=1e-9):
        raise ValueError("azimuth_step_deg must divide 360 exactly")

    ground_elevation_m = near_dem.site_elevation(latitude_deg, longitude_deg)
    azimuths = np.arange(0.0, 360.0, azimuth_step_deg, dtype=np.float64)
    distances = distance_samples(max_distance_m, near_dem.resolution_m)
    geod = Geod(a=MOON_RADIUS_M, b=MOON_RADIUS_M)
    profiles = {
        f"{height:g}": np.full(azimuths.shape, np.nan, dtype=np.float64)
        for height in mast_heights_m
    }
    coverage_distance = np.zeros(azimuths.shape, dtype=np.float64)

    for index, azimuth in enumerate(azimuths):
        longitudes, latitudes, _ = geod.fwd(
            np.full(distances.shape, longitude_deg),
            np.full(distances.shape, latitude_deg),
            np.full(distances.shape, azimuth),
            distances,
        )
        x_m, y_m = near_dem.projector(longitudes, latitudes)
        elevations = near_dem.sample_xy(x_m, y_m)
        missing_near = ~np.isfinite(elevations)
        if np.any(missing_near):
            far_elevations = far_dem.sample_xy(x_m[missing_near], y_m[missing_near])
            elevations[missing_near] = far_elevations

        missing = np.flatnonzero(~np.isfinite(elevations))
        valid_count = int(missing[0]) if missing.size else len(distances)
        if valid_count == 0:
            continue

        coverage_distance[index] = distances[valid_count - 1]
        sample_slice = slice(0, valid_count)
        for height in mast_heights_m:
            angles = terrain_elevation_angle(
                latitude_deg,
                longitude_deg,
                ground_elevation_m,
                height,
                latitudes[sample_slice],
                longitudes[sample_slice],
                elevations[sample_slice],
            )
            if np.any(np.isfinite(angles)):
                profiles[f"{height:g}"][index] = float(np.nanmax(angles))

    complete = coverage_distance >= max_distance_m - 1e-6
    return {
        "azimuth_deg": azimuths,
        "horizon_deg": profiles,
        "coverage_distance_m": coverage_distance,
        "complete": complete,
        "ground_elevation_m": ground_elevation_m,
        "max_distance_m": max_distance_m,
        "azimuth_step_deg": azimuth_step_deg,
    }
