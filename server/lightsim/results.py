"""Post-processing of a run's raw tallies into engineering results.

Raw tallies are stored per source channel (LED/channel at unit drive). A *state* is a linear combination of
channels, so any state (and any per-LED breakdown) is computed here without re-tracing.

Units: flux in lm (and W radiant), exitance in lm/m^2, luminance in cd/m^2 (= nits), areas in mm^2 in the
tallies and converted to m^2 here.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy import ndimage

from . import store
from .engine import kernels, spectral

DEFAULT_ANALYSIS = {
    "roi": [0.0, 0.0, 1.0, 1.0],  # u0, v0, u1, v1 as fractions of the detector map
    "margin": 0.0,  # extra edge margin excluded from the statistics, fraction of the shorter side
    "smooth_px": 1.0,  # Gaussian smoothing (pixels) before min/max and hotspot statistics
    "color_smooth_px": 2.0,  # Gaussian smoothing (pixels) of XYZ before colour statistics
    "hotspot_ratio": 1.25,  # a hotspot is a local maximum this many times above the ROI mean
    "hotspot_radius_mm": 2.0,  # neighbourhood in which a hotspot must be the maximum
    "view": "cone",  # luminance for the viewing cone ("cone") or all directions as exitance ("all")
}


def _f(x, nd=6):
    return float(np.round(x, nd))


def _arr(a, nd=5):
    return np.round(np.asarray(a, dtype=np.float64), nd).tolist()


@dataclass
class RunData:
    rid: str
    runid: str
    scene: dict
    arrays: dict[str, np.ndarray]
    run: dict

    @classmethod
    def load(cls, rid: str, runid: str) -> "RunData":
        d = store.run_dir(rid, runid)
        run = store.load_run(rid, runid)
        scene = store.read_json(d / "scene.json")
        if run is None or scene is None or not (d / "tallies.npz").exists():
            raise FileNotFoundError("This run has no results (it did not finish)")
        import io

        raw = (d / "tallies.npz").read_bytes()  # read it at once: a live run replaces this file while it runs
        with np.load(io.BytesIO(raw)) as z:
            arrays = {k: z[k] for k in z.files}
        return cls(rid, runid, scene, arrays, run)

    # -- combining channels -----------------------------------------------------------------------
    def state_ids(self) -> list[str]:
        return [s["id"] for s in self.scene["states"]]

    def _state(self, state_id: str) -> dict:
        for s in self.scene["states"]:
            if s["id"] == state_id:
                return s
        raise KeyError(state_id)

    def weights(self, state: dict) -> np.ndarray:
        """Per-channel multiplier turning relative tallies into lm (XYZ) and W (radiometric)."""
        w0 = self.arrays["w0"]  # W per emitted ray
        drive = np.array([state["drive"].get(ch["key"], 0.0) for ch in self.scene["channels"]])
        return w0 * drive

    def combine(self, state_id: str, only_led: str | None = None) -> dict:
        state = self._state(state_id)
        wch = self.weights(state)
        if only_led is not None:
            wch = np.where(np.array([ch["led_id"] == only_led for ch in self.scene["channels"]]), wch, 0.0)
        a = self.arrays

        def comb(name: str, scale: float = 1.0) -> np.ndarray:
            x = a[name]
            return np.tensordot(wch, x, axes=(0, 0)) * scale

        flux_w = float(
            sum(
                state["drive"].get(ch["key"], 0.0) * ch["flux_w"]
                for ch in self.scene["channels"]
                if only_led is None or ch["led_id"] == only_led
            )
        )
        flux_lm = float(
            sum(
                state["drive"].get(ch["key"], 0.0) * ch["flux_lm"]
                for ch in self.scene["channels"]
                if only_led is None or ch["led_id"] == only_led
            )
        )
        return {
            "ex": comb("ex", spectral.KM),
            "cone": comb("cone", spectral.KM),
            "dirh": comb("dirh", spectral.KM),
            "det_pow": comb("det_pow"),
            "abs_vol": comb("abs_vol"),
            "abs_surf": comb("abs_surf"),
            "special": comb("special"),
            "flux_w": flux_w,
            "flux_lm": flux_lm,
        }

    # -- detector maps ---------------------------------------------------------------------------------
    def detector_maps(self, comb: dict, k: int, analysis: dict) -> dict:
        det = self.scene["detectors"][k]
        nu, nv, off = det["nu"], det["nv"], det["offset"]
        sl = slice(off, off + nu * nv)
        area = self.arrays[f"area_map_{k}"]  # (nv, nu) mm^2
        ex = comb["ex"][sl].reshape(nv, nu, 3)
        cone = comb["cone"][sl].reshape(nv, nu, 3)
        sin2 = np.sin(np.radians(det["cone_deg"])) ** 2
        with np.errstate(divide="ignore", invalid="ignore"):
            a_m2 = area * 1e-6
            lum = np.where(a_m2 > 0, cone[..., 1] / (a_m2 * np.pi * sin2), 0.0)  # cd/m2
            exitance = np.where(a_m2 > 0, ex[..., 1] / a_m2, 0.0)  # lm/m2
        return {"ex": ex, "cone": cone, "lum": lum, "exitance": exitance, "area": area}

    def roi_mask(self, area: np.ndarray, analysis: dict) -> np.ndarray:
        nv, nu = area.shape
        valid = area > 0.3 * np.median(area[area > 0]) if (area > 0).any() else area > 0
        u0, v0, u1, v1 = [float(x) for x in analysis["roi"]]
        ys, xs = (np.arange(nv) + 0.5) / nv, (np.arange(nu) + 0.5) / nu
        m = ((xs[None, :] >= u0) & (xs[None, :] <= u1)) & ((ys[:, None] >= v0) & (ys[:, None] <= v1))
        margin = float(analysis.get("margin", 0.0))
        if margin > 0:
            r = int(round(margin * min(nu, nv)))
            if r > 0 and valid.any():
                valid = ndimage.binary_erosion(valid, iterations=r, border_value=0) if valid.sum() > 4 * r * r else valid
        return valid & m

    # -- full result of a state -------------------------------------------------------------------------
    def state_result(self, state_id: str, analysis: dict | None = None, with_led_maps: bool = True) -> dict:
        an = {**DEFAULT_ANALYSIS, **(analysis or {})}
        comb = self.combine(state_id)
        emitted_w, emitted_lm = comb["flux_w"], comb["flux_lm"]
        state = self._state(state_id)
        out: dict = {
            "state": {"id": state["id"], "name": state["name"]},
            "analysis": an,
            "emitted": {"lm": _f(emitted_lm), "w": _f(emitted_w, 8)},
            "rays": int(self.arrays["n_rays"].max()) if len(self.arrays["n_rays"]) else 0,
            "detectors": [],
        }
        # loss breakdown (fractions of emitted radiant flux)
        tot = max(emitted_w, 1e-30)
        by_body = comb["abs_vol"] + comb["abs_surf"]
        sp = comb["special"]
        exit_w = float(comb["det_pow"].sum())
        loss = [{"name": "Exit surface", "kind": "exit", "fraction": _f(exit_w / tot)}]
        from collections import Counter

        counts = Counter(b["name"] for b in self.scene["bodies"])

        def _label(body: dict) -> str:  # "Body 1" alone is ambiguous in an assembly: add the part that holds it
            if counts[body["name"]] <= 1:
                return body["name"]
            parts = [p for p in str(body["path"]).split("/") if p]
            return " / ".join(parts[-2:]) if len(parts) > 1 else body["name"]

        for b, body in enumerate(self.scene["bodies"]):
            frac = by_body[b] / tot
            if frac > 1e-5:
                loss.append(
                    {
                        "name": _label(body),
                        "path": body["path"],
                        "kind": "absorbed",
                        "fraction": _f(frac),
                        "volume": _f(comb["abs_vol"][b] / tot),
                        "surface": _f(comb["abs_surf"][b] / tot),
                    }
                )
        loss.append({"name": "Escaped (other surfaces)", "kind": "escaped", "fraction": _f(sp[kernels.ESC] / tot)})
        for idx, label, kind in (
            (kernels.LEAK, "Leaked (mesh holes)", "error"),
            (kernels.MAXB, "Bounce limit reached", "error"),
            (kernels.ANOM, "Medium tracking errors", "error"),
            (kernels.ROUL, "Roulette noise (net)", "noise"),
        ):
            if abs(sp[idx] / tot) > 1e-6:
                loss.append({"name": label, "kind": kind, "fraction": _f(sp[idx] / tot)})
        out["loss"] = loss
        out["lossSum"] = _f(sum(l["fraction"] for l in loss))

        for k, det in enumerate(self.scene["detectors"]):
            out["detectors"].append(self._detector_result(comb, k, det, an, state_id, with_led_maps))
        return out

    def _detector_result(self, comb: dict, k: int, det: dict, an: dict, state_id: str, with_led_maps: bool) -> dict:
        maps = self.detector_maps(comb, k, an)
        area = maps["area"]
        mask = self.roi_mask(area, an)
        nv, nu = area.shape
        key = "lum" if an["view"] == "cone" else "exitance"
        base = maps[key]
        sm = _smooth(base, area > 0, float(an["smooth_px"]))

        exit_lm = float(comb["ex"][det["offset"] : det["offset"] + nu * nv, 1].sum())
        exit_w = float(comb["det_pow"][k])
        res: dict = {
            "id": det["id"],
            "name": det["name"],
            "nu": nu,
            "nv": nv,
            "areaMm2": _f(det["area_total"], 3),
            "uExtentMm": _f(det["ext"][1] - det["ext"][0], 3),
            "vExtentMm": _f(det["ext"][3] - det["ext"][2], 3),
            "coneDeg": det["cone_deg"],
            "exitLm": _f(exit_lm),
            "efficiency": _f(exit_lm / comb["flux_lm"]) if comb["flux_lm"] > 0 else 0.0,
            "efficiencyRadiometric": _f(exit_w / comb["flux_w"]) if comb["flux_w"] > 0 else 0.0,
            "quantity": "luminance" if key == "lum" else "exitance",
            "unit": "cd/m2" if key == "lum" else "lm/m2",
        }
        res["luminance"] = _arr(maps["lum"], 3)
        res["exitance"] = _arr(maps["exitance"], 3)
        res["mask"] = mask.astype(int).tolist()
        res["valid"] = (area > 0.3 * np.median(area[area > 0])).astype(int).tolist() if (area > 0).any() else [[0] * nu for _ in range(nv)]

        vals = sm[mask]
        stats = {}
        if vals.size:
            mean, mx, mn = float(vals.mean()), float(vals.max()), float(vals.min())
            stats = {
                "mean": _f(mean, 3),
                "max": _f(mx, 3),
                "min": _f(mn, 3),
                "minOverMax": _f(mn / mx) if mx > 0 else 0.0,
                "minOverAvg": _f(mn / mean) if mean > 0 else 0.0,
                "maxOverAvg": _f(mx / mean) if mean > 0 else 0.0,
                "cv": _f(float(vals.std() / mean)) if mean > 0 else 0.0,
                "p5OverP95": _f(float(np.percentile(vals, 5) / max(np.percentile(vals, 95), 1e-30))),
                "pixels": int(vals.size),
            }
        res["stats"] = stats

        # hotspots
        res["hotspots"] = self._hotspots(sm, mask, area, det, an)

        # colour
        ex_raw = maps["ex"] if an["view"] != "cone" else maps["cone"]
        xyz_sum = ex_raw[mask].sum(axis=0) if mask.any() else np.zeros(3)
        # colour noise: every ray carries a single wavelength, so per-pixel XYZ is much noisier than luminance
        ex = np.stack([_smooth(ex_raw[..., c], area > 0, float(an["color_smooth_px"])) for c in range(3)], axis=-1)
        if xyz_sum[1] > 0:
            uv_all = spectral.uv_of_xyz(ex)
            uv_mean = spectral.uv_of_xyz(xyz_sum)
            xy_mean = spectral.xy_of_xyz(xyz_sum)
            duv = np.linalg.norm(uv_all - uv_mean, axis=-1)
            lum_ok = mask & (ex[..., 1] > 0.02 * ex[..., 1][mask].mean())
            dv = duv[lum_ok] if lum_ok.any() else duv[mask]
            res["color"] = {
                "x": _f(xy_mean[0]),
                "y": _f(xy_mean[1]),
                "u": _f(uv_mean[0]),
                "v": _f(uv_mean[1]),
                "cct": _f(spectral.cct_mccamy(float(xy_mean[0]), float(xy_mean[1])), 0),
                "maxDuv": _f(float(dv.max()), 5),
                "p95Duv": _f(float(np.percentile(dv, 95)), 5),
                "meanDuv": _f(float(dv.mean()), 5),
            }
            res["duvMap"] = _arr(np.where(mask, duv, 0.0), 5)
            res["chromaticityXY"] = _arr(spectral.xy_of_xyz(ex), 4)
            # appearance image: exposure so that the 98th percentile luminance is white
            yv = ex[..., 1][mask]
            white = float(np.percentile(yv, 98)) if yv.size else 1.0
            rgb = spectral.xyz_to_srgb(ex, white_y=white if white > 0 else None)
            rgb = np.where((area > 0)[..., None], rgb, 0.0)
            res["appearance"] = (np.round(rgb * 255)).astype(int).tolist()
        else:
            res["color"] = None

        # profiles along the detector axes (mean over the ROI mask)
        mf = mask.astype(float)
        with np.errstate(divide="ignore", invalid="ignore"):
            pu = np.where(mf.sum(axis=0) > 0, (base * mf).sum(axis=0) / np.maximum(mf.sum(axis=0), 1), np.nan)
            pv = np.where(mf.sum(axis=1) > 0, (base * mf).sum(axis=1) / np.maximum(mf.sum(axis=1), 1), np.nan)
        res["profileU"] = [None if np.isnan(x) else _f(x, 3) for x in pu]
        res["profileV"] = [None if np.isnan(x) else _f(x, 3) for x in pv]

        # angular distribution
        res["angular"] = self._angular(comb, k)

        # per-LED contribution
        leds = []
        for led_id, led_name in self._leds():
            c2 = self.combine(state_id, only_led=led_id)
            m2 = self.detector_maps(c2, k, an)
            led_exit = float(c2["ex"][det["offset"] : det["offset"] + nu * nv, 1].sum())
            item = {
                "id": led_id,
                "name": led_name,
                "emittedLm": _f(c2["flux_lm"]),
                "exitLm": _f(led_exit),
                "efficiency": _f(led_exit / c2["flux_lm"]) if c2["flux_lm"] > 0 else 0.0,
                "shareOfExit": _f(led_exit / exit_lm) if exit_lm > 0 else 0.0,
            }
            if with_led_maps and c2["flux_lm"] > 0:
                item["map"] = _arr(m2[key], 3)
            leds.append(item)
        res["leds"] = leds
        return res

    def _leds(self) -> list[tuple[str, str]]:
        seen: dict[str, str] = {}
        for ch in self.scene["channels"]:
            seen.setdefault(ch["led_id"], ch["led_name"])
        return list(seen.items())

    def _hotspots(self, sm: np.ndarray, mask: np.ndarray, area: np.ndarray, det: dict, an: dict) -> list[dict]:
        if not mask.any():
            return []
        nv, nu = sm.shape
        mean = float(sm[mask].mean())
        if mean <= 0:
            return []
        lu = det["ext"][1] - det["ext"][0]
        lv = det["ext"][3] - det["ext"][2]
        pix_mm = max(lu / nu, 1e-9)
        r = max(1, int(round(float(an["hotspot_radius_mm"]) / pix_mm)))
        work = np.where(mask, sm, 0.0)
        local = ndimage.maximum_filter(work, size=2 * r + 1, mode="constant")
        cand = (work == local) & mask & (work >= float(an["hotspot_ratio"]) * mean)
        ys, xs = np.nonzero(cand)
        spots = []
        origin = np.array(det["origin"])
        U, Vv = np.array(det["u"]), np.array(det["v"])
        for y, x in zip(ys, xs):
            fu, fv = (x + 0.5) / nu, (y + 0.5) / nv
            pos = origin + U * (det["ext"][0] + fu * lu) + Vv * (det["ext"][2] + fv * lv)
            spots.append({"u": _f(fu, 4), "v": _f(fv, 4), "ratio": _f(work[y, x] / mean, 3), "world": _arr(pos, 3)})
        spots.sort(key=lambda s: -s["ratio"])
        return spots[:12]

    def _angular(self, comb: dict, k: int) -> dict:
        dirh = comb["dirh"][k]  # (nth, 3) lm per polar bin
        nth = dirh.shape[0]
        edges = np.linspace(0.0, 90.0, nth + 1)
        omega = 2.0 * np.pi * (np.cos(np.radians(edges[:-1])) - np.cos(np.radians(edges[1:])))
        inten = dirh[:, 1] / omega  # cd (flux per steradian)
        centres = 0.5 * (edges[:-1] + edges[1:])
        peak = float(inten.max()) if inten.size else 0.0
        duv = None
        if dirh[0, 1] > 0:
            uv = spectral.uv_of_xyz(dirh)
            ref = spectral.uv_of_xyz(dirh[0])
            duv = _arr(np.where(dirh[:, 1] > 0, np.linalg.norm(uv - ref, axis=-1), 0.0), 5)
        return {
            "angles": _arr(centres, 2),
            "intensityCd": _arr(inten, 5),
            "relative": _arr(inten / peak if peak > 0 else inten, 4),
            "duvFromNormal": duv,
        }

    # -- summary for lists ---------------------------------------------------------------------------------
    def summary(self) -> dict:
        out = {"states": []}
        for s in self.scene["states"]:
            try:
                r = self.state_result(s["id"], with_led_maps=False)
            except Exception:  # pragma: no cover
                continue
            dets = []
            for d in r["detectors"]:
                dets.append(
                    {
                        "name": d["name"],
                        "efficiency": d["efficiency"],
                        "exitLm": d["exitLm"],
                        "mean": d["stats"].get("mean"),
                        "minOverMax": d["stats"].get("minOverMax"),
                        "cv": d["stats"].get("cv"),
                        "maxDuv": (d.get("color") or {}).get("maxDuv"),
                        "hotspots": len(d["hotspots"]),
                    }
                )
            out["states"].append({"id": s["id"], "name": s["name"], "emittedLm": r["emitted"]["lm"], "detectors": dets})
        return out


def _smooth(a: np.ndarray, valid: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian smoothing that does not bleed in zeros from outside the detector (normalised convolution)."""
    if sigma <= 0:
        return a
    w = valid.astype(float)
    num = ndimage.gaussian_filter(a * w, sigma, mode="nearest")
    den = ndimage.gaussian_filter(w, sigma, mode="nearest")
    return np.where(den > 1e-6, num / np.maximum(den, 1e-6), 0.0)


