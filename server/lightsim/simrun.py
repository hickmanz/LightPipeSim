"""Runs one simulation (all source channels needed by the setup's states) and stores the raw tallies."""

from __future__ import annotations

import time
from typing import Callable

import numpy as np

from . import library as lib
from . import store
from .engine import sources, tracer
from .engine.scene import build_scene
from .optical_mesh import load_optical

DEFAULT_SETTINGS = {
    "rays": 200_000,  # rays per source channel
    "seed": 1,
    "rr_threshold": 0.01,
    "max_bounces": 500,
    "theta_bins": 12,
    "preview_paths": 16,  # recorded ray paths per LED
    "max_path_points": 128,
    "live": False,  # traced in growing passes that are saved as they finish (live preview)
    "analysis": True,  # keep what is needed to see where the light came from (face contributions, ray logs, ray replay)
    "analysis_rays": 2_000_000,  # rays per channel that are logged in detail (the maps always use every ray)
}


def effective_states(setup: dict) -> list[dict]:
    states = [s for s in (setup.get("states") or []) if s.get("id")]
    if not states:
        states = [{"id": "all", "name": "All LEDs on", "drive": {"*": 1.0}}]
    return states


def run_simulation(rid: str, runid: str, progress: Callable[[str, float], None]) -> None:
    rdir = store.run_dir(rid, runid)
    run = store.load_run(rid, runid) or {}
    settings = {**DEFAULT_SETTINGS, **(run.get("settings") or {})}
    setup = store.read_json(rdir / "setup.json") or run.get("setup")
    if not setup:
        raise ValueError("The run has no setup snapshot")
    library = store.read_json(rdir / "library.json") or lib.get_library()

    mdir = store.rev_dir(rid)
    opt = load_optical(mdir / "optical.npz")
    opt_doc = store.read_json(mdir / "optical.json")
    if not opt_doc:
        raise ValueError("The revision has no optical mesh (import did not finish)")

    t_start = time.time()
    progress("Building scene", 0.0)
    scene = build_scene(opt, opt_doc, setup, library)
    if not scene.detectors:
        raise ValueError("The setup has no detector. Pick the exit surface faces first.")
    srcs = sources.build_channel_sources(setup, opt_doc, scene, opt, library)

    states = effective_states(setup)
    resolved = []
    for s in states:
        resolved.append({"id": s["id"], "name": s.get("name", s["id"]), "drive": sources.resolve_state_drive(s, srcs)})
    used = [src for src in srcs if any(st["drive"].get(src.key, 0.0) > 0 for st in resolved)]
    if not used:
        raise ValueError("No LED channel is driven in any state")

    n_rays = int(settings["rays"])
    nth = int(settings["theta_bins"])
    nbody, ndet = len(scene.bodies), len(scene.detectors)
    nch = len(used)

    arr = {
        "ex": np.zeros((nch, scene.total_pix, 3), dtype=np.float64),
        "cone": np.zeros((nch, scene.total_pix, 3), dtype=np.float64),
        "dirh": np.zeros((nch, ndet, nth, 3)),
        "det_pow": np.zeros((nch, ndet)),
        "abs_vol": np.zeros((nch, nbody)),
        "abs_surf": np.zeros((nch, nbody)),
        "special": np.zeros((nch, 8)),
        "n_rays": np.full(nch, n_rays, dtype=np.int64),
        "w0": np.zeros(nch),
        "flux_lm": np.zeros(nch),
        "accounted": np.zeros(nch),
    }
    for k, det in enumerate(scene.detectors):
        arr[f"area_map_{k}"] = det.area_map

    scene_doc = {
        "bodies": [
            {"index": b["index"], "path": b["path"], "name": b["name"], "material": b["material"], "finish": b["finish"], "transparent": b["transparent"]}
            for b in scene.bodies
        ],
        "detectors": [
            {
                "id": d.id, "name": d.name, "origin": d.origin.tolist(), "u": d.u.tolist(), "v": d.v.tolist(), "n": d.n.tolist(),
                "ext": d.ext.tolist(), "nu": int(d.nu), "nv": int(d.nv), "offset": int(d.offset), "cone_deg": float(d.cone_deg),
                "area_total": float(d.area_total), "corners": d.corners.tolist(),
                "mode": int(d.mode), **({"mesh": d.mesh} if d.mesh else {}),
            }
            for d in scene.detectors
        ],
        "channels": [
            {
                "key": s.key, "led_id": s.led_id, "led_name": s.led_name, "channel_id": s.channel_id, "channel_name": s.channel_name,
                "flux_lm": s.flux_lm, "flux_w": s.flux_w,
                "color": _channel_color(s),
                "origin": s.origin.tolist(), "axis": s.axis.tolist(),
            }
            for s in used
        ],
        "states": resolved,
        "warnings": list(scene.warnings),
        "settings": settings,
    }

    live = bool(settings.get("live"))
    do_analysis = bool(settings.get("analysis", True)) and not live
    # a live run is traced in growing passes and saved after each one, so that its results can be looked at while it runs
    sizes: list[int] = []
    if live:
        first = max(2000, min(n_rays, 4000))
        while sum(sizes) < n_rays:
            sizes.append(min(first * 2 ** len(sizes), n_rays - sum(sizes)))
    else:
        sizes = [n_rays]

    paths_out: list[dict] = []
    tallies: list = [None] * nch
    seeds = [int(settings["seed"]) + 7919 * i for i in range(nch)]
    seen_led: set[str] = set()
    steps = 0
    done_rays = 0
    for pass_no, size in enumerate(sizes):
        for i, src in enumerate(used):
            want_paths = 0
            if pass_no == 0 and src.led_id not in seen_led and settings["preview_paths"] > 0:
                want_paths = int(settings["preview_paths"])
                seen_led.add(src.led_id)

            def prog(f: float, i=i, src=src, size=size) -> None:
                frac = (done_rays + (i + f) / nch * size) / n_rays
                progress(f"Tracing {src.led_name} / {src.channel_name} ({i + 1}/{nch}), {int(done_rays + f * size):,} of {n_rays:,} rays each", frac)

            tl = tracer.trace_channel(
                scene, src, size, seed=seeds[i], start=done_rays,
                rr_threshold=float(settings["rr_threshold"]), max_bounces=int(settings["max_bounces"]),
                theta_bins=nth, record_paths=want_paths, max_path_points=int(settings["max_path_points"]),
                progress=prog, analysis=do_analysis, log_rays=int(settings.get("analysis_rays", 2_000_000)),
            )
            tallies[i] = tl
            steps += tl.steps
            arr["ex"][i] += tl.ex
            arr["cone"][i] += tl.cone
            arr["dirh"][i] += tl.dirh
            arr["det_pow"][i] += tl.det_pow
            arr["abs_vol"][i] += tl.abs_vol
            arr["abs_surf"][i] += tl.abs_surf
            arr["special"][i] += tl.special
            arr["accounted"][i] += tl.total_accounted()
            if want_paths and tl.paths is not None:
                for p in range(want_paths):
                    n = int(tl.path_n[p])
                    if n >= 2:
                        pts = np.round(tl.paths[p, :n], 3).tolist()
                        paths_out.append({"led": src.led_id, "channel": src.channel_id, "points": pts})
        done_rays += size
        for i, src in enumerate(used):
            arr["n_rays"][i] = done_rays
            arr["w0"][i] = src.flux_w / done_rays
            arr["flux_lm"][i] = src.flux_lm
        if live:
            _save_partial(rdir, arr, scene_doc, paths_out, done_rays, n_rays, first=(pass_no == 0))

    progress("Saving results", 0.99)
    arr["accounted"] = arr["accounted"] / done_rays
    np.savez_compressed(rdir / "tallies.npz", **arr)
    store.write_json(rdir / "scene.json", scene_doc)
    store.write_json(rdir / "paths.json", {"paths": paths_out})
    analysis_warning = None
    if do_analysis:
        progress("Saving analysis", 0.995)
        try:
            from . import analysis

            analysis.save(rdir, scene, used, tallies, settings, seeds, n_rays)
        except Exception as exc:  # the results are complete without it
            analysis_warning = f"The analysis data could not be saved: {exc}"
    run = store.load_run(rid, runid) or {}
    elapsed = time.time() - t_start
    run["timing"] = {"seconds": round(elapsed, 2), "raysTotal": n_rays * nch, "raysPerSecond": round(n_rays * nch / max(elapsed, 1e-9))}
    run["warnings"] = list(scene.warnings) + ([analysis_warning] if analysis_warning else [])
    run["hasAnalysis"] = bool(do_analysis and not analysis_warning)
    run["maxAccountingError"] = float(np.max(np.abs(arr["accounted"] - 1.0)))
    store.save_run(rid, runid, run)
    # summary (needs the saved files)
    from .results import RunData

    run = store.load_run(rid, runid) or {}
    run["summary"] = RunData.load(rid, runid).summary()
    store.save_run(rid, runid, run)
    progress("Done", 1.0)


