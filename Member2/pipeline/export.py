"""Member 2 terrain export -> data_out/ in the team contract (goal.md section 5.2).

Run from Member2/ :
  py -m pipeline.export --all                      # every site in pipeline/sites_config.json
  py -m pipeline.export --site site04              # one site
  py -m pipeline.export --all --data-raw D:/lunawise/data_raw

Writes (repo root data_out/):
  sites.json                    contract #1 (list of sites)
  mask/<id>.json                contract #3: elev_deg = 360 bins, 2 m mast, az 0..359 clockwise from N
                                + extras (ignored by readers that don't need them):
                                  elev_deg_by_mast {"0","2","5","10"} (360 bins each),
                                  elev_deg_720_by_mast (0.5 deg bins), horizon_dist_km_by_mast,
                                  search_km, dem, site_point
  heightmap/<id>.json + <id>_near.bin + <id>_far.bin
                                contract #5: Float32 LE, row-major, row 0 = southernmost,
                                heights rel. to lander ground, curvature pre-subtracted

The site point comes from data files only: the largest PGDA ROI (SiteXX_ROIs.shp), or, when
PGDA has no ROI file (Site23), the PGDA 69 illumination map with PGDA's own ROI rule.
"""
import argparse
import json
import re
from pathlib import Path

import numpy as np

from pipeline.horizon import DEMSampler, LayeredSampler, compute_horizons, team_grid
from pipeline.roi import read_rois

M2 = Path(__file__).resolve().parent.parent
REPO = M2.parent
MASTS = [0, 2, 5, 10]
NOMINAL_MAST = 2
NEAR = {"n": 512, "cell_m": 10.0}      # 5.12 km square
FAR = {"n": 512, "cell_m": 120.0}      # 61.44 km square


def far_open_args(path):
    """PDS LDEM float products: GDAL must open the .LBL; DN is height in KM above the
    1737.4 km sphere, and GDAL reports OFFSET=1737.4 from the label, which we must NOT add
    (we want height above R, not radius). GeoTIFFs: metres as-is."""
    p = Path(path)
    lbl = p.with_suffix(".LBL")
    if p.suffix.upper() in (".IMG", ".LBL") and lbl.exists():
        km = re.search(r"^\s*UNIT\s*=\s*KILOMETER", lbl.read_text(errors="ignore"), re.M)
        return str(lbl), {"z_scale": 1000.0 if km else 1.0, "apply_offset": False}
    return str(p), {}


def overlap_check(near, far, n=4000, seed=0):
    """Far DEM minus near DEM at random points inside the near tile (metres)."""
    rng = np.random.default_rng(seed)
    b = near.bounds
    x = rng.uniform(b.left, b.right, n)
    y = rng.uniform(b.bottom, b.top, n)
    d = far.sample_xy(x, y) - near.sample_xy(x, y)
    d = d[~np.isnan(d)]
    return {"n": int(d.size), "median_m": round(float(np.median(d)), 2),
            "mad_m": round(float(np.median(np.abs(d - np.median(d)))), 2)}


def r2(a):
    return [round(float(v), 2) for v in a]


def site_point(cfg, near, data_raw):
    if cfg.get("roi"):
        rois = read_rois(data_raw / cfg["roi"])
        r = rois[0]
        return r["x"], r["y"], {"method": "PGDA ROI", "file": Path(cfg["roi"]).name,
                                "roi_index": r["index"], "roi_area_m2": r["area_m2"],
                                "point_source": r["point_source"], "all_rois": rois}
    if cfg.get("illum"):
        from pipeline.site_from_illum import pick
        p = pick(data_raw / cfg["dem"], data_raw / cfg["illum"])
        return p["x_m"], p["y_m"], {"method": "PGDA 69 illumination map", **p}
    raise ValueError(f"{cfg['id']}: needs 'roi' or 'illum' in sites_config.json")


