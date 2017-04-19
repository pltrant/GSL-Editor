# Change Log
All notable changes to the GSL Editor ("gsl") extension will be documented in this file.

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