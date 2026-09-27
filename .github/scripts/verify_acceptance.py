"""Verify the tracked offline handoff, without requiring private evidence logs."""

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / ".plans/phase-5-acceptance-manifest.json"


def verify(root, manifest):
    root = root.resolve()
    seen = set()
    files = manifest["files"] + manifest["unchangedPriorGate"]
    if not files:
        raise ValueError("Empty acceptance inventory")
    for entry in files:
        relative = Path(entry["path"])
        if relative.is_absolute() or ".." in relative.parts or relative.parts[:2] != ("runtime", "test"):
            raise ValueError(f"Invalid acceptance path: {relative}")
        if relative in seen:
            raise ValueError(f"Duplicate acceptance path: {relative}")
        seen.add(relative)
        file = root / relative
        if file.is_symlink() or not file.resolve().is_relative_to(root):
            raise ValueError(f"Acceptance path escapes checkout or is a symlink: {relative}")
        content = file.read_bytes()
        if hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise ValueError(f"Acceptance hash mismatch: {relative}")
        if "bytes" in entry and len(content) != entry["bytes"]:
            raise ValueError(f"Acceptance size mismatch: {relative}")
    return len(files)


def main():
    count = verify(ROOT, json.loads(MANIFEST.read_text()))
    print(f"All {count} frozen acceptance/helper hashes match")


if __name__ == "__main__":
    main()
