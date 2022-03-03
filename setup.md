# GSL Editor

Use the below instructions to setup and use the GSL Editor.

## Installation

1. Download and install [Visual Studio Code](https://code.visualstudio.com/).

    Visual Studio Code is a free, open source, cross-platform (Windows, Linux and macOS) code editor developed by Microsoft.  It is based the Electron framework, which is basically a self-contained version of the Chrome web browser for the frontend.

2. Once installed, launch the application.  Then from the top menu, select View > Extensions (Ctrl+Shift+X).  In the new pane that opens up, there is a textbox at the top to search for extensions in the VSCode Marketplace. Search for "gsl", which should then list the "GSL Editor".  Click the "Install" button.

    ![](https://www.glyph.dev/gsiv/gsleditor/extension.jpg)

3. Once the extension is installed, you will be prompted to run the User Setup process.  It will securely store your Play.net account credentials so you can log into the game to download and upload scripts.

    ![](https://www.glyph.dev/gsiv/gsleditor/settings.jpg)

4. You should now be ready to use the GSL Editor.  You can just start by downloading or uploading any script by using the previous referenced buttons.

    ![](https://www.glyph.dev/gsiv/gsleditor/buttons.jpg)

5. Join the [#gsl-editor](https://discord.gg/kjX79pB) channel on the official GemStone IV Discord server to discuss any issues, feedback, or enhancements.  There's also a [Google Group](https://groups.google.com/forum/#!forum/gsl-editor/join) for email discussions.

## Tips

* Use the Matchmarkers view available in the Explorer panel (top icon in the left navigation menu or Ctrl+Shift+E).  It will list all matchmarkers found in a script and clicking on one of them will take you to that matchmarker.
* If you're wanting to create an entirely new script file to work with, you can name the file anything you want, but to avoid being prompted to enter the script number on Upload, specify 5 digits in the filename somewhere (e.g. "S18070", "S18070 - Test", "Magic 18070.gsl")
* Use different color themes to customize the look of VSCode - a light background with dark text, a dark background with light text, etc.  GSL Editor comes with 2 prebuilt color themes - GSL Dark and GSL Light.  **The GSL Dark theme is strongly recommended.  To change your color theme, go to File > Preferences > Color Theme (or Ctrl+K Ctrl+T).**
* Review the Interactive Playground from the "Quick links" section on the Welcome page (Help > Welcome) to learn useful functionality like multi-cursor editing, code folding, and line actions!  Also:
    * Indent any block of selected text with Tab.  Unindent with Shift+Tab.
    * Comment or uncomment any block of selected text with Ctrl+/.
    * Goto any specific line in a script with Ctrl+G.
* Learn to use snippets.  Start typing any GSL command, such as "add" and as you type in the word, you will see menu pop-up for options such as: addeffect, addexp, addgroup, and addmenuitem.  Use the arrows then TAB to select any entry or just click on it, and it will type out the rest of the syntax for you and prompt you to enter any needed values.  Then just TAB between input values, then ENTER or ESC once done.

    ![](https://www.glyph.dev/gsiv/gsleditor/snippets.gif)

* Review the entire list of 100+ settings (File > Preferences > Settings (Ctrl+Comma)) that are built into VSCode.  You can customize settings such as auto-save, font size, drag and drop text selections, and more!
* For advanced users, setup a local git repository of the Dev script archive from https://github.com/pltrant/GSL-Editor.git, allowing you to use the built in Search functionality of VSCode.  You can then easily keep your local repository in sync (git pull) and quickly search all script files using keywords or regex with a useful graphical user interface to review the results.