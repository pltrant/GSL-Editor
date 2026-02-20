# Description

The GSL Editor is an extension for the GemStone Language for Simutronics' Interactive Fiction Engine games.

## Features

* Function to automatically download or upload scripts.
* Syntax highlighting
* Auto Indentation
* Snippets for every GSL command
* Go to/Peak Definitions (matchmarkers)
* Outline view to see every matchmarker within a script and ability to click to go to directly to that line.

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
