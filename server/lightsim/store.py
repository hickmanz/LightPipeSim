"""File-based storage.

Layout inside the data folder (default ``%LOCALAPPDATA%/lightsim``, override with ``LIGHTSIM_DATA``)::

    projects/<pid>/project.json     name, revisions (all, oldest first), variants (design alternatives, each listing its revisions)
    projects/<pid>/setups/<vid>.json  LED / part / state / detector setup of one variant, shared by that variant's revisions
    projects/<pid>/setup.json       legacy single setup; copied to the first variant when an old project is opened
    revisions/<rid>/source.step     the uploaded CAD
    revisions/<rid>/meta.json       import status
    revisions/<rid>/model.glb|json  viewer model
    revisions/<rid>/optical.npz|json  fine optical mesh
    revisions/<rid>/runs/<runid>/   run.json (status, setup snapshot, metrics) + tallies
    library.json                    user materials / finishes / LEDs (built-ins live in code)
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1


def config_dir() -> Path:
    """Always local to this machine and user: holds config.json (the data-folder setting)."""
    if os.environ.get("LIGHTSIM_CONFIG"):
        base = Path(os.environ["LIGHTSIM_CONFIG"])
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "lightsim"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "lightsim"
    base.mkdir(parents=True, exist_ok=True)
    return base


def default_data_dir() -> Path:
    return config_dir()


def env_data_dir() -> str | None:
    return os.environ.get("LIGHTSIM_DATA") or None


def _read_config() -> dict:
    try:
        return json.loads((config_dir() / "config.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _write_config(cfg: dict) -> None:
    tmp = config_dir() / "config.json.tmp"
    tmp.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    os.replace(tmp, config_dir() / "config.json")


_configured_dir: str | None = _read_config().get("dataDir") or None
_ensured: set[str] = set()
_ensure_lock = threading.Lock()


def configured_data_dir() -> str | None:
    return _configured_dir


def data_dir() -> Path:
    """Environment variable > settings > default."""
    base = Path(env_data_dir() or _configured_dir or default_data_dir())
    key = str(base)
    if key not in _ensured:
        with _ensure_lock:
            (base / "revisions").mkdir(parents=True, exist_ok=True)
            (base / "projects").mkdir(parents=True, exist_ok=True)
            _ensured.add(key)
    return base


def set_data_dir(path: str | None) -> None:
    global _configured_dir
    cfg = _read_config()
    if path:
        cfg["dataDir"] = path
    else:
        cfg.pop("dataDir", None)
    _write_config(cfg)
    _configured_dir = path or None


def validate_data_dir(path: str) -> Path:
    p = Path(path).expanduser()
    if not p.is_absolute():
        raise ValueError("Please give a full path such as D:\\LightSim")
    try:
        (p / "revisions").mkdir(parents=True, exist_ok=True)
        probe = p / f".write-test-{uuid.uuid4().hex[:8]}"
        probe.write_text("ok", encoding="utf-8")
        if probe.read_text(encoding="utf-8") != "ok":
            raise OSError("read-back mismatch")
        probe.unlink()
    except OSError as exc:
        raise ValueError(f"Cannot read and write in that folder: {exc}") from exc
    return p


def copy_data(src: Path, dst: Path) -> int:
    copied = 0
    if src.resolve() == dst.resolve():
        return 0
    for sub in ("projects", "revisions"):
        s, d = src / sub, dst / sub
        if not s.is_dir():
            continue
        d.mkdir(parents=True, exist_ok=True)
        for item in s.iterdir():
            if not item.is_dir() or (d / item.name).exists():
                continue
            shutil.copytree(item, d / item.name, ignore=shutil.ignore_patterns("*.tmp"))
            copied += 1
    lib = src / "library.json"
    if lib.exists() and not (dst / "library.json").exists():
        shutil.copy2(lib, dst / "library.json")
    rays = src / "rays"
    if rays.is_dir():
        (dst / "rays").mkdir(parents=True, exist_ok=True)
        for f in rays.glob("*.npy"):
            if not (dst / "rays" / f.name).exists():
                shutil.copy2(f, dst / "rays" / f.name)
    return copied


SESSION_ID = uuid.uuid4().hex  # one per running server process


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, data: Any) -> None:
    """Atomic JSON write (readers never see a partial file)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # a reader holds the file briefly on Windows
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def _check_id(value: str) -> str:
    if not value.isalnum():
        raise ValueError("invalid id")
    return value


# -- revisions ---------------------------------------------------------------------------
def revisions_dir() -> Path:
    return data_dir() / "revisions"


def rev_dir(rid: str) -> Path:
    return revisions_dir() / _check_id(rid)


