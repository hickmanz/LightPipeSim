"""Design variants: legacy migration, per-variant setups, setup reconcile and comparison across variants."""

import time

import pytest
from fastapi.testclient import TestClient

from conftest import SAMPLES
from lightsim import setup_suggest, store


@pytest.fixture(scope="module")
def client():
    from lightsim.app import app

    return TestClient(app)


def _wait(client, url, done=("ready", "failed", "cancelled"), timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        meta = client.get(url).json()
        if meta["status"] in done:
            return meta
        time.sleep(0.5)
    raise AssertionError(f"timeout waiting for {url}")


def _upload(client, name, **form):
    with open(SAMPLES / name, "rb") as fh:
        res = client.post("/api/revisions", files={"file": (name, fh)}, data={"project_name": "Variants", **form})
    assert res.status_code == 200, res.text
    rid, pid = res.json()["id"], res.json()["projectId"]
    assert _wait(client, f"/api/revisions/{rid}")["status"] == "ready"
    return rid, pid


# -- storage ------------------------------------------------------------------------------
def test_legacy_project_is_migrated_to_one_baseline_variant():
    pid, rid = "a1b2c3d4e5f6", "f6e5d4c3b2a1"
    store.write_json(store.project_dir(pid) / "project.json", {"id": pid, "name": "Old", "stem": "old", "created": 1.0, "lastOpened": 1.0, "revisions": [rid]})
    store.write_json(store.project_dir(pid) / "setup.json", {"parts": [], "leds": [{"id": "led1"}], "states": [], "detectors": []})
    store.save_rev(rid, {"id": rid, "filename": "old.step", "created": 1.0, "status": "ready", "projectId": pid})
    try:
        project = store.load_project(pid)
        assert len(project["variants"]) == 1
        v = project["variants"][0]
        assert v["name"] == "Baseline" and v["revisions"] == [rid]
        assert store.load_setup(pid)["leds"] == [{"id": "led1"}]
        assert store.load_setup(pid, v["id"])["leds"] == [{"id": "led1"}]
        assert store.load_rev(rid)["variantId"] == v["id"]
        assert store.load_setup_for_rev(store.load_rev(rid))["leds"] == [{"id": "led1"}]
        assert store.load_project(pid)["variants"][0]["id"] == v["id"]  # migrating twice changes nothing
    finally:
        store.delete_project(pid)
        store.delete_revision(rid)


def test_variant_crud_and_independent_setups(client):
    pid = client.post("/api/projects", json={"name": "Crud"}).json()["id"]
    try:
        project = client.get(f"/api/projects/{pid}").json()
        assert [v["name"] for v in project["variants"]] == ["Baseline"]
        base = project["variants"][0]["id"]
        setup = {"parts": [], "leds": [{"id": "led1", "name": "LED:1"}], "states": [], "detectors": []}
        assert client.put(f"/api/projects/{pid}/variants/{base}/setup", json=setup).status_code == 200

        project = client.post(f"/api/projects/{pid}/variants", json={"name": "Pitch 8", "copyFrom": base}).json()
        other = next(v["id"] for v in project["variants"] if v["name"] == "Pitch 8")
        assert client.get(f"/api/projects/{pid}/variants/{other}/setup").json() == setup  # started as a copy
        edited = {**setup, "leds": []}
        client.put(f"/api/projects/{pid}/variants/{other}/setup", json=edited)
        assert client.get(f"/api/projects/{pid}/variants/{base}/setup").json() == setup  # the other variant is untouched
        assert client.get(f"/api/projects/{pid}/setup").json() == setup  # the legacy route is the first variant

        assert client.patch(f"/api/projects/{pid}/variants/{other}", json={"name": "Pitch 9"}).json()["variants"][1]["name"] == "Pitch 9"
        assert client.post(f"/api/projects/{pid}/variants", json={"copyFrom": "nope"}).status_code == 404
        assert client.delete(f"/api/projects/{pid}/variants/{other}").status_code == 200
        assert client.get(f"/api/projects/{pid}/variants/{other}/setup").status_code == 404
        assert client.delete(f"/api/projects/{pid}/variants/{base}").status_code == 400  # the last variant stays
    finally:
        client.delete(f"/api/projects/{pid}")


# -- reconcile ----------------------------------------------------------------------------
def _inst(name, ordinal):
    return {"ordinal": ordinal, "id": f"i{ordinal}", "name": name, "path": f"asm/{name}", "partName": name}


def _sug_led(k, part):
    sig = {"centroid": [10.0 * k, 0, 0], "normal": [0, 0, 1], "area": 4}
    return {"id": f"led{k}", "name": part, "model": "white_generic", "placement": {"type": "face", "part": part, "face": 5, "sig": sig}}


def test_reconcile_follows_a_changed_led_count():
    old = {
        "parts": [{"match": "*", "finish": "black"}, {"match": "Light Pipe:1", "material": "pc_tio2_0p03", "finish": "polished"}],
        "leds": [{**_sug_led(k, f"LED:{k}"), "model": "custom_led"} for k in (1, 2, 3, 4, 5)],
        "detectors": [{"id": "exit", "name": "Exit", "faces": [{"part": "Light Pipe:1", "face": 4}]}],
        "states": [{"id": "all", "name": "All", "drive": {"*": 1.0}}, {"id": "only_led5", "name": "LED:5 only", "drive": {"led5/*": 1.0}}, {"id": "dim", "name": "Dim", "drive": {"*": 0.5}}],
    }
    # the new geometry has 3 LEDs, one of them new (LED:6), plus a new reflector part
    insts = [_inst("Light Pipe:1", 0), _inst("LED:1", 1), _inst("LED:2", 2), _inst("LED:6", 3), _inst("New Reflector:1", 4)]
    suggestion = {
        "parts": [{"match": "*", "finish": "black"}, {"match": "New Reflector:1", "finish": "white_diffuse"}, {"match": "Light Pipe:1", "material": "pc_tio2_0p03"}],
        "leds": [_sug_led(1, "LED:1"), _sug_led(2, "LED:2"), _sug_led(3, "LED:6")],
        "detectors": [],
        "states": [],
    }
    new, warnings = setup_suggest.reconcile(old, suggestion, insts)

    assert [l["name"] for l in new["leds"]] == ["LED:1", "LED:2", "LED:6"]
    assert {l["model"] for l in new["leds"]} == {"custom_led"}  # the model the others use, not the suggestion's default
    assert len({l["id"] for l in new["leds"]}) == 3
    ids = {s["id"] for s in new["states"]}
    assert {"all", "dim"} <= ids  # kept
    assert "only_led5" not in ids  # its LED is gone
    assert {f"only_{l['id']}" for l in new["leds"]} <= ids  # regenerated for the LEDs that exist now
    assert any(r["match"] == "New Reflector:1" for r in new["parts"])  # the new part got its suggested rule
    assert [r for r in new["parts"] if r["match"] == "Light Pipe:1"] == [old["parts"][1]]  # the user's rule is kept
    assert any("LED:3" in w for w in warnings) and any("LED:6" in w for w in warnings)
    assert old["leds"][2]["name"] == "LED:3"  # the input is not modified


def test_reconcile_replaces_a_detector_whose_part_is_gone():
    old = {"parts": [], "leds": [], "states": [], "detectors": [{"id": "exit", "name": "Exit", "faces": [{"part": "Old Pipe", "face": 1}]}]}
    insts = [_inst("New Pipe", 0)]
    sug_det = {"id": "exit", "name": "Exit surface", "faces": [{"part": "New Pipe", "face": 3}]}
    new, warnings = setup_suggest.reconcile(old, {"parts": [], "leds": [], "detectors": [sug_det], "states": []}, insts)
    assert new["detectors"][0]["faces"] == [{"part": "New Pipe", "face": 3}]
    assert any("Detector" in w for w in warnings)


# -- end to end: variants on real geometry and comparison across them --------------------------
@pytest.fixture(scope="module")
def two_variants(client):
    rid_a, pid = _upload(client, "lightbar_a.step")
    sug = client.post(f"/api/revisions/{rid_a}/suggest-setup").json()
    setup = {k: sug[k] for k in ("parts", "leds", "detectors", "states")}
    base = client.get(f"/api/projects/{pid}").json()["variants"][0]["id"]
    assert client.put(f"/api/projects/{pid}/variants/{base}/setup", json=setup).status_code == 200

    rid_b, pid_b = _upload(client, "lightbar_b.step", project_id=pid, variant_id="new", variant_name="Alternative", copy_setup_from=base)
    assert pid_b == pid
    yield {"pid": pid, "a": rid_a, "b": rid_b, "base": base, "setup": setup}
    client.delete(f"/api/projects/{pid}")


def test_upload_into_a_new_variant(client, two_variants):
    project = client.get(f"/api/projects/{two_variants['pid']}").json()
    assert [v["name"] for v in project["variants"]] == ["Baseline", "Alternative"]
    alt = project["variants"][1]
    assert alt["revisions"] == [two_variants["b"]] and project["variants"][0]["revisions"] == [two_variants["a"]]
    assert client.get(f"/api/revisions/{two_variants['b']}").json()["variantId"] == alt["id"]
    assert client.get(f"/api/projects/{two_variants['pid']}/variants/{alt['id']}/setup").json() == two_variants["setup"]
    # a revision uploaded into a given variant joins it
    rid_c, _ = _upload(client, "lightbar_a.step", project_id=two_variants["pid"], variant_id=alt["id"])
    project = client.get(f"/api/projects/{two_variants['pid']}").json()
    assert project["variants"][1]["revisions"] == [two_variants["b"], rid_c]
    bad = client.post("/api/revisions", files={"file": ("x.step", b"x")}, data={"project_id": two_variants["pid"], "variant_id": "nope"})
    assert bad.status_code == 404


def test_reconcile_endpoint_keeps_a_valid_setup(client, two_variants):
    res = client.post(f"/api/revisions/{two_variants['b']}/reconcile-setup")
    assert res.status_code == 200, res.text
    out = res.json()
    assert not out["fromSuggestion"] and out["setup"]["leds"] and out["setup"]["detectors"]
    check = client.post(f"/api/revisions/{two_variants['b']}/check", json=out["setup"])
    assert check.status_code == 200, check.text


def _run(client, rid, rays=20_000):
    res = client.post(f"/api/revisions/{rid}/runs", json={"settings": {"rays": rays}})
    assert res.status_code == 200, res.text
    runid = res.json()["id"]
    assert _wait(client, f"/api/runs/{runid}")["status"] == "ready"
    return runid


def test_runs_use_their_variants_setup_and_compare_across_variants(client, two_variants):
    pid = two_variants["pid"]
    alt = client.get(f"/api/projects/{pid}").json()["variants"][1]["id"]
    # the alternative loses the per-LED states: only "All LEDs on" is left
    reduced = {**two_variants["setup"], "states": [s for s in two_variants["setup"]["states"] if s["id"] == "all"]}
    assert client.put(f"/api/projects/{pid}/variants/{alt}/setup", json=reduced).status_code == 200

    ra, rb = _run(client, two_variants["a"]), _run(client, two_variants["b"])
    a, b = client.get(f"/api/runs/{ra}").json(), client.get(f"/api/runs/{rb}").json()
    assert a["variantId"] == two_variants["base"] and b["variantId"] == alt
    # each run carries the states of its own variant's setup
    assert client.get(f"/api/runs/{ra}/results", params={"state": "only_led1"}).json()["state"]["id"] == "only_led1"
    assert [s["id"] for s in client.get(f"/api/runs/{rb}/scene").json()["states"]] == ["all"]

    cmp = client.get(f"/api/projects/{pid}/compare", params={"runs": f"{ra},{rb}", "state": "only_led1"})
    assert cmp.status_code == 200, cmp.text
    doc = cmp.json()
    assert [r["runId"] for r in doc["runs"]] == [ra, rb] and doc["unit"]
    first, second = doc["runs"]
    assert first["variant"] == "Baseline" and second["variant"] == "Alternative"
    assert first["state"]["id"] == "only_led1" and not first["stateFallback"]
    assert second["state"]["id"] == "all" and second["stateFallback"]  # falls back to "all" for the variant that lacks the state
    assert first["efficiency"] > 0 and second["efficiency"] > 0 and second["uExtentMm"] > 0

    assert client.get(f"/api/projects/{pid}/compare", params={"runs": ra}).status_code == 400
    assert client.get(f"/api/projects/{pid}/compare", params={"runs": f"{ra},{ra}"}).status_code == 400
    assert client.get(f"/api/projects/{pid}/compare", params={"runs": f"{ra},nope"}).status_code == 404
    assert client.get(f"/api/projects/{pid}/compare", params={"runs": f"{ra},{rb}", "detector": 5}).json()["runs"][0]["error"]
