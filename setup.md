# GSL Editor

Use the below instructions to setup and use the GSL Editor.

## Installation

1. Download and install [Visual Studio Code](https://code.visualstudio.com/).

    Visual Studio Code is a free, open source, cross-platform (Windows, Linux and macOS) code editor developed by Microsoft.  It is based the Electron framework, which is basically a self-contained version of the Chrome web browser for the frontend.

2. Once installed, launch the application.  Then from the top menu, select View > Extensions (Ctrl+Shift+X).  In the new pane that opens up, there is a textbox at the top to search for extensions in the VSCode Marketplace. Search for "gsl", which should then list the "GSL Editor".  Click the "Install" button, then "Reload" once complete.

    ![](https://radiantglyph.com/gsiv/gsleditor/extension.jpg)

3. At the minimum, 3 settings must be set before you can use the GSL Editor for downloading and uploading scripts.  To do this, from the top menu, select File > Preferences > Settings (Ctrl+Comma).  This will open up a split pane window.  On the left side are all settings available for VSCode itself.  The right side is your personal, saved settings.  In the top search textbox, search for "gsl", which will list the relevant settings for the GSL Editor.  Hover your mouse over the gsl.account setting, then a pencil icon will appear to the left - click on the icon, then select "Copy to settings".  This then copies the setting to the right pane, where you can enter your Play.net account name.  Do this for the gsl.account, gsl.password, and gsl.character.  The other settings are optional, but I recommend leaving them as is until you familiarize yourself with the base setup.  Once done, click the X on the "settings.json" tab to close the window.  If prompted, save the document.  You may not be prompted, as it periodically auto-saves.

    ![](https://radiantglyph.com/gsiv/gsleditor/settings.jpg)

4. You should now be ready to use the GSL Editor.  You can just start by downloading or uploading any script by using the buttons on the bottom, left status bar.

    ![](https://radiantglyph.com/gsiv/gsleditor/buttons.jpg)

5. A Google Group has been created for anyone to submit bugs, enhancements, or general feedback.  You can request to join at [https://groups.google.com/forum/#!forum/gsl-editor/join](https://groups.google.com/forum/#!forum/gsl-editor/join).

## Tips

* Use the Matchmarkers view available in the Explorer panel (top icon in the left navigation menu or Ctrl+Shift+E).  It will list all matchmarkers found in a script and clicking on one of them will take you to that matchmarker.
* If you're wanting to create an entirely new script file to work with, you can name the file anything you want, but to avoid being prompted to enter the script number on Upload, specify 5 digits in the filename somewhere (e.g. "S18070", "S18070 - Test", "Magic 18070.gsl")
* Use different color themes to customize the look of VSCode - a light background with dark text, a dark background with light text, etc.  GSL Editor comes with 2 prebuilt color themes - GSL Dark and GSL Light.  **The GSL Dark theme is strongly recommended.  To change your color theme, go to File > Preferences > Color Theme (or Ctrl+K Ctrl+T).**
* Review the Interactive Playground from the "Quick links" section on the Welcome page (Help > Welcome) to learn useful functionality like multi-cursor editing, code folding, and line actions!  Also:
    * Indent any block of selected text with Tab.  Unindent with Shift+Tab.
    * Comment or uncomment any block of selected text with Ctrl+/.
    * Goto any specific line in a script with Ctrl+G.
* Learn to use snippets.  Start typing any GSL command, such as "add" and as you type in the word, you will see menu pop-up for options such as: addeffect, addexp, addgroup, and addmenuitem.  Use the arrows then TAB to select any entry or just click on it, and it will type out the rest of the syntax for you and prompt you to enter any needed values.  Then just TAB between input values, then ENTER or ESC once done.

    ![](https://radiantglyph.com/gsiv/gsleditor/snippets.gif)

* Review the entire list of 100+ settings (File > Preferences > Settings (Ctrl+Comma)) that are built into VSCode.  You can customize settings such as auto-save, font size, drag and drop text selections, and more!
* For advanced users, setup a local git repository of the Dev script archive from https://gitlab.com/GSIV/Dev.git, allowing you to use the built in Search functionality of VSCode.  You can then easily keep your local repository in sync (git pull) and quickly search all script files using keywords or regex with a useful graphical user interface to review the results.