def load_rev(rid: str) -> dict | None:
    return read_json(rev_dir(rid) / "meta.json")


def save_rev(rid: str, meta: dict) -> None:
    write_json(rev_dir(rid) / "meta.json", meta)


def list_revisions() -> list[dict]:
    out = []
    for d in revisions_dir().iterdir():
        if d.is_dir():
            meta = read_json(d / "meta.json")
            if meta:
                out.append(meta)
    out.sort(key=lambda m: m.get("created", 0), reverse=True)
    return out


def delete_revision(rid: str) -> None:
    meta = load_rev(rid) or {}
    pid = meta.get("projectId")
    shutil.rmtree(rev_dir(rid), ignore_errors=True)
    if pid:
        proj = load_project(pid)
        if proj is not None:
            proj["revisions"] = [r for r in proj.get("revisions", []) if r != rid]
            for v in proj.get("variants", []):
                v["revisions"] = [r for r in v.get("revisions", []) if r != rid]
            save_project(proj)


# -- runs --------------------------------------------------------------------------------
def runs_dir(rid: str) -> Path:
    d = rev_dir(rid) / "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def run_dir(rid: str, runid: str) -> Path:
    return runs_dir(rid) / _check_id(runid)


def load_run(rid: str, runid: str) -> dict | None:
    return read_json(run_dir(rid, runid) / "run.json")


def save_run(rid: str, runid: str, run: dict) -> None:
    write_json(run_dir(rid, runid) / "run.json", run)


def list_runs(rid: str) -> list[dict]:
    out = []
    for d in runs_dir(rid).iterdir():
        if d.is_dir():
            run = read_json(d / "run.json")
            if run and run.get("id") and run.get("revisionId"):  # a stub left by a run that was deleted while it ran is not a run
                out.append(run)
    out.sort(key=lambda r: r.get("created", 0), reverse=True)
    return out


def delete_run(rid: str, runid: str) -> None:
    shutil.rmtree(run_dir(rid, runid), ignore_errors=True)


def find_run(runid: str) -> dict | None:
    """Runs are addressed by id alone in the API; the run document records its revision."""
    _check_id(runid)
    for d in revisions_dir().iterdir():
        if (d / "runs" / runid / "run.json").exists():
            run = read_json(d / "runs" / runid / "run.json")
            if run and run.get("id"):
                return run
    return None


# -- projects ----------------------------------------------------------------------------
def projects_dir() -> Path:
    d = data_dir() / "projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_dir(pid: str) -> Path:
    return projects_dir() / _check_id(pid)


def load_project(pid: str) -> dict | None:
    project = read_json(project_dir(pid) / "project.json")
    if project is not None and "variants" not in project:
        project = _migrate_to_variants(project)
    return project


def save_project(project: dict) -> None:
    write_json(project_dir(project["id"]) / "project.json", project)


def list_projects() -> list[dict]:
    out = []
    for d in projects_dir().iterdir():
        if d.is_dir():
            p = read_json(d / "project.json")
            if p:
                if "variants" not in p:
                    p = _migrate_to_variants(p)
                out.append(p)
    out.sort(key=lambda p: p.get("lastOpened", p.get("created", 0)), reverse=True)
    return out


def stem_of(filename: str) -> str:
    return Path(filename).stem.lower()


def find_project_by_stem(stem: str) -> dict | None:
    for p in list_projects():
        if p.get("stem") == stem:
            return p
    return None


def create_project(name: str) -> dict:
    now = time.time()
    project = {
        "id": new_id(),
        "name": name,
        "stem": stem_of(name),
        "created": now,
        "lastOpened": now,
        "revisions": [],
        "variants": [{"id": new_id(), "name": DEFAULT_VARIANT_NAME, "created": now, "revisions": []}],
    }
    save_project(project)
    return project


# -- variants (design alternatives of a project) ---------------------------------------------
DEFAULT_VARIANT_NAME = "Baseline"


def _migrate_to_variants(project: dict) -> dict:
    """Projects made before variants existed: one "Baseline" variant holding every revision and the old setup."""
    pid = project["id"]
    now = time.time()
    revs = list(project.get("revisions", []))
    variant = {"id": new_id(), "name": DEFAULT_VARIANT_NAME, "created": project.get("created", now), "revisions": revs}
    project["variants"] = [variant]
    old = read_json(project_dir(pid) / "setup.json")
    if old is not None:
        write_json(setups_dir(pid) / f"{variant['id']}.json", old)
    for rid in revs:
        meta = load_rev(rid)
        if meta is not None and meta.get("variantId") != variant["id"]:
            meta["variantId"] = variant["id"]
            save_rev(rid, meta)
    save_project(project)
    return project


