"""Test configuration: runs before any test module imports the app."""

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("LIGHTSIM_DATA", tempfile.mkdtemp(prefix="lightsim-test-"))
os.environ.setdefault("LIGHTSIM_CONFIG", tempfile.mkdtemp(prefix="lightsim-test-config-"))

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))
SAMPLES = ROOT / "samples"
