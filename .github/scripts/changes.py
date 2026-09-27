"""Select offline checks without suppressing the workflow's required check."""

import json
import os
from pathlib import Path
import re
import subprocess


SHARED = {"package.json", "package-lock.json", "AGENTS.md", ".gitignore"}


def select_checks(paths):
    runtime = website = False
    for name in paths:
        if name in SHARED or name.startswith(".github/"):
            runtime = website = True
        if name.startswith(("runtime/", ".plans/")):
            runtime = True
        if name.startswith(("www/", "docs/")):
            website = True
    return {"runtime": runtime, "website": website}


def diff_arguments(event_name, event):
    if event_name == "workflow_dispatch":
        return None
    if event_name == "pull_request":
        base = event["pull_request"]["base"]["sha"]
    elif event_name == "push":
        base = event["before"]
    else:
        raise ValueError(f"Unsupported event: {event_name}")
    if not isinstance(base, str) or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", base):
        raise ValueError("Expected a base commit SHA")
    if set(base) == {"0"}:
        return None
    # HEAD is checkout's PR merge commit (or pushed main commit). Include both
    # sides of renames/deletions, with NUL framing for arbitrary filenames.
    return ["git", "diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"]


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    arguments = diff_arguments(os.environ["GITHUB_EVENT_NAME"], event)
    if arguments is None:
        selected = {"runtime": True, "website": True}
    else:
        output = subprocess.check_output(arguments)
        paths = [name.decode("utf-8", errors="surrogateescape") for name in output.split(b"\0") if name]
        selected = select_checks(paths)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as target:
        for name, enabled in selected.items():
            value = str(enabled).lower()
            print(f"{name}: {value}")
            target.write(f"{name}={value}\n")


if __name__ == "__main__":
    main()
