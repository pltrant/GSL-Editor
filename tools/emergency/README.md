# Emergency Dev scripts

Two Python scripts for a person at a terminal, for the day the editor's
Dev upload (Ctrl+U) is broken and the work can't wait. They are not part
of the extension, nothing imports them, and no agent (Claude Code, Codex
or anything like it) may run them, wrap them or call into them. Their own
guards refuse to run under an agent, without a terminal, or against
anything but `GS4D`. The guard that looks at the parent processes reads
`/proc`, so it only works on Linux and WSL.

`emergency_dev_upload.py` uploads local `S#####.gsl` files to Dev. It is a
launcher: it checks that `gsl/devUpload/devUpload.bundle.js` exists (run
`npm run compile` first) and execs that tool's `interactive` command,
which does the login, the checks, the typed confirmation and the audit.
The "Dev Upload Tool" section of the repo's top-level `README.md`
describes it.

`emergency_dev_thaw.py` thaws frozen scripts on Dev with
`/freeze thaw script <id>`, many at once. It logs in on its own
(standard library only) as the emergency uploader's account and prints a
summary of what was thawed, what wasn't frozen and what it wasn't allowed
to thaw. Its docstring has the details.

Both read the account and character from `~/.gsl/loginConfig.upload.json`
and the password from `GSL_PASSWORD` or a hidden prompt, and append an
audit log beside that config.

```sh
tools/emergency/emergency_dev_upload.py S12345.gsl S12346.gsl
tools/emergency/emergency_dev_thaw.py 12345 S12346 S12347.gsl
```

Exit status is 0 when everything went through and 1 when something
failed. The thaw script exits 2 when it refuses to start, and so does the
upload launcher when it can't find the bundle or `node`; once the upload
tool is running, a refusal exits 1 like any other failure.

The tests never touch a server (the thaw tests talk to fake servers on
socketpairs, and the upload tests mock `execvp`):

```sh
python3 -B -m unittest discover -s tools/emergency/tests
```
