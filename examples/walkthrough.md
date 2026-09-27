# Walkthrough: setting up a work profile alongside personal

This is a worked example showing what the wizard looks like end to end, as of v0.1.31. The user's setup before starting:

- Claude Desktop installed and signed into a personal account
- Claude Code installed via npm, signed into the same personal account
- About to add a work profile, signed into a separate work account

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

? Profile name (e.g. work, personal, client-acme): work
```

## Step 2: Desktop questions

```
→ Claude Desktop configuration

Claude Desktop stores everything (login, chats, settings, MCP servers)
in a single folder. Giving the new profile its own folder gives it its
own login, chats and settings, separate from your existing Claude.

We will also create a real macOS .app launcher for this profile so you
can put it on your Dock and launch it like any other app.

ℹ Found Claude Desktop at /Applications/Claude.app.

? Data folder for this profile: (~/Library/Application Support/Claude-WORK) ↵
? Where to save the launcher .app: (~/Applications/Claude WORK.app) ↵
? Copy the Claude icon onto the launcher? (recommended) (Y/n) ↵

Claude Desktop's Dock tile always shows the standard Claude icon, even
when you customise the launcher, because the running window belongs to
Claude itself rather than to the launcher.

Giving this profile a colour works around that: it launches a private
copy of Claude.app tinted that colour, so the running window's Dock tile
is finally distinguishable. The copy is an APFS clone, which costs a few
megabytes rather than a few hundred, and Anthropic's signature stays
intact so your login keeps working.

? Dock colour for this profile: teal
```

Explanations the wizard prints before the data folder and launcher questions are trimmed here for length.

## Step 3: Code questions

```
→ Claude Code configuration

Claude Code (the terminal CLI) keeps everything under ~/.claude by
default. We'll give this profile its own config directory and add a
shell alias so you can launch it with a single command.

? Config folder for this profile: (~/.claude-work) ↵
? Shell alias to launch this profile: (claude-work) ↵

You already have a Claude Code setup in ~/.claude. We can copy your
setup into the new profile so you don't redo it: settings, CLAUDE.md,
skills, slash commands, agents, hooks, plugins, and MCP servers.

Nothing from USING that account comes along: no conversations, no
prompt history, no sessions, no caches. Sign-in does not carry over
either; Claude Code keeps it in the macOS Keychain under a key tied to
the config folder, so you'll sign in fresh on first launch.

? Copy your Claude Code setup into the new profile? (recommended) (Y/n) ↵
? Give this profile its own GitHub CLI login? (y/N) ↵
```

The GitHub CLI question only appears when `gh` is installed.

## Step 4: Review and confirm

```
→ Review

  Profile name: work

  Claude Desktop:
    Data folder: ~/Library/Application Support/Claude-WORK
    Launcher app: ~/Applications/Claude WORK.app
    Apply Claude icon: yes
    Dock colour: teal

  Claude Code:
    Config folder: ~/.claude-work
    Shell alias: claude-work
    Copy Claude Code setup: yes
    Own GitHub CLI login: no

? Apply this configuration? (Y/n) ↵
```

## Step 5: Execution

```
→ Creating Claude Desktop profile "work"
ℹ Data folder: ~/Library/Application Support/Claude-WORK
ℹ Launcher app: ~/Applications/Claude WORK.app
ℹ Claude.app source: /Applications/Claude.app
ℹ Code config for Desktop-spawned Claude Code: ~/.claude-work
✓ Data folder ready.
✓ Claude clone ready (teal).
✓ Launcher .app compiled.
✓ Updates managed by the launcher: the copy is refreshed when your main Claude updates.
✓ Claude icon applied to launcher.
✓ Launcher tinted to match.

→ Creating Claude Code profile "work"
ℹ Config folder: ~/.claude-work
ℹ Shell alias: claude-work
✓ Config folder created and seeded from ~/.claude.
✓ Carried over: settings.json, CLAUDE.md, skills, commands, plugins, 1 MCP server.
ℹ Not carried over: conversations, prompt history, sessions, caches, or sign-in.
✓ Alias "claude-work" added to ~/.zshrc (shell: zsh).

✓ Profile "work" is ready.
```

What "Carried over" lists depends on what your own `~/.claude` contains.

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

To keep it in your Dock, drag the launcher itself from ~/Applications.

Do NOT drag the Claude window's tile down while it is running. That
tile is this profile's copy of Claude, not its launcher, so clicking it
later starts the copy without its profile, on your default account.
Clicking the launcher then offers to fix it, but pinning the launcher
avoids the problem altogether.

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
...
  Additional profiles managed by claude-multiprofile:

  work (both)
    Desktop data:    ~/Library/Application Support/Claude-WORK
    Desktop launcher: ~/Applications/Claude WORK.app
    Code config:     ~/.claude-work
    Code alias:      claude-work
    Created:         2026-09-27
    To launch:
      claude-work  (Claude Code, in a terminal)
      open "~/Applications/Claude WORK.app"  (Claude Desktop)

ℹ Registry file: ~/.config/claude-multiprofile/profiles.json
```

`list` and `status` also show your default Claude install and the `claude` binary every profile shares; those sections are trimmed here.

```
$ claude-multiprofile status
...
  work (both)
    ✓ Desktop data folder: ~/Library/Application Support/Claude-WORK
    ✓ Launcher app: ~/Applications/Claude WORK.app
    ✓ Claude.app source: /Applications/Claude.app
    ✓ Code config folder: ~/.claude-work
    ✓ Shell alias "claude-work" in ~/.zshrc
✓     All checks passed.
    To launch:
      claude-work  (Claude Code, in a terminal)
      open "~/Applications/Claude WORK.app"  (Claude Desktop)

ℹ Registry: ~/.config/claude-multiprofile/profiles.json
ℹ Shell: zsh (~/.zshrc)
```

That's it. From here:

1. Quit the personal Claude app (Cmd+Q)
2. Open `~/Applications/Claude WORK.app`, sign in with the work account
3. Cmd+Q
4. Now you can run both at once: personal from the Dock as before, work from the new launcher
5. In a terminal, `source ~/.zshrc`, then `claude-work`, then `/login` inside the REPL

The whole sequence takes about two minutes including the sign-in flows. From then on, the work profile picks up new Claude versions by itself the first time you open it after your main Claude updates.
