# Change Log

All notable changes to the GSL Editor extension will be documented in this file.

## [1.7.2] - 2019-03-24

### Fixed

- Resolved issue that was causing the new Setup User prompt to appear on every restart of Visual Studio Code.
- Resolved issue that would sometimes cause an upload/download to fail when it first had to connect to the game.

## [1.7.1] - 2019-03-23

### Added

- The first time a user installs the GSL Editor extension, they will be prompted to run the User Setup process.

## [1.7.0] - 2019-03-23

### Changed

- Going forward, the GSL Editor extension will no longer use Visual Studio Code's settings.json file to store your login credentials.  Such information, except your password, is now stored in a separate storage object provided by the extension API.  More importantly, your password is stored in your operating system's secure keychain (Credential Vault on Windows, Keychain on macOS, etc).  For more information see [node-keytar](https://github.com/atom/node-keytar).  __All users must run the new User Setup process__ which will prompt you for this information, then store it as noted above.  To run the new User Setup, click the GSL button from the Status Bar, then select User Setup.

## [1.6.8] - 2019-02-14

### Fixed

- Resolved issue with reconnecting to the game after the client loses connection, due to to Visual Studio Code's recent update (v1.31) which was updated to use Node.js v10.2.

## [1.6.6-7] - 2018-02-14

No change.  Publish error bumped up to 1.6.7.

## [1.6.5] - 2018-12-03

### Changed

- Updated the Status Bar icons for the Download, Upload, and GSL buttons.

## [1.6.4] - 2018-11-22

### Fixed

- Syntax highlighting for comments should now work more consistently.

## [1.6.3] - 2018-11-20

### Changed

- Removed an unnecessary node package.

## [1.6.2] - 2018-11-20

### Changed

- Check Date now returns the results in the Status Bar instead of an information message.
- Refreshed the default themes for VSC, which the custom GSL themes rely on.

### Fixed

- The NP0/NC0 snippets should now no longer show up for auto completion when just typing 'NP0' or 'NC0'.
- Comment syntax highlighting should no longer happen on != condition checks.
- The newline at the end of a script should no longer be removed when saving/formatting the file.

## [1.6.1] - 2018-09-26

### Changed

- A few prompts now close (instead of remaining open) when you click outside of the dialog.
- Failing to provide input for a script download, upload, or a few other prompts now just display an error in the Status Bar instead of an error message.

## [1.6.0] - 2018-09-26

### Added

- GSL button in the Status Bar to list all the available commands for the extension.
- Trailing whitespace is now stripped from scripts when formatted (saved or uploaded).

### Changed

- Removed the Date Check setting to always display in the Status Bar since it's easily found in the GSL option now.

### Fixed

- Fixed snippets for infoitem, kill, and move to include NC0.

## [1.5.1] - 2018-06-15

### Changed

- The Matchmarkers view has been depreciated in favor of the new built-in [Outline view](https://code.visualstudio.com/updates/v1_24#_outline-view), which achieves the same goal, but has more options (follow cursor, sort type, filter, etc).  The referenced link has instructions on how to enable it.

## [1.5.0] - 2018-06-11

No change.  Publish error bumped up to 1.5.0.

## [1.4.0] - 2018-06-11

### Added

- Scripts are now scanned when saved (which also happens on upload) to remove non-printable characters (usually the result from copy/pasting from a Word document or web browser).
- There is a new 'disableLoginAttempts' setting.  When enabled, the editor will no longer try to log you into the game to perform various actions (such as to download/upload scripts) - this also means those actions will silently fail when invoked.

### Changed

- Updated the Matchmarkers view to use the new 'reveal' API (instead of the previous icon) to highlight the current matchmarker the cursor is in.
- The Matchmarkers view is now only be visible while a GSL script file has focus and is hidden for other file types.
- The 'new' snippet (for creating notes and comment history at the top of a script) will now default to today's date for the script modification entry.
- GSL color themes: the Line Number and [Indent Guide](https://code.visualstudio.com/updates/v1_23#_highlighted-indent-guides) relative to the cursor's position will now be displayed in a more prominent color.

### Fixed

- Definitions (for Go To or Peek functionality) are now only valid on callmatch lines that end in a number.
- Corrected remmenuitem snippet (removemenuitem => remmenuitem).

## [1.3.3] - 2018-02-16

### Changed

- Rewrote some of the logic for the document highlighter (when the cursor is on an open/close control keyword, highlighting it and its counterpart).  This also fixed a bug when placing the cursor on the closing period of a matchmarker.  These changes should mostly be invisible to users.

## [1.3.2] - 2018-02-12

### Fixed

- The logic to auto reconnect on disconnect should now work more consistently.

## [1.3.1] - 2018-02-07

### Fixed

- Corrected a "cannot read property 'map' of undefined" error when starting VSCode while not in a script file.

## [1.3.0] - 2018-01-30

### Added

- Clicking on a conditional (e.g. 'if') or control (e.g. 'loop') keyword will now highlight it and its matching conditional (e.g. 'else') and closing keywords (e.g. '.').

### Changed

- Set highlight similiar matches on selection to disabled by default. (e.g. clicking on 'word' will no longer highlight all other instances of 'word').  You can override this in the settings.

### Fixed

- Matchmarkers view will no longer include comments in the matchmarker name.
- Removed 'while' from the control syntax highlight - that's not a valid keyword for GSL.
- Added 'else_ifnot' to auto indentation rules.

## [1.2.2] - 2018-01-29

### Fixed

- A performance update to lessen the impact of calculating the Matchmarkers view when text changes or the cursor is moved while staying on the same line.

## [1.2.1] - 2018-01-28

### Added

- An arrow will now display in the Matchmarkers view to represent the current matchmarker that the cursor is located in.

## [1.2.0] - 2018-01-27

### Added

- Implemented Go to/Peek Definitions.  You can now click on a line with a call(match), then hit F12 or right-click > Go to Definition to automatically open up that script and go to that matchmarker in it.  If you have an existing local copy already, it will open it; otherwise will download it from the server.  Keep in mind if it opens the local copy, the script could be out of date and not have changes that are implemented on the server.  Using Peek Definition allows you to view it in a frame instead of a new tab so you never have to leave your existing script.  Give both a try!

### Changed

- The Problems view (which lists compile errors found during an upload) will no longer auto-close when uploading a script and the view is already open.

## [1.1.1] - 2017-10-06

### Added

- New command to manually enable logging for debugging.  Defaults to off and does not log any SGE connection data (account, password hash, etc).

## [1.1.0] - 2017-10-05

### Added

- New installations of the extension will now prompt users to apply the GSL Vibrant theme.
- New "Download To Workspace" setting, which when enabled, will download scripts to your currently opened folder. - Oliver/Naos

### Changed

- Compile errors, detected when uploading, are now displayed using the diagnostic API for Visual Studio Code.  When an error is found, it will display the Problems view which lists all errors.  You can click on each error to go directly to that line.  A red squiggly line will also show up under the text for the line with the error, which will persist until you upload again and error is resolved.
- A few minor adjustments to the colors in the GSL Light theme.

### Fixed

- Adjusted game login Status Bar text to only display when connecting.
- Langauge definition update for callmatch pattern. - Oliver/Naos

## [1.0.5] - 2017-09-21

### Added

- Hover over any token (e.g. $P0H = "his/her") to get a description of what it represents! - Don/Konacon
- Get a listing of all tokens with the new List Tokens command.  Available by hitting F1 (to display the Command Palette), type in "gsl", then select List Tokens or use Ctrl+Alt+L.
- Status Bar text when logging into the game.

## [1.0.4] - 2017-09-18

### Added

- There is a new GSL Vibrant theme.
- There is now a configuration settings to specify the file extension to use for downloaded scripts.  It defaults to .gsl.
- Enabled TCP socket KeepAlive functionality, which should help in detecting disconnects.

## [1.0.3] - 2017-09-14

### Added

- Upload script check: a timestamp is now stored when you download any script.  That timestamp is then referenced against the server before any upload.  If they are different, you will be prompted before continuing.  This should help ensure you don't upload a version of the script that is now out of date.
- Empty matchmarker is now listed as "" at the top of the Matchmarkers view and symbol list. - Don/Konacon

### Changed

- Compile errors will now be presented in a pop-up error dialog.

## [1.0.2] - 2017-09-13

### Added

- There is now a Date Check command, thanks to Don/Konacon, that will display the last modified date of a script from the game (e.g. /ss script#) to assist with QC.  You can manually invoke the command from the Command Palette (F1, then type in GSL), from the keybinding Ctrl+Alt+C, or you can add a Check Date button to the Status Bar by enabling it under Settings.
- Matchmarkers are now considered symbols (for go to symbol functionality (Ctrl+Shift+O)) from Don/Konacon.

### Changed

- More language definition updates from Oliver/Naos:
  - fixed comments on GATHER and REMOVEVARFIELD lines
  - added MATCH and REPLYADDRESS system string vars
  - added highlighting for RMCALL statements
  - added MSGW to messaging statement definition
  - added better definition for MSG statement
  - added $X#T token
  - fixed negative numbers not highlighting the - sign
- Moved GSL Editor repository to [https://github.com/pltrant/GSL-Editor](https://github.com/pltrant/GSL-Editor).

### Fixed

- You should now able to download new scripts which have no text yet.

## [1.0.1] - 2017-09-10

### Fixed

- If the connection to the game drops, it will now automatically reconnect on the next upload/download.
- Script downloads should work correctly on macOS again.
- Matchmarker color highlighting should now be consistent.

### Changed

- Downloaded scripts will now have a .gsl extension.

## [1.0.0] - 2017-09-06

### Added

- The extension now includes 2 default color themes for GSL, aptly named GSL Light and GSL Dark.  **The GSL Dark theme is strongly recommended.  To change your color theme, go to File > Preferences > Color Theme (or Ctrl+K Ctrl+T).**  It should be noted that you color customize any element of code.  If you don't like the red that is used for `kill`, you can change it to any other color you want.

### Changed

- Thanks to Oliver/Naos' work, the language definition file for GSL was significantly updated and now fully supports almost every element of GSL.  This mostly comes into play for the color customization noted above.
- Snippets have been updated to provide choices where appropriate.  For example, if you're using `checkeffect`, the first placeholder is always a node, so it will display a dropdown listing all valid nodes (NP#, NC#, NO#, NE#, NR#, where # is 0-9).  You don't have to scroll through the entire list, you can start to type which option you want and it will narrow down the list for you.

## [0.0.33] - 2017-08-11

### Fixed

- Downloading a script should no longer overwrite the last script downloaded.  It will always open in a new tab.

## [0.0.32] - 2017-07-31

### Fixed

- Resolved issue on script upload where numbers in the file path were also being used. It now only cares about the actual file name.

## [0.0.31] - 2017-07-27

### Added

- You can now download multiple scripts at a time. Separate them with a ; or specify a range with a -. e.g. 1;2;3;4;5 or 1-5 or 1;2-4;5

### Changed

- To upload a script, it no longer requires you follow the strict file name format of S#####. It will now just pull out all digits from the file name to parse the script number. e.g. "S12345", "12345.gsl", "S12345 - Test" will all parse to script 12345. Failing that, it will prompt you for the script number.

## [0.0.22-30] - 2017-07-19

### Fixed

- Upload error with scripts that didn't end with a blank line.

## [0.0.20 & 21] - 2017-07-19

### Changed

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

### Fixed

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

Initial release with syntax highlighting and Download/Upload script functionality.