# Change Log
All notable changes to the GSL Editor extension will be documented in this file.

## [1.0.3] - 2017-09-14
## Added
- Upload script check: a timestamp is now stored when you download any script.  That timestamp is then referenced against the server before any upload.  If they are different, you will be prompted before continuing.  This should help ensure you don't upload a version of the script that is now out of date.
- Empty matchmarker is now listed as "" at the top of the Matchmarkers view and symbol list. - Don/Konacon

## Changed
- Compile errors will now be presented in a pop-up error dialog.

## [1.0.2] - 2017-09-13
## Added
- There is now a Date Check command, thanks to Don/Konacon, that will display the last modified date of a script from the game (e.g. /ss script#) to assist with QC.  You can manually invoke the command from the Command Palette (F1, then type in GSL), from the keybinding Ctrl+Alt+C, or you can add a Check Date button to the Status Bar by enabling it under Settings.
- Matchmarkers are now considered symbols (for go to symbol functionality (Ctrl+Shift+O)) from Don/Konacon.

## Changed
- More language definition updates from Oliver/Naos:
    - fixed comments on GATHER and REMOVEVARFIELD lines
    - added MATCH and REPLYADDRESS system string vars
    - added highlighting for RMCALL statements
    - added MSGW to messaging statement definition
    - added better definition for MSG statement
    - added $X#T token
    - fixed negative numbers not highlighting the - sign
- Moved GSL Editor repository to https://github.com/pltrant/GSL-Editor.

## Fixed
- You should now able to download new scripts which have no text yet.

## [1.0.1] - 2017-09-10
## Fixed
- If the connection to the game drops, it will now automatically reconnect on the next upload/download.
- Script downloads should work correctly on macOS again.
- Matchmarker color highlighting should now be consistent.

## Changed
- Downloaded scripts will now have a .gsl extension.

## [1.0.0] - 2017-09-06
## Added
- The extension now includes 2 default color themes for GSL, aptly named GSL Light and GSL Dark.  **The GSL Dark theme is strongly recommended.  To change your color theme, go to File > Preferences > Color Theme (or Ctrl+K Ctrl+T).**  It should be noted that you color customize any element of code.  If you don't like the red that is used for `kill`, you can change it to any other color you want.

## Changed
- Thanks to Oliver/Naos' work, the language definition file for GSL was significantly updated and now fully supports almost every element of GSL.  This mostly comes into play for the color customization noted above.
- Snippets have been updated to provide choices where appropriate.  For example, if you're using `checkeffect`, the first placeholder is always a node, so it will display a dropdown listing all valid nodes (NP#, NC#, NO#, NE#, NR#, where # is 0-9).  You don't have to scroll through the entire list, you can start to type which option you want and it will narrow down the list for you.

## [0.0.33] - 2017-08-11
## Fixed
- Downloading a script should no longer overwrite the last script downloaded.  It will always open in a new tab.

## [0.0.32] - 2017-07-31
## Fixed
- Resolved issue on script upload where numbers in the file path were also being used. It now only cares about the actual file name.

## [0.0.31] - 2017-07-27
## Added
- You can now download multiple scripts at a time. Separate them with a ; or specify a range with a -. e.g. 1;2;3;4;5 or 1-5 or 1;2-4;5

## Changed
- To upload a script, it no longer requires you follow the strict file name format of S#####. It will now just pull out all digits from the file name to parse the script number. e.g. "S12345", "12345.gsl", "S12345 - Test" will all parse to script 12345. Failing that, it will prompt you for the script number.

## [0.0.22-30] - 2017-07-19
## Fixed
- Upload error with scripts that didn't end with a blank line.

## [0.0.20 & 21] - 2017-07-19
## Changed
- The Matchmarkers view will now always be displayed. There appears to be a bug in Microsoft's logic to conditionally display it.

## [0.0.19] - 2017-07-18
### Added
- A new custom Matchmarkers view is now available in the Explorer panel (top icon in the left navigation menu or Ctrl+Shift+E). It will list all matchmarkers found in a script and clicking on one of them will take you to that matchmarker. The previous Matchmarkers button in the bottom Status Bar has been removed.
- Scripts will now automatically be locally saved before every upload.

## [0.0.18] - 2017-07-17
### Changed
- Re-implemented the script upload function so it should be significantly more reliable now. Thanks for the help, Oliver!

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
- Added Send Game Command option, available by hitting F1, then type in GSL and select the Send Game Command option or use Ctrl+Alt+G. Once prompted, input the command you wish to send to the game.

## [0.0.10] - 2017-05-16
### Added
- Added snippets for almost every GSL syntax commands. Start typing any command and use the intellisense window to finish the code for you!

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
- Snippets for if, ifnot, if/else, if/else_if, if/else_if/else, else, else_if, when, loop, mm (new matchmarker), and new (new script header). Try it out by just typing "if", "else", "when", "loop", "mm", or "new", then hit TAB. You can then TAB through multiple points in the snippet to enter relevant code. Finally, hit ENTER when you're done editing it.

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