def _save_partial(rdir, arr: dict, scene_doc: dict, paths_out: list, done: int, total: int, first: bool) -> None:
    """Write the tallies of the passes so far (atomically: a reader sees the old or the new file, never half of one)."""
    import os

    part = dict(arr)
    part["accounted"] = arr["accounted"] / max(done, 1)
    tmp = rdir / "tallies.tmp.npz"
    np.savez(tmp, **part)
    if first:  # these do not change from pass to pass
        store.write_json(rdir / "scene.json", scene_doc)
        store.write_json(rdir / "paths.json", {"paths": paths_out})
    for attempt in range(60):  # Windows refuses to replace a file that a reader has open at this very moment: try again
        try:
            os.replace(tmp, rdir / "tallies.npz")
            break
        except PermissionError:
            if attempt == 59:
                raise
            time.sleep(0.05)
    store.write_json(rdir / "live.json", {"rays": int(done), "target": int(total), "t": time.time()})


def _channel_color(src) -> list[int]:
    from .engine import spectral

    xyz = spectral.xyz_of_spectrum(src.spec)
    rgb = spectral.xyz_to_srgb(xyz[None, :], white_y=float(xyz[1]) * 1.2)[0]
    return [int(round(float(c) * 255)) for c in np.clip(rgb, 0, 1)]
