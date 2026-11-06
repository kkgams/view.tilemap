"""Validate the local development Project without downloading or launching Units."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
config = json.loads((ROOT / "gams.json").read_text())
manifest = json.loads((ROOT / "release.json").read_text())
views = config["ui"]["views"]
assert set(config["ui"]["services"]) == {
    "ui-context", "ui-keys", "ui-toast", "ui-popup", "ui-tooltip", "ui-layout"
}
for unit in manifest["packages"]:
    source = next(path for path, target in unit["files"].items() if target == unit["entry"])
    assert views[unit["tag"]]["url"] == source
    assert (ROOT / source).is_file(), source
for entry in [config["ui"]["theme"], *config["ui"]["services"].values()]:
    assert entry["url"].startswith("https://github.com/kkgams/")
    assert "/releases/download/v" in entry["url"]
for source in config["plugins"]:
    assert source.startswith("https://github.com/kkgams/")
    assert "/releases/download/v" in source

if "--require-inputs" in sys.argv:
    paths = []
    if "view-tree" in views:
        tree = views["view-tree"]["config"]
        paths = [tree["text"]["source"]["metaUrl"], tree["text"]["source"]["atlasUrl"]]
        paths += [entry["textureUrl"] for entry in tree["nineSlices"].values()]
    if "view-vox" in views:
        paths = [views["view-vox"]["defaultSource"]]
    for path in paths:
        local = (ROOT / path).resolve()
        if not local.is_relative_to(ROOT):
            sys.exit(f"Input must stay within this Project: {path}")
        if not local.is_file():
            sys.exit(f"Missing required development input: {path}; see docs/index.md")
print("Local Project configuration OK")
