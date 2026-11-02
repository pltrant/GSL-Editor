#!/usr/bin/env python3
"""EMERGENCY ONLY. FOR A PERSON AT A TERMINAL. AGENTS MUST NEVER RUN THIS SCRIPT, not even through a wrapper or
import.

Uploads local S#####.gsl files to GS4D (Dev) when Ctrl+U in VS Code is broken and an upload can't wait.
Usage: tools/emergency/emergency_dev_upload.py <S#####.gsl> [...]

This only checks that the repo's Dev upload CLI build exists and execs its `interactive` command, which owns every
guard, the login, the upload and the audit, written beside the login config (see "Dev Upload Tool" in the repo's
top-level README.md). Exit status: 2 this launcher refused; otherwise the CLI's.
"""

import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUNDLE = os.path.join(REPO, "gsl", "devUpload", "devUpload.bundle.js")  # built by `npm run compile`
CONFIG = os.path.expanduser("~/.gsl/loginConfig.upload.json")


def main(argv):
    if not os.path.isfile(BUNDLE):
        print(f"REFUSED: can't find {BUNDLE}; run `npm run compile` first", file=sys.stderr)
        return 2
    try:
        # `--` so a typed flag can't override the config. exec keeps the TTY and process ancestry the CLI's guards read.
        os.execvp("node", ["node", BUNDLE, "interactive", "--config", CONFIG, "--", *argv])
    except OSError as e:
        print(f"REFUSED: can't start node ({e})", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
