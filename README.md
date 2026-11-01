# Description

The GSL Editor is an extension for the GemStone Language for Simutronics' Interactive Fiction Engine games.

## Features

* Function to automatically download or upload scripts.
* Syntax highlighting
* Auto Indentation
* Snippets for every GSL command
* Go to/Peak Definitions (matchmarkers)
* Outline view to see every matchmarker within a script and ability to click to go to directly to that line.
* Ability to diff scripts across instances
* Agent support (GitHub Copilot, Claude Code, Codex CLI, etc.)

## Setup

Setup instructions can be found [here](https://github.com/pltrant/GSL-Editor/blob/master/setup.md).

## Deploy and Rollin

Run **GSL: Deploy and Rollin Scripts**, choose a configured origin and targets,
then enter script IDs, filenames, ranges, or verb names: `29, incant, s07890.gsl, 9800-9805`.
Every participant needs an instance and character configured through **GSL: User Setup**.

The command opens split game terminals, reusing the origin terminal when open.
Review the queued commands and click **Start rollout**. All items deploy in input
order before rolling into each target in turn. Commands include `confirm` and
wait for server completion; duplicates are removed. This deploys the server's
version, so upload and compile local changes first. Verb names are limited to
seven characters, including any leading slash.

After all rollins succeed, Dev runs `/ss check` with the space-separated script
IDs (including resolved verb IDs). Configure a Dev character for this status
check; its terminal opens even when Dev is not an origin or target.

Terminal input is disabled during rollout. Cancel, a closed rollout terminal,
loss of VS Code focus, or an unconfirmed/failed command stops further dispatch.
Commands already sent may still complete. An unknown outcome disconnects the
affected client to prevent late results from being mistaken for a later rollout.
Verify server status before retrying.
Terminals remain open afterward. Each pane is revealed before dispatch, but
VS Code's terminal API cannot enforce continuous visibility or attention.

## Known Issues

Submit bugs to the [issue tracker](https://github.com/pltrant/GSL-Editor/issues).

Join the [#gsl-editor](https://discord.gg/kjX79pB) channel on the official GemStone IV Discord server to discuss any issues, feedback, or enhancements.

## Release Notes

All notable changes will be documented in the [changelog](https://github.com/pltrant/GSL-Editor/blob/master/CHANGELOG.md).

## Build Custom VSIX File

Run the following to create a custom build of the extension:

- Update `package.json` version property to indicate pre-release build, e.g. `1.14.1-jul2025beta`
- `git clean -dxf` (WARNING: WILL DELETE FILES THAT AREN'T CHECKED IN! DO NOT DO THIS IF THERE ARE LOCAL UNTRACKED GIT CHANGES)
- `npm ci`
- `vsce package` (will run compile)

This will create a VSIX file that you can install via `Ctrl+Shift+P` -> `Extensions: Install from VSIX...` in VSCode.

## GSL Agent Files (AGENTS.md and Skills)

`GSL: Install AGENTS.md and Skills` installs the GSL language reference
(`AGENTS.md`) and GSL skills for AI agents such as Claude Code and Codex CLI.
It needs the agent files deploy key; ask the GSL development team for it.

The command asks for a folder to install `AGENTS.md` into (usually the
workspace root) and a folder to install skills into (the folder your agent
reads skills from, such as `.claude/skills`). It asks before overwriting files
you have changed or that it did not install, and it only removes files it
installed.

When a workspace has installed the files and newer versions are available, the
extension shows a notification on startup. Turn this off with the
`gsl.notifyAgentFileUpdates` setting.

## MCP Server (External AI Agents)

The extension ships an MCP server that exposes GSL tools to external agents
like Claude Code, Codex CLI, or any MCP-compatible client.

### Prerequisites

1. Run **GSL: User Setup** (`Ctrl+Shift+P` → `GSL: User Setup`) at least once.
   This creates a login config file (typically `~/.gsl/loginConfig.json`).
2. Run **GSL: Install MCP Server**. The suggested install path is beside the
   login config file (typically `~/.gsl/mcpServer.bundle.js`). You can choose a
   different existing folder, and that path is suggested the next time the
   command runs. Run the command again after updating the extension to install
   the latest server.
3. Note the paths to those files — you'll need them below.

### Configuration

Add the server to your MCP client config. Examples:

**Claude Code** (`.mcp.json` in your project root or `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "gsl-tools": {
      "command": "node",
      "args": ["/home/you/.gsl/mcpServer.bundle.js"],
      "env": {
        "GSL_LOGIN_CONFIG_FILE": "/home/you/.gsl/loginConfig.json",
        "GSL_PASSWORD": "your-play-net-password",
        "GSL_DOWNLOAD_PATH": "/path/to/your/scripts"
      }
    }
  }
}
```

### Concurrent agents and character workers

External agents share a detached daemon. Closing or terminating one agent does
not disconnect the others. The daemon exits 30 seconds after its last client
closes. Startup errors and optional `GSL_MCP_DEBUG=1` diagnostics are written to
`~/.gsl/mcp-daemon.log`.

To allow parallel requests on an instance, add character lists to your existing
login config file, for example:

```json
{
  "devInstance": "GS4D",
  "devCharacters": ["FirstDevCharacter", "SecondDevCharacter"],
  "primeInstance": "GS4",
  "primeCharacters": ["FirstPrimeCharacter", "SecondPrimeCharacter"]
}
```

The same pattern works for `shatteredCharacters`, `platinumCharacters`, and
`testCharacters`. Each character uses the configured account and password.
Existing `devCharacter`, `primeCharacter`, etc. strings still work as a single
worker; a plural list replaces the corresponding single-character setting. Keep
single-character settings if you also use the VS Code extension's editor login.

Each worker owns a connection and handles one complete operation at a time.
Additional requests wait for the next available worker. Failed operations
release their worker, and the existing connection recovery handles reconnects.
Upload-and-compile requests use the same worker pool and can run concurrently
on separate characters.

After updating the installed MCP bundle or changing worker configuration,
disconnect all MCP clients, allow the daemon to exit, then reconnect. Clients
with a closed transport must reconnect to recover. `GSL_MCP_SOCKET_PATH` can
select a separate Unix socket or Windows named pipe for another account/game;
agents sharing a pool must use the same path and configuration.

### VS Code Users

If you're using GitHub Copilot in VS Code, the MCP server tools are registered
automatically inside the extension runtime. You do not need to run an MCP server.

## Dev Upload Tool

A standalone command-line tool uploads scripts to the GemStone IV development
server (`GS4D`) and compiles them there, the way the editor's upload does. It
is for an upload that cannot wait for VS Code, and for a trusted automation
that uploads to Dev and needs a machine-readable result. It is not an MCP tool
and no agent tool exposes it.

`npm run compile` builds it to `gsl/devUpload/devUpload.bundle.js`. The bundle
is self-contained: copy that one file anywhere and run it with Node. It reads
a login config file in the MCP server's format, passed as `--config` or found
in `GSL_LOGIN_CONFIG_FILE`, and the password from `GSL_PASSWORD`. The config
must set `devInstance` to `GS4D` and exactly one dev character. Give the tool
a login file of its own, with a character of its own, not the MCP server's:
the game allows one session per character, so each login kicks that
character's other session, and a shared character would have the tool and
the MCP daemon kicking each other mid-task.

The tool only ever logs in to `GS4D`. It refuses to connect unless the login
service reports that game as `DEVELOPMENT`. No config or environment setting
widens that.

### Commands

Each command prints one JSON line on stdout, last and alone, and exits `0`
only when the top-level `outcome` is `ok`. Every command but `version` logs
in once. Scripts are named by their files: `S<number>.gsl`, in any case, with
or without leading zeros. When stdin is a pipe and the other end closes, the
run aborts: the connection is dropped without sending anything more, and the
result reports it as a failure (`unknown` if text may already have gone out).
A caller that gives the tool a pipe must keep it open until it has read the
JSON line.

```sh
node devUpload.bundle.js version
node devUpload.bundle.js metadata --config ~/.gsl/loginConfig.upload.json 12345 12346
node devUpload.bundle.js upload --config ~/.gsl/loginConfig.upload.json --expect 12345=1761800000 --expect 12346=0 S12345.gsl S12346.gsl
node devUpload.bundle.js frozen --config ~/.gsl/loginConfig.upload.json
```

`version` needs no config, login or connection. A caller that keeps a copy of
the bundle runs it once to check what it has:
`{"outcome":"ok","detail":"","tool":"gsl-dev-upload","interface":1}`. The
interface number changes when a command or the JSON shape changes
incompatibly. Within one interface, new fields and new `status` values may
appear; treat an unrecognised `outcome` as `unknown`.

`metadata` reads each script's `/ss <number> GS4D raw` output:

```json
{"outcome":"ok","detail":"","scripts":[
  {"script":12345,"outcome":"ok","status":"ok","modifier":"W_ACCOUNT","epoch":1761800000,"detail":""},
  {"script":12346,"outcome":"ok","status":"blank","modifier":null,"epoch":0,"detail":""}]}
```

`status` is `ok`, `blank` (no modifier or date recorded), `missing` (not
created), `unavailable` (no reply, or one the tool could not read) or `verb`
(the server redirects to the verb editor and shows no metadata). After a
timeout the remaining scripts are not asked, so a late reply cannot be taken
for another script's; their `outcome` is `not_attempted` with `status`
`unavailable`, the top-level `outcome` is `unknown` and the exit code is 1.

`upload` takes `--expect <number>=<epoch>` for every file, the epoch
`metadata` returned and `0` for blank, then sends each file in order and
stops at the first script that is not `ok`:

```json
{"outcome":"ok","detail":"","scripts":[
  {"script":12345,"outcome":"ok","sha256":"<sent text>","readback_sha256":"<text read back>","detail":"Compile OK and the read-back matched."}]}
```

Per-script `outcome`:

- `ok`: the compile succeeded and went live for that script number, and the
  text read back from Dev matches the text sent: `readback_sha256` equals
  `sha256`. Both hash the text with LF line endings, trailing whitespace at
  the end of the file removed and one trailing newline, as a download
  normalizes it.
- `compile_failed`: the compile reported errors, listed in `detail`. The
  editor keeps the uploaded text, confirmed by the read-back; nothing is
  restored.
- `refused`: nothing was written. The file, config or login was refused, the
  script is not on Dev, or Dev's copy is not what `--expect` says.
- `unknown`: text may have reached the editor, then something failed, and
  the tool cannot say whether Dev's copy is the sent text or whether it went
  live. `readback_sha256`, when not null, is the text Dev holds now.
- `not_attempted`: an earlier script stopped the run.

The top-level `outcome` is `ok` when every script is, otherwise the first
other outcome. A run-level failure, such as a bad argument, a refused login
or a lost connection before any script, is a top-level `refused` or
`unknown` with every script `not_attempted`; the top-level `detail` always
carries the reason. An audit log write that fails after an upload is a
top-level `unknown` with the real per-script results.

`--expect` is the stale check: the upload re-reads the metadata just before
it sends and refuses the script if Dev no longer shows that epoch. It must
name every file, once, with digits only. A script whose metadata is
`missing`, `unavailable` or `verb`, or whose `status` is `ok` with a
modifier but no date (`epoch` null), cannot be checked and is refused here.

`upload` also refuses to run in an agent session, judged by the environment.
An automation that drives this tool gives it a clean environment.

Text is refused before login if the editor would not take it as sent: a blank
or whitespace-only line, a line starting with `~`, a line over 118 characters,
a character outside printable ASCII and tab, trailing whitespace on the last
line, or more than 39,998 lines. CRLF line endings are accepted.

Every write attempt is appended as a JSON line to the audit log, before the
text is sent and again with its result. Set the path with `--audit-log`; the
default is `dev-upload-audit.log` beside the login config. The run is refused
if the log cannot be opened for appending. The password is never printed or
logged.

`frozen` lists the scripts the server reports as frozen or locked, with verbs
converted to their script numbers:
`{"outcome":"ok","detail":"","scripts":[{"script":13693,"status":"FROZEN"}]}`.
A failed list has `"scripts":[]`.
