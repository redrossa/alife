import hashlib
from pathlib import Path
import tempfile
import unittest

from changes import diff_arguments, select_checks
from verify_acceptance import verify


class ChangeSelection(unittest.TestCase):
    def test_runtime_does_not_build_website(self):
        self.assertEqual(select_checks(["runtime/src/cli.ts"]), {"runtime": True, "website": False})

    def test_docs_and_website_build_website(self):
        for name in ("docs/(introduction)/architecture.mdx", "www/package-lock.json"):
            self.assertEqual(select_checks([name]), {"runtime": False, "website": True})

    def test_plans_verify_runtime_contracts(self):
        self.assertEqual(select_checks([".plans/phase-5-acceptance-manifest.json"]), {"runtime": True, "website": False})

    def test_shared_and_workflow_changes_run_both(self):
        for name in ("package-lock.json", "AGENTS.md", ".gitignore", ".github/workflows/ci.yml", ".github/scripts/changes.py"):
            self.assertEqual(select_checks([name]), {"runtime": True, "website": True})

    def test_unrelated_paths_skip_expensive_jobs(self):
        self.assertEqual(select_checks(["README.md", "assets/source.svg"]), {"runtime": False, "website": False})

    def test_renamed_or_deleted_sources_select_original_package(self):
        self.assertEqual(select_checks(["www/public/old.svg", "assets/new.svg"]), {"runtime": False, "website": True})

    def test_dispatch_and_initial_push_select_all(self):
        self.assertIsNone(diff_arguments("workflow_dispatch", {}))
        self.assertIsNone(diff_arguments("push", {"before": "0" * 40}))

    def test_diff_is_shell_free_and_includes_deleted_paths(self):
        sha = "a" * 40
        for event, data in (("push", {"before": sha}), ("pull_request", {"pull_request": {"base": {"sha": sha}}})):
            self.assertEqual(diff_arguments(event, data), ["git", "diff", "--name-only", "--no-renames", "-z", sha, "HEAD", "--"])

    def test_unrecognized_event_or_bad_base_fails_closed(self):
        for event, data in (("push", {"before": "--help"}), ("pull_request_target", {}), ("push", {"before": ""})):
            with self.assertRaises(ValueError):
                diff_arguments(event, data)


class AcceptanceInventory(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / "runtime/test/example.ts"
        self.file.parent.mkdir(parents=True)
        self.file.write_bytes(b"offline fixture\n")
        self.entry = {"path": "runtime/test/example.ts", "sha256": hashlib.sha256(self.file.read_bytes()).hexdigest(), "bytes": self.file.stat().st_size}
        self.manifest = {"files": [self.entry], "unchangedPriorGate": [], "evidence": [{"path": "/not-distributed.log"}]}

    def test_hash_and_size_without_private_evidence(self):
        self.assertEqual(verify(self.root, self.manifest), 1)

    def test_changed_or_missing_test_fails(self):
        self.file.write_text("changed")
        with self.assertRaises(ValueError):
            verify(self.root, self.manifest)
        self.file.unlink()
        with self.assertRaises(FileNotFoundError):
            verify(self.root, self.manifest)

    def test_invalid_size_duplicate_empty_or_escaping_inventory_fails(self):
        cases = [
            {"files": [{**self.entry, "bytes": 0}], "unchangedPriorGate": []},
            {"files": [self.entry], "unchangedPriorGate": [self.entry]},
            {"files": [], "unchangedPriorGate": []},
            {"files": [{**self.entry, "path": "../outside"}], "unchangedPriorGate": []},
        ]
        for manifest in cases:
            with self.assertRaises(ValueError):
                verify(self.root, manifest)

    def test_symlink_is_not_a_frozen_regular_file(self):
        target = self.root / "target"
        target.write_bytes(self.file.read_bytes())
        self.file.unlink()
        self.file.symlink_to(target)
        with self.assertRaises(ValueError):
            verify(self.root, self.manifest)


if __name__ == "__main__":
    unittest.main()
