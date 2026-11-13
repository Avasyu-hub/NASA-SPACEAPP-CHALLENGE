from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Proj
from rasterio.transform import from_origin

from lunawise_terrain.terrain import (
    FarFieldDem,
    NearFieldDem,
    compute_horizon_profiles,
    distance_samples,
    terrain_elevation_angle,
)


def test_distance_samples_uses_initial_and_fractional_steps():
    np.testing.assert_allclose(distance_samples(25, 10, 0.5), [10, 20, 25])


def test_near_dem_bilinear_sampling_and_outside_coverage(tmp_path: Path):
    dem_path = tmp_path / "near.tif"
    moon_projection = Proj(
        "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400 +units=m +no_defs"
    )
    with rasterio.open(
        dem_path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="float32",
        crs=moon_projection.crs.srs,
        transform=from_origin(0, 20, 10, 10),
        nodata=-9999,
    ) as dataset:
        dataset.write(np.array([[0, 10], [20, 30]], dtype=np.float32), 1)

    with NearFieldDem(dem_path) as dem:
        np.testing.assert_allclose(dem.sample_xy([5, 10, 40], [15, 10, 10]), [0, 15, np.nan])


def test_pds_dem_reads_labeled_little_endian_float_values(tmp_path: Path):
    image_path = tmp_path / "far.IMG"
    label_path = tmp_path / "far.LBL"
    np.arange(16, dtype="<f4").reshape(4, 4).tofile(image_path)
    label_path.write_text(
        "\n".join(
            [
                "LINES = 4",
                "LINE_SAMPLES = 4",
                "MAP_SCALE = 10 <m/pix>",
                "SAMPLE_PROJECTION_OFFSET = 1.5 <pix>",
                "LINE_PROJECTION_OFFSET = 1.5 <pix>",
                "A_AXIS_RADIUS = 1737.4 <km>",
                "SCALING_FACTOR = 1",
                'SAMPLE_TYPE = "PC_REAL"',
                "SAMPLE_BITS = 32",
                'UNIT = "KILOMETER"',
                "CENTER_LONGITUDE = 0 <deg>",
            ]
        ),
        encoding="ascii",
    )

    with FarFieldDem(image_path, label_path) as dem:
        assert dem.radius_m == 1_737_400
        assert dem.sample_xy(0, 0).item() == 10_000
        assert math.isnan(dem.sample_xy(10_000, 0).item())


def test_spherical_elevation_accounts_for_lunar_curvature():
    from pyproj import Geod

    longitude, latitude, _ = Geod(a=1_737_400, b=1_737_400).fwd(0, -89, 0, 1_000)
    angle = terrain_elevation_angle(-89, 0, 0, 2, latitude, longitude, 0).item()
    assert -0.14 < angle < -0.12


class FlatNearDem:
    resolution_m = 10.0
    projector = Proj(
        "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400 +units=m +no_defs"
    )

    def site_elevation(self, latitude_deg, longitude_deg):
        return 0.0

    def sample_xy(self, x_m, y_m):
        return np.zeros(np.broadcast(x_m, y_m).shape, dtype=np.float64)


class FlatFarDem:
    def sample_xy(self, x_m, y_m):
        return np.zeros(np.broadcast(x_m, y_m).shape, dtype=np.float64)


def test_horizon_profiles_report_complete_requested_azimuths():
    result = compute_horizon_profiles(
        FlatNearDem(),
        FlatFarDem(),
        -89,
        0,
        mast_heights_m=(2.0,),
        max_distance_m=50,
        azimuth_step_deg=180,
    )
    assert result["complete"].tolist() == [True, True]
    assert result["horizon_deg"]["2"].shape == (2,)
