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