def run_site(cfg, data_raw, out, max_km=200.0):
    near = DEMSampler(data_raw / cfg["dem"], label=Path(cfg["dem"]).name)
    R = near.R
    cx, cy, how = site_point(cfg, near, data_raw)
    lat0, lon0 = near.latlon(cx, cy)
    h0 = float(near.sample_xy(cx, cy))

    fpath, fargs = far_open_args(data_raw / cfg["far"])
    far = DEMSampler(fpath, label=Path(cfg["far"]).name, window_xy=(cx, cy),
                     window_m=max_km * 1000.0 + 10_000.0, **fargs)
    if abs(far.R - R) > 1.0:
        raise ValueError(f"radius mismatch near {R} vs far {far.R}")
    ov = overlap_check(near, far)
    if abs(ov["median_m"]) > 50:
        raise ValueError(f"far DEM disagrees with near tile: {ov} (units or datum wrong?)")
    sampler = LayeredSampler([near, far])

    res = compute_horizons(lat0, lon0, h0, MASTS, sampler, pixel_m=near.res_m,
                           max_m=max_km * 1000.0, dense_m=near.reach_m(lat0, lon0), R=R)
    reach_km = res["valid_reach_m"] / 1000.0
    hz720 = {str(m): r2(res["horizon_deg"][m]) for m in MASTS}
    hz360 = {k: v[::2] for k, v in hz720.items()}               # exact azimuths 0,1,...,359
    dist360 = {str(m): [round(float(v) / 1000, 3) for v in res["horizon_dist_m"][m][::2]]
               for m in MASTS}
    lon_pm = (lon0 + 180) % 360 - 180

    (out / "mask").mkdir(parents=True, exist_ok=True)
    (out / "mask" / f"{cfg['id']}.json").write_text(json.dumps({
        "site": cfg["id"], "obs_height_m": float(NOMINAL_MAST), "az_step_deg": 1.0,
        "elev_deg": hz360[str(NOMINAL_MAST)],
        "elev_deg_by_mast": hz360,
        "elev_deg_720_by_mast": hz720,
        "horizon_dist_km_by_mast": dist360,
        "search_km": {"min": round(float(reach_km.min()), 2), "max": round(float(reach_km.max()), 2)},
        "dem": {"near": near.label, "far": far.label, "far_minus_near": ov, "pixel_m": near.res_m},
        "method": "max 3D elevation angle over geodesic samples (every 5 m pixel in the near tile, "
                  "then max(5 m, 0.5% of distance)) to 200 km, sphere R=1737.4 km",
    }))

    hdir = out / "heightmap"
    hdir.mkdir(parents=True, exist_ok=True)
    meta = {"site": cfg["id"], "ground_height_m": round(h0, 2), "obs_height_m": float(NOMINAL_MAST),
            "axes": "x=east, y=north, row 0 = southernmost row, lander at grid center",
            "values": "Float32 LE, m relative to lander ground, curvature (d^2/2R) pre-subtracted, "
                      "sampled at cell centres; NaN = no DEM"}
    for key, g in (("near", NEAR), ("far", FAR)):
        z = team_grid(lat0, lon0, h0, sampler, g["n"], g["cell_m"], R)
        fname = f"{cfg['id']}_{key}.bin"
        z.astype("<f4").tofile(hdir / fname)
        meta[key] = {"file": fname, "nx": g["n"], "ny": g["n"], "cell_m": g["cell_m"],
                     "size_m": g["n"] * g["cell_m"], "nan_frac": round(float(np.isnan(z).mean()), 4)}
    (hdir / f"{cfg['id']}.json").write_text(json.dumps(meta))

    site = {"id": cfg["id"], "name": cfg["name"], "lat": round(lat0, 6), "lon": round(lon_pm, 6),
            "ground_height_m": round(h0, 2), "obs_height_m": float(NOMINAL_MAST),
            "source_file": near.label,
            "description": f"Site point: {how['method']} ({cfg.get('roi') or cfg.get('illum')})."}
    summary = {k: (min(v), float(np.median(v)), max(v)) for k, v in hz360.items()}
    return site, summary, ov, reach_km


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--all", action="store_true")
    p.add_argument("--site", action="append", default=[])
    p.add_argument("--data-raw", default=str(REPO / "data_raw"))
    p.add_argument("--out", default=str(REPO / "data_out"))
    p.add_argument("--max-km", type=float, default=200.0)
    a = p.parse_args()
    cfgs = json.loads((M2 / "pipeline" / "sites_config.json").read_text())["sites"]
    todo = cfgs if a.all else [c for c in cfgs if c["id"] in a.site]
    if not todo:
        p.error("give --all or --site <id>")
    data_raw, out = Path(a.data_raw), Path(a.out)

    sites_path = out / "sites.json"
    sites = {s["id"]: s for s in json.loads(sites_path.read_text())} if sites_path.exists() else {}
    for cfg in todo:
        site, summ, ov, reach = run_site(cfg, data_raw, out, a.max_km)
        sites[site["id"]] = site
        print(f"{site['id']}: lat {site['lat']} lon {site['lon']} ground {site['ground_height_m']} m; "
              f"far-near {ov['median_m']} m; search {reach.min():.0f}-{reach.max():.0f} km")
        for m, (lo, med, hi) in summ.items():
            print(f"  mast {m:>2} m: horizon min {lo:6.2f} median {med:6.2f} max {hi:6.2f} deg")
    order = [c["id"] for c in cfgs]
    out.mkdir(parents=True, exist_ok=True)
    sites_path.write_text(json.dumps(sorted(sites.values(), key=lambda s: order.index(s["id"])
                                            if s["id"] in order else 99), indent=2))


if __name__ == "__main__":
    main()
