# Change Log
All notable changes to the GSL Editor ("gsl") extension will be documented in this file.

## [0.0.17] - 2017-07-11
### Added
- Auto indentation of code
- Prompt to display Release Notes on new releases.

### Changed
- Default location of downloaded scripts to avoid losing them on extension updates.

## [0.0.15 & 16] - 2017-07-11
- Updated rolled to 0.0.17.

## [0.0.14] - 2017-07-07
### Added
- Disabled minimap by default.

### Fixed
- value2 tab stop for rem2effect snippet.

## [0.0.13] - 2017-05-27
### Fixed
- Visibility snippets issue.

## [0.0.12] - 2017-05-27
### Added
- Added (ifnot) visibility snippets.

## Fixed
- Downloading verbs while under certain conditions.

## [0.0.11] - 2017-05-17
### Added
- Added Send Game Command option, available by hitting F1, then type in GSL and select the Send Game Command option or use Ctrl+Alt+G.  Once prompted, input the command you wish to send to the game.

## [0.0.10] - 2017-05-16
### Added
- Added snippets for almost every GSL syntax commands.  Start typing any command and use the intellisense window to finish the code for you!

## [0.0.9] - 2017-05-12
### Changed
- Revised logic for going to a clicked matchmarker line.

## [0.0.8] - 2017-05-12
### Added
- Show Matchmarkers function: click the Matchmarkers button in the status bar to get a list of all matchmarkers in the script, then click on any of them to go to that matchmarker.
- Keybindings to Download (Ctrl+D), Upload (Ctrl+U), and show Matchmarkers (Ctrl+M).

## [0.0.7] - 2017-05-12
No change.

## [0.0.6] - 2017-04-24
### Changed
- Repackaged extension to remove some unnecessary files.

## [0.0.5] - 2017-04-24
### Added
- Snippets for if, ifnot, if/else, if/else_if, if/else_if/else, else, else_if, when, loop, mm (new matchmarker), and new (new script header).  Try it out by just typing "if", "else", "when", "loop", "mm", or "new", then hit TAB.  You can then TAB through multiple points in the snippet to enter relevant code.  Finally, hit ENTER when you're done editing it.

### Changed
- Temporarily disabled intellisense until its formally supported for GSL.

### Fixed
- Changed wordwrap and column ruler to 118 characters.

## [0.0.4] - 2017-04-21
### Changed
- Downloaded files are now locally saved before opened (which gets rid of the unsaved status and prevents 'undo' from removing all text)
- Revised some of the download/upload logic to better handle command flow
- Added some logic to attempt to detect when there is an error during an upload/download and resolve itself

## [0.0.3] - 2017-04-19
### Added
- Added error validation on invalid script names when trying to upload.
- Error message on connection failures.

### Fixed
- Updated connection handling to avoid some issues.
- When downloading, deletes an existing script file if it already exists.

## [0.0.2] - 2017-04-19
### Added
- alwaysEnabled setting (default true): causes the extension to always be loaded instead of just based upon Language detection.
- displayGameChannel setting (default false): automatically opens the Game output channel when the editor is launched.
- downloadPath setting (default null): location where to locally store downloaded scripts.

## [0.0.1] - 2017-04-18
- Initial release with syntax highlighting and Download/Upload script functionality.