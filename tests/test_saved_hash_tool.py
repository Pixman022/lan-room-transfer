"""Offline, saved-file SHA-256 acceptance helper smoke tests.

These use harmless temporary files and cannot substitute for actual saved
browser downloads from separate physical devices.
"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "verify-field-hashes.ps1"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell.exe")


@unittest.skipUnless(POWERSHELL, "PowerShell not installed locally")
class OfflineSavedHashToolTests(unittest.TestCase):
    def run_checker(self, *args):
        return subprocess.run(
            [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(SCRIPT), *map(str, args)],
            capture_output=True, text=True, timeout=30, check=False,
        )

    def test_no_files_supplied_is_partial_not_a_false_pass(self):
        result = self.run_checker()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("pending=5", result.stdout)
        self.assertIn("RESULT: PARTIAL", result.stdout)

    def test_actual_zero_byte_saved_file_matches_even_when_renamed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "A_empty_0B(1).bin"
            path.write_bytes(b"")
            result = self.run_checker("-C0B", path, "-RunLabel", "qa-round-1")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("PASS    C-0B", result.stdout)
        self.assertIn("sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", result.stdout)
        self.assertIn("passed=1 failed=0 pending=4", result.stdout)
        self.assertIn("operator supplied; not verified", result.stdout)
        self.assertNotIn(str(path.parent), result.stdout)

    def test_corrupted_nonempty_file_fails_size_and_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "A_empty_0B.bin"
            path.write_bytes(b"X")
            result = self.run_checker("-C0B", path)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("FAIL    C-0B", result.stdout)
        self.assertIn("bytes=1 expectedBytes=0", result.stdout)
        self.assertIn("RESULT: FAIL", result.stdout)

    def test_missing_saved_file_fails_without_exposing_path(self):
        with tempfile.TemporaryDirectory() as folder:
            missing = Path(folder) / "secret-private-file.bin"
            result = self.run_checker("-AFromB", missing)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ERROR   A-from-B", result.stdout)
        self.assertNotIn(str(missing), result.stdout)
        self.assertIn("RESULT: FAIL", result.stdout)

    def test_provided_invalid_fixture_does_not_turn_into_partial_pass(self):
        with tempfile.TemporaryDirectory() as folder:
            valid = Path(folder) / "empty.bin"
            invalid = Path(folder) / "wrong.bin"
            valid.write_bytes(b"")
            invalid.write_bytes(b"wrong-content")
            result = self.run_checker("-C0B", valid, "-C64KiB", invalid)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("PASS    C-0B", result.stdout)
        self.assertIn("FAIL    C-64KiB", result.stdout)
        self.assertIn("passed=1 failed=1 pending=3", result.stdout)


if __name__ == "__main__":
    unittest.main()
