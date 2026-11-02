"""Unit tests for tools/emergency/emergency_dev_upload.py, the launcher.
Run: python3 -B -m unittest discover -s tools/emergency/tests

os.execvp is always mocked, so nothing here starts the bundle or touches a server.
"""

import contextlib
import io
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import emergency_dev_upload as up  # noqa: E402

SHIPPED_BUNDLE = up.BUNDLE  # captured before setUp patches in the stand-in


class LauncherTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(up.os, "execvp")
        self.execvp = patcher.start()
        self.addCleanup(patcher.stop)
        # A stand-in bundle, so the tests pass before `npm run compile` has run and never touch the real build.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.bundle = os.path.join(tmp.name, "devUpload.bundle.js")
        with open(self.bundle, "wb") as f:
            f.write(b"// stand-in\n")
        bundle = mock.patch.object(up, "BUNDLE", self.bundle)
        bundle.start()
        self.addCleanup(bundle.stop)

    def run_main(self, argv):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = up.main(argv)
        return code, err.getvalue()

    def argv(self, files):
        return ["node", self.bundle, "interactive", "--config", os.path.expanduser("~/.gsl/loginConfig.upload.json"),
                "--", *files]

    def test_execs_the_cli_with_the_fixed_config(self):
        code, err = self.run_main(["S12345.gsl", "S2.gsl"])
        self.execvp.assert_called_once_with("node", self.argv(["S12345.gsl", "S2.gsl"]))
        self.assertIsNone(code)
        self.assertEqual(err, "")

    def test_typed_flags_stay_behind_the_double_dash(self):
        files = ["--config", "/tmp/other.json", "--audit-log=/tmp/a"]
        self.run_main(files)
        self.execvp.assert_called_once_with("node", self.argv(files))

    def test_no_files_leaves_the_refusal_to_the_cli(self):
        self.run_main([])
        self.execvp.assert_called_once_with("node", self.argv([]))

    def test_missing_bundle_refused(self):
        with mock.patch.object(up, "BUNDLE", os.path.join(HERE, "no-such-bundle.js")):
            code, err = self.run_main(["S1.gsl"])
        self.assertEqual(code, 2)
        self.assertIn("can't find", err)
        self.assertIn("npm run compile", err)
        self.execvp.assert_not_called()

    def test_missing_node_refused(self):
        self.execvp.side_effect = FileNotFoundError("node")
        code, err = self.run_main(["S1.gsl"])
        self.assertEqual(code, 2)
        self.assertIn("can't start node", err)

    def test_bundle_is_the_repo_build_output(self):
        self.assertTrue(os.path.isfile(os.path.join(up.REPO, "package.json")), up.REPO)
        self.assertEqual(SHIPPED_BUNDLE, os.path.join(up.REPO, "gsl", "devUpload", "devUpload.bundle.js"))


if __name__ == "__main__":
    unittest.main()