# -- comparing runs ----------------------------------------------------------------------------------------
def _resample(a: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    nv, nu = a.shape
    yy, xx = np.meshgrid((np.arange(shape[0]) + 0.5) / shape[0] * nv - 0.5, (np.arange(shape[1]) + 0.5) / shape[1] * nu - 0.5, indexing="ij")
    return ndimage.map_coordinates(a, [yy, xx], order=1, mode="nearest")


def compare(a: dict, b: dict, grid: int = 160) -> dict:
    """Two detector results (from ``state_result``) on a common normalised (u, v) grid."""
    aspect = a["uExtentMm"] / max(a["vExtentMm"], 1e-9)
    nu = grid
    nv = int(np.clip(round(grid / max(aspect, 1e-3)), 8, grid))
    la = _resample(np.array(a["luminance"] if a["quantity"] == "luminance" else a["exitance"]), (nv, nu))
    lb = _resample(np.array(b["luminance"] if b["quantity"] == "luminance" else b["exitance"]), (nv, nu))
    ma = _resample(np.array(a["valid"], dtype=float), (nv, nu)) > 0.5
    mb = _resample(np.array(b["valid"], dtype=float), (nv, nu)) > 0.5
    both = ma & mb
    la, lb = np.where(ma, la, 0), np.where(mb, lb, 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(both & (la > 0), lb / la, 1.0)
    return {
        "nu": nu,
        "nv": nv,
        "a": _arr(la, 3),
        "b": _arr(lb, 3),
        "diff": _arr(np.where(both, lb - la, 0.0), 3),
        "ratio": _arr(ratio, 4),
        "validA": ma.astype(int).tolist(),
        "validB": mb.astype(int).tolist(),
        "vmax": _f(float(max(la.max(), lb.max())), 3),
        "dmax": _f(float(np.abs(np.where(both, lb - la, 0.0)).max()), 3),
    }


# -- image export -----------------------------------------------------------------------------------------
_TURBO = np.array(
    [
        [0.19, 0.07, 0.23], [0.27, 0.32, 0.79], [0.14, 0.58, 0.99], [0.08, 0.80, 0.80], [0.30, 0.95, 0.52],
        [0.66, 0.99, 0.24], [0.93, 0.86, 0.20], [0.99, 0.60, 0.12], [0.86, 0.30, 0.05], [0.48, 0.02, 0.01],
    ]
)


def colormap(values01: np.ndarray) -> np.ndarray:
    """Turbo-like colormap (0..1 -> RGB 0..255 uint8)."""
    x = np.clip(values01, 0.0, 1.0) * (len(_TURBO) - 1)
    i = np.minimum(x.astype(int), len(_TURBO) - 2)
    f = (x - i)[..., None]
    rgb = _TURBO[i] * (1 - f) + _TURBO[i + 1] * f
    return (rgb * 255).astype(np.uint8)


def render_png(values: np.ndarray, valid: np.ndarray, vmax: float | None = None, vmin: float = 0.0, scale: int = 4, appearance: np.ndarray | None = None) -> bytes:
    from PIL import Image

    if appearance is not None:
        img = np.asarray(appearance, dtype=np.uint8)
    else:
        top = vmax if vmax else float(np.percentile(values[valid > 0], 99.5)) if (valid > 0).any() else 1.0
        norm = (values - vmin) / max(top - vmin, 1e-30)
        img = colormap(norm)
        img[valid == 0] = (30, 30, 30)
    im = Image.fromarray(img).resize((img.shape[1] * scale, img.shape[0] * scale), Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def metrics_csv(results: list[dict]) -> str:
    rows = ["state,detector,emitted_lm,exit_lm,efficiency,mean,min,max,min_over_max,cv,max_duv,cct,hotspots"]
    for r in results:
        for d in r["detectors"]:
            s = d["stats"]
            c = d.get("color") or {}
            rows.append(
                ",".join(
                    str(x)
                    for x in (
                        r["state"]["name"], d["name"], r["emitted"]["lm"], d["exitLm"], d["efficiency"],
                        s.get("mean", ""), s.get("min", ""), s.get("max", ""), s.get("minOverMax", ""), s.get("cv", ""),
                        c.get("maxDuv", ""), c.get("cct", ""), len(d["hotspots"]),
                    )
                )
            )
    return "\n".join(rows) + "\n"


def export_zip(data: RunData, analysis: dict | None = None) -> bytes:
    results = [data.state_result(sid, analysis) for sid in data.state_ids()]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("metrics.csv", metrics_csv(results))
        z.writestr("results.json", json.dumps(results))
        for r in results:
            for d in r["detectors"]:
                stem = f"{_safe(r['state']['name'])}_{_safe(d['name'])}"
                valid = np.array(d["valid"])
                key = "luminance" if d["quantity"] == "luminance" else "exitance"
                z.writestr(f"{stem}_{key}.png", render_png(np.array(d[key]), valid))
                if d.get("appearance") is not None:
                    z.writestr(f"{stem}_appearance.png", render_png(np.zeros(valid.shape), valid, appearance=np.array(d["appearance"])))
    return buf.getvalue()


def _safe(text: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in text).strip("_") or "x"
