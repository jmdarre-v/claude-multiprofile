# Walkthrough: setting up an WORK work profile alongside personal

This is a worked example showing what the wizard actually looks like end to end. The user's setup before starting:

- Claude Desktop installed and signed into a personal account
- Claude Code installed via npm, signed into the same personal account
- About to add an WORK work profile that's fully separate

## Step 1: Run the wizard

```
$ claude-multiprofile add

──────────────────────────
  Add a Claude profile
──────────────────────────

A "profile" is an isolated Claude install that runs alongside your existing
one. Each profile has its own login, chats, settings, and MCP connectors.
You typically want one for personal use and one for work, but you can
create as many as you need (client A, client B, etc.).

This tool does NOT touch your existing default Claude. Your current login
and chats stay exactly as they are. We only set up the new profile next
to it.

? What do you want to set up for this profile?
❯ Both Claude Desktop and Claude Code (recommended)
  Claude Desktop only (the GUI chat app)
  Claude Code only (the terminal CLI)

? Profile name (e.g. work, work, client-acme): work
```

## Step 2: Desktop questions

```
→ Claude Desktop configuration

Claude Desktop stores everything (login, chats, settings, MCP servers)
in a single folder. By giving the new profile its own folder, we get
a fully isolated second account.

We will also create a real macOS .app launcher for this profile so you
can put it on your Dock and launch it like any other app.

ℹ Found Claude Desktop at /Applications/Claude.app.

Where should the new profile's data live? The default puts it next to
your current Claude data, both inside ~/Library/Application Support/.
The folder will be created if it doesn't exist; nothing inside your
existing ~/Library/Application Support/Claude folder will be touched.

? Data folder for this profile: (~/Library/Application Support/Claude-WORK) ↵

We'll generate a small .app bundle that, when double-clicked, launches
Claude with the right --user-data-dir flag for this profile. You can
drag the .app to your Dock for one-click access.

The default location is ~/Applications because it doesn't require
administrator permission to write to. You can also use /Applications,
but that might prompt for your password.

? Where to save the launcher .app: (~/Applications/Claude WORK.app) ↵
? Copy the Claude icon onto the launcher? (recommended) (Y/n) ↵
```

## Step 3: Code questions

```
→ Claude Code configuration

Claude Code (the terminal CLI) keeps everything under ~/.claude by
default. We'll give this profile its own config directory and add a
shell alias so you can launch it with a single command.

? Config folder for this profile: (~/.claude-work) ↵
? Shell alias to launch this profile: (claude-work) ↵

You already have a ~/.claude config from your existing Claude Code
install. We can copy its contents into the new profile's folder so
that any skills, plugins, MCP servers, or slash commands you've set
up come along for the ride.

Authentication does NOT carry over. Claude Code stores its login in
macOS Keychain under a key derived from CLAUDE_CONFIG_DIR, which is
different for the new profile. You'll sign in fresh on first launch.

? Copy your existing ~/.claude into the new profile? (recommended) (Y/n) ↵
```

## Step 4: Review and confirm

```
→ Review

  Profile name: work

  Claude Desktop:
    Data folder: ~/Library/Application Support/Claude-WORK
    Launcher app: ~/Applications/Claude WORK.app
    Apply Claude icon: yes

  Claude Code:
    Config folder: ~/.claude-work
    Shell alias: claude-work
    Seed from existing ~/.claude: yes

? Apply this configuration? (Y/n) ↵
```

## Step 5: Execution

```
→ Creating Claude Desktop profile "work"
ℹ Data folder: ~/Library/Application Support/Claude-WORK
ℹ Launcher app: ~/Applications/Claude WORK.app
ℹ Claude.app source: /Applications/Claude.app
✓ Data folder ready.
✓ Launcher .app compiled.
✓ Claude icon applied to launcher.

→ Creating Claude Code profile "work"
ℹ Config folder: ~/.claude-work
ℹ Shell alias: claude-work
✓ Config folder created and seeded from ~/.claude.
✓ Existing skills, plugins, and MCP config carried over. Auth did not (it lives in Keychain).
✓ Alias "claude-work" added to ~/.zshrc (shell: zsh).

✓ Profile "work" is ready.
```

## Step 6: Next-steps guidance

```
→ Next: sign in to Claude Desktop

The first time you launch the new Desktop profile, you'll need to sign
in with the account that should belong to it. Do this carefully:

  1. Quit any other Claude window first (Cmd+Q from the menu bar).
     Claude's sign-in flow uses a claude:// deep link that gets routed
     to whatever Claude instance is running. If two are open at once,
     the token can land on the wrong one.

  2. Double-click the new launcher (or run the open command below).

  3. Sign in with the account for this profile.

  4. Quit the new profile (Cmd+Q) once you've confirmed it's logged in.

From now on, both profiles can run at the same time. Open your default
Claude from the Dock for the original account, and your new launcher
for this one.

ℹ First-launch command (only needed if you didn't drag the .app yet):
  open "~/Applications/Claude WORK.app"

→ Next: activate the shell alias

The alias was added to your shell config but won't be available in
already-open terminal windows. Either open a new terminal tab, or
reload your config in this one.

ℹ Reload your shell config:
  source ~/.zshrc

ℹ Then launch your new profile with:
  claude-work

On the first run, you'll see Claude Code's normal login flow. Run
/login inside the REPL and sign in with the account for this profile.
The session is saved to the new config folder, so future launches
keep you signed in.

→ Done.
ℹ Run claude-multiprofile list to see all configured profiles.
ℹ Run claude-multiprofile status for a health check.
```

## Step 7: Verify

```
$ claude-multiprofile list

──────────────────────────────
  Configured Claude profiles
──────────────────────────────

  work (both)
    Desktop data:    ~/Library/Application Support/Claude-WORK
    Desktop launcher: ~/Applications/Claude WORK.app
    Code config:     ~/.claude-work
    Code alias:      claude-work
    Created:         2026-04-26

ℹ Registry file: ~/.config/claude-multiprofile/profiles.json
```

```
$ claude-multiprofile status

──────────────────────────
  Claude profiles status
──────────────────────────

  work (both)
    ✓ Desktop data folder: ~/Library/Application Support/Claude-WORK
    ✓ Launcher app: ~/Applications/Claude WORK.app
    ✓ Claude.app source: /Applications/Claude.app
    ✓ Code config folder: ~/.claude-work
    ✓ Shell alias "claude-work" in ~/.zshrc
✓     All checks passed.

ℹ Registry: ~/.config/claude-multiprofile/profiles.json
ℹ Shell: zsh (~/.zshrc)
```

That's it. From here:

1. Quit the personal Claude app (Cmd+Q)
2. Open `~/Applications/Claude WORK.app`, sign in with the WORK account
3. Cmd+Q
4. Now you can run both at once: personal from Dock as before, WORK from the new launcher
5. In a terminal, `source ~/.zshrc`, then `claude-work`, then `/login` inside the REPL

The whole sequence takes maybe two minutes including the sign-in flows.
