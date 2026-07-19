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

### VS Code Users

If you're using GitHub Copilot in VS Code, the MCP server tools are registered
automatically inside the extension runtime. You do not need to run an MCP server.