def setups_dir(pid: str) -> Path:
    return project_dir(pid) / "setups"


def find_variant(project: dict, vid: str | None) -> dict | None:
    """The variant with this id; the project's first variant when ``vid`` is empty."""
    variants = project.get("variants", [])
    if not vid:
        return variants[0] if variants else None
    for v in variants:
        if v["id"] == vid:
            return v
    return None


def variant_of_rev(project: dict, meta: dict) -> dict | None:
    """The variant a revision belongs to (older revision files without a variantId belong to the first one)."""
    return find_variant(project, meta.get("variantId")) or find_variant(project, None)


def create_variant(pid: str, name: str, copy_from: str | None = None) -> dict:
    """New empty variant; with ``copy_from`` it starts with a copy of that variant's setup."""
    project = load_project(pid)
    if project is None:
        raise KeyError(pid)
    src = None
    if copy_from:
        src = find_variant(project, copy_from)
        if src is None:
            raise KeyError(copy_from)
    variant = {"id": new_id(), "name": name, "created": time.time(), "revisions": []}
    project["variants"].append(variant)
    save_project(project)
    if src is not None:
        setup = load_setup(pid, src["id"])
        if setup is not None:
            save_setup(pid, setup, variant["id"])
    return variant


def rename_variant(pid: str, vid: str, name: str) -> dict:
    project = load_project(pid)
    variant = find_variant(project, vid) if project else None
    if variant is None:
        raise KeyError(vid)
    variant["name"] = name
    save_project(project)
    return variant


def delete_variant(pid: str, vid: str) -> list[str]:
    """Remove a variant with its revisions and setup; returns the removed revision ids (the last variant cannot go)."""
    project = load_project(pid)
    variant = find_variant(project, vid) if project else None
    if variant is None:
        raise KeyError(vid)
    if len(project["variants"]) <= 1:
        raise ValueError("a project needs at least one variant")
    gone = list(variant.get("revisions", []))
    for rid in gone:
        shutil.rmtree(rev_dir(rid), ignore_errors=True)
    project["variants"] = [v for v in project["variants"] if v["id"] != vid]
    project["revisions"] = [r for r in project.get("revisions", []) if r not in gone]
    save_project(project)
    (setups_dir(pid) / f"{_check_id(vid)}.json").unlink(missing_ok=True)
    return gone


def add_revision(pid: str, rid: str, vid: str | None = None) -> None:
    project = load_project(pid)
    if project is None:
        raise KeyError(pid)
    variant = find_variant(project, vid)
    if variant is None:
        raise KeyError(vid)
    if rid not in project["revisions"]:
        project["revisions"].append(rid)
    if rid not in variant["revisions"]:
        variant["revisions"].append(rid)
    meta = load_rev(rid)
    if meta is not None and meta.get("variantId") != variant["id"]:
        meta["variantId"] = variant["id"]
        save_rev(rid, meta)
    project["lastOpened"] = time.time()
    save_project(project)


def touch_project(pid: str) -> None:
    project = load_project(pid)
    if project:
        project["lastOpened"] = time.time()
        save_project(project)


def delete_project(pid: str) -> None:
    project = load_project(pid)
    if project:
        for rid in project.get("revisions", []):
            shutil.rmtree(rev_dir(rid), ignore_errors=True)
    shutil.rmtree(project_dir(pid), ignore_errors=True)


def _setup_variant_id(pid: str, vid: str | None) -> str:
    project = load_project(pid)
    variant = find_variant(project, vid) if project else None
    if variant is None:
        raise KeyError(vid or pid)
    return variant["id"]


def load_setup(pid: str, vid: str | None = None) -> dict | None:
    """Setup of a variant (the project's first variant when ``vid`` is empty)."""
    return read_json(setups_dir(pid) / f"{_check_id(_setup_variant_id(pid, vid))}.json")


def save_setup(pid: str, setup: dict, vid: str | None = None) -> None:
    write_json(setups_dir(pid) / f"{_check_id(_setup_variant_id(pid, vid))}.json", setup)


def load_setup_for_rev(meta: dict) -> dict | None:
    """The setup that applies to a revision: the one of its variant."""
    pid = meta["projectId"]
    project = load_project(pid)
    variant = variant_of_rev(project, meta) if project else None
    return load_setup(pid, variant["id"]) if variant else None


# -- library -----------------------------------------------------------------------------
def library_path() -> Path:
    return data_dir() / "library.json"


def load_user_library() -> dict:
    lib = read_json(library_path(), {}) or {}
    for kind in ("materials", "finishes", "leds"):
        lib.setdefault(kind, {})
    return lib


def save_user_library(lib: dict) -> None:
    write_json(library_path(), lib)
