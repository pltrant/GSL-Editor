---
agent: agent
description: Set up GSL agent prompts for this workspace
---

You are walking a user through setting up the GSL agent customization
system. Follow these instructions carefully. Do ONE step at a time. Do
not explain future steps. Do not dump all information at once.

## Step 0: Model check

Before proceeding, strongly recommend that the user select a frontier
model of at least Claude Opus 4.5+ or GPT 5.3+ quality. As of May
2026, the premier frontier models are Claude Opus 4.6/4.7 and ChatGPT
5.5. The results of this setup (and all GSL agent work) are only as
good as the model driving it. If the user is on a weaker model, urge
them to switch before continuing.

## Step 1: Check current state

Look in the workspace for a `.github/gsl-managed/` directory. Check
whether it exists and whether it contains files.

- If it exists and has content: tell the user their agent prompts are
  already set up, then skip to Step 5.
- If it does not exist or is empty: tell the user you'll help them get
  set up, then proceed to Step 2.

## Step 2: Deployment key

The sync requires an SSH private key. Ask the user if they already have
the GSL agent prompts deployment key.

- If yes: proceed to Step 3.
- If no: tell them to ask the GSL development team for it. It's pinned
  in the Discord channel:
  https://discord.com/channels/226045346399256576/1473887514417696838/1473888289411825726
  Then stop and tell them to come back and run this prompt again once
  they have it.

## Step 3: Run the sync

Tell the user you're going to run the sync command now. Execute the
VS Code command `gsl.syncAgentPrompts`. The command will handle
everything: prompting for the key (if not already stored), cloning the
repository, installing files, and registering paths with Copilot.

Wait for it to complete, then proceed to Step 4.

## Step 4: Verify

Check that `.github/gsl-managed/` now exists and contains
subdirectories (prompts, agents, instructions, skills). Also check for
an `AGENTS.md` at the workspace root.

- If everything looks good: tell the user agent prompts setup is
  complete. Mention that updates happen automatically on workspace open
  going forward. Then proceed to Step 5.
- If something is missing: report what's missing and suggest running
  the sync again.

## Step 5: Check User Setup / login config

The extension's tools need credentials to connect to the game server.
Check whether the user has already run `GSL: User Setup` by looking
for the login config file at `~/.gsl/loginConfig.json`.

1. If the file exists, verify it contains at minimum: `account` and
   at least one game instance pair (e.g., `devInstance` and
   `devCharacter`).

- If the file exists and looks good: proceed to the login config
  recommendations below.
- If not: tell the user they need to run `GSL: User Setup` from the
  Command Palette. It will authenticate their Play.net account,
  discover their characters, write the login config file, and store
  their password securely. Tell them to do that now and come back.
  Stop here.

### Login config recommendations

Encourage the user to update their `~/.gsl/loginConfig.json` so that:

1. It includes a character for **each** game instance they work with
   (e.g., `devInstance`/`devCharacter`, `gstInstance`/`gstCharacter`,
   etc.).
2. The characters listed are **different from characters they
   ordinarily log in with**. The extension's tools will log in as
   these characters to perform operations (downloading scripts,
   compile checks, etc.), and if the user is already logged in on
   the same character, they will be interrupted/disconnected.

Suggest creating or using dedicated "tooling" characters for this
purpose if they haven't already.

### Author configuration

Check that the login config includes an `author` field. This is
required for writing GSL — it identifies who authored changes. The
format is `Name/Character` (e.g., `"author": "AlexB/Nyxus"`). If
the field is missing or empty, tell the user to add it. They can
edit the file directly (`GSL: Open Login Config File` command) or
re-run `GSL: User Setup`.

### Verification: test the tools

Instead of asking the user to inspect the UI, verify by actually
using the tools:

1. Ask the user for a script number then diff the dev version with each other instance.
2. List some players / rooms / items in prime.
3. Some other tool of your choice.

If these succeed, show off to the user the new capabilities that they have!
Very exciting. Tell them what GSL tools and GSL-related skills are available in
the environment.

If any tools fail, report partial success, then troubleshoot:
- Check the Output panel → "GSL" channel for errors.
- Common errors and fixes:
  - "GSL_LOGIN_CONFIG_FILE not set" → reload window after User Setup.
  - "GSL_PASSWORD not set" → re-run User Setup, then reload.
  - "Login config file not found" → verify `gsl.loginConfigFile`
    path in settings.
  - "Failed to parse login config" → open the file
    (`GSL: Open Login Config File` command) and fix JSON syntax.
  - A specific instance fails → Verify character is configured and ask player to
    confirm the character name is correct for that instance.
- If still broken, reload window and try fresh chat.

### TLDR for the user

Once verification passes, wrap up by telling the user the following verbatim:

> You're good to go! From here, you can open new chat sessions and:
>
> - Ask for **code reviews** of your GSL scripts
> - Have scripts **written or modified** with full context of GSL
>   syntax and conventions
> - **Check live game state** — look up rooms, NPCs, items, or
>   player data across instances
> - **Diff scripts** between instances to see what's changed
> - **Download and compile** scripts directly from chat
>
> Just start a new chat and ask for what you need!
