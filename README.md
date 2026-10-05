# claude-multiprofile

[![test](https://github.com/jmdarre-v/claude-multiprofile/actions/workflows/test.yml/badge.svg)](https://github.com/jmdarre-v/claude-multiprofile/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/claude-multiprofile)](https://www.npmjs.com/package/claude-multiprofile)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](https://www.apple.com/macos/)

**Run multiple Claude accounts side by side.** Personal, work, clients. Claude Desktop and Claude Code. No more signing out of one account to use another.

```bash
npm install -g claude-multiprofile
claude-multiprofile add
```

Each profile gets its own login, chats, settings, MCP servers, plugins and skills, and its own Dock icon and terminal command:

```
Dock:      Claude        Claude WORK        Claude CLIENT
Terminal:  claude        claude-work        claude-client
```

- **Desktop and Code**, separately or together. Desktop profiles need macOS; Code profiles work on macOS and Linux.
- **Your existing Claude is untouched.** Profiles sit alongside it.
- **`doctor` keeps it working.** Claude updates itself, shells change, launchers get re-pinned. `doctor` finds what drifted, including a profile quietly open on the wrong account, and `doctor --fix` repairs what it safely can.

> **See it in action:** [examples/walkthrough.md](./examples/walkthrough.md), a full session showing every prompt and output.

> **Disclaimer.** This is an unofficial community tool. It uses public Electron flags (`--user-data-dir`) and a stable but undocumented Claude Code environment variable (`CLAUDE_CONFIG_DIR`) to keep profiles isolated. Anthropic engineers have engaged on the open feature requests for native multi-account in both apps, so the approach is well known, but it is not officially supported. If a future Claude release changes how profiles work, this tool will need to catch up.

## Why this exists

Claude Desktop and Claude Code both assume a single signed-in account. There's no built-in profile switcher today (open feature requests: [Desktop](https://github.com/anthropics/claude-code/issues/32783), [Desktop UI](https://github.com/anthropics/claude-code/issues/18435)). The standard workaround is a manual setup:

- For Desktop, launch with `open -n -a "Claude" --args --user-data-dir=...` against a custom data folder
- For Code, set `CLAUDE_CONFIG_DIR=...` before running `claude`

Both work. Both are fiddly to set up and easy to mess up. This tool automates the whole thing, including the things people forget:

- Generating a real macOS `.app` launcher you can drag to the Dock
- Copying the Claude icon onto the launcher so it's visually distinct
- Adding a properly quoted shell alias to the right rc file (zsh, bash, fish)
- Copying your Claude Code setup (settings, skills, commands, plugins, MCP servers) into a new profile, without your conversations, history or sign-in
- Copying your default profile's Desktop MCP connectors into a new profile when you choose to, and showing later which ones a profile doesn't have
- Tracking everything in a registry so you can list, status-check, and cleanly remove profiles

## Install

```bash
npm install -g claude-multiprofile
```

To upgrade later, run `claude-multiprofile upgrade`. It installs the latest version and then applies that version's changes to your existing profiles (the same as `doctor --fix`), in one step. Add `--no-fix` to install only.

Re-running the install command above also works, but it only replaces the code: new launchers, the launch helper and similar changes reach your profiles through `doctor --fix`. Until that has run, every command reminds you.

### Install the latest unreleased commit

If you want changes that haven't been published to npm yet:

```bash
npm install -g github:jmdarre-v/claude-multiprofile
```

### Requirements

Node 18 or newer. macOS is required for Claude Desktop profiles. Claude Code profiles work on macOS and Linux.

## Quick start

```bash
claude-multiprofile add
```

The wizard walks you through every choice, explains what each step does, and lets you accept defaults if you don't care. A typical first run takes about 30 seconds.

After it finishes, you'll have a new launcher .app on your Dock (for Desktop) and a new shell alias like `claude-work` (for Code). Sign in once on each, and you're done.

## What gets created

For a profile named `work`, with both Desktop and Code targets, the tool creates:

```
~/Library/Application Support/Claude-WORK/    ← Desktop data folder
~/Applications/Claude WORK.app                ← Desktop launcher (drag to Dock)
~/.claude-work/                               ← Code config folder
~/.zshrc                                      ← adds: alias claude-work='...'
~/.config/claude-multiprofile/profiles.json       ← registry entry
```

Nothing about your existing default Claude install changes. Your current login, chats, MCP servers, and skills stay exactly where they are.

## How it works

### Claude Desktop

Claude Desktop is built on Electron. Electron honors the `--user-data-dir` command-line flag, which moves the entire app state (auth tokens, chat list, settings, MCP connectors, projects, custom styles) to a directory of your choosing. Two `.app` launchers pointed at two different data folders give you two fully independent Desktop instances.

The launcher .app is a tiny AppleScript bundle generated by `osacompile`, a built-in macOS tool. The script is one line: `do shell script "open -n -a 'Claude' --args --user-data-dir='/path/to/your/profile'"`. The `-n` flag forces a new instance even when Claude is already running, which is what makes side-by-side launches work.

Since v0.1.12, a profile that has both Desktop and Code targets also gets `--env 'CLAUDE_CONFIG_DIR=...'` in that launch line. `--user-data-dir` only isolates Desktop itself; the Claude Code sessions Desktop spawns would otherwise read `~/.claude` in every profile, quietly merging `CLAUDE.md`, `settings.json`, and per-project memory across profiles that look isolated. Setting the variable on the launched app propagates it to the CLI processes Desktop starts.

Launchers built before v0.1.12 keep their old launch line. Run `claude-multiprofile doctor` to find them and `doctor --fix` to rebuild them in place, which preserves the icon and bundle ID.

Desktop's MCP connectors live in `claude_desktop_config.json` **inside** the data folder, which is why a brand-new profile opens with none of the ones you had configured. When your default profile has some, `add` asks whether to copy them, and says that their settings come along as they are, including any API keys or tokens, which belong to your default account. The copy only adds: it never replaces a connector the profile already has, keeps every other key in the file (`preferences` included), and leaves a file that does not parse alone. Later, `doctor` shows which of your default profile's connectors a profile doesn't have, and `claude-multiprofile extensions` copies the ones you pick. Nothing is copied without asking, `upgrade` included.

### Keeping a profile in the Dock

Drag the **launcher** from `~/Applications` into the Dock. Do not drag the Claude window's tile down while the profile is running.

That tile belongs to Claude itself rather than to the launcher, because the launcher spawns Claude and exits immediately. Pinning it pins the profile's own copy of Claude.app, and that copy holds no profile of its own: `--user-data-dir` is supplied by the launcher at spawn time, so a click that starts the copy directly opens the shared default profile and whichever account is signed in there. It is the usual reason a profile icon appears to "stop working" and has to be re-pinned.

Before v0.1.23 every profile shared `/Applications/Claude.app`, so the tile you pinned was visibly the stock app. Now it is the profile's own copy, carrying the profile's colour and name, which makes a wrongly pinned tile much harder to spot. It looks exactly like the launcher until you notice the account is wrong.

Spotlight, a Login Item, and Claude relaunching itself after an update all start the copy the same way, with the same result. `doctor` reports a copy that is running without `--user-data-dir`, and flags a copy that is pinned to the Dock.

Rebuilding a launcher (through `rename`, `doctor --fix`, or linking a missing half) preserves the bundle rather than replacing it, so an existing pin keeps working.

v0.1.22 briefly marked launchers as background agents to hide a flicker. That stopped macOS keeping them pinned at all, and v0.1.24 reverted it.

Since v0.1.23, clicking the icon again focuses the profile's existing window rather than opening a second copy. Each Desktop profile launches its own cloned copy of Claude.app, so `open` can address that profile specifically instead of forcing a new instance the way it must when profiles share one app.

One thing that cannot be fixed: the running window is titled "Claude", not the profile name. That comes from `CFBundleName` inside the app, and editing it fails code signing and Gatekeeper. Give profiles different colours if you need to tell their windows apart.

If a launcher's Dock icon is blank, its `applet.icns` is being overridden by the stock icon catalog `osacompile` ships. `doctor` reports it and `doctor --fix` or `repair` removes the catalog so the Claude icon is used. The same commands backfill the per-profile copy that older profiles lack.

### Per-profile Dock colours

Optional, and off by default. Choosing a colour during `add` gives the profile its own tinted copy of Claude.app, and the launcher opens that copy instead of the shared `/Applications/Claude.app`. Because the running process is now the tinted copy, its Dock tile finally carries the colour. This is what closes [issue #2](https://github.com/jmdarre-v/claude-multiprofile/issues/2).

Eight colours are available: orange, red, yellow, green, teal, blue, purple, pink. Claude's own icon is hue-rotated, so it still looks like Claude.

What it costs, stated plainly:

- **Disk: a few megabytes, not a few hundred.** The copy is an APFS clone (`cp -Rc`), so its blocks are shared with the original until one side changes. Measured on an 800MB Claude.app: about 1.5 seconds and 3MB of real disk.
- **Signature: identity survives, strict verification does not.** The tint is attached as Finder metadata rather than by editing the bundle, so the copy still reports `com.anthropic.claudefordesktop` with Anthropic's Team ID, and Gatekeeper accepts it. `codesign --verify --deep --strict` does fail on it, the same as for any app carrying a custom icon.
- **Updates: see [How profiles stay up to date](#how-profiles-stay-up-to-date).** The copy is a real Claude.app, so left alone it updates itself, and each self-update throws away the colour and relaunches the copy on the wrong account. Since v0.1.29 the launcher keeps the copy current instead.

### How profiles stay up to date

Each Desktop profile runs its own copy of Claude.app. An earlier version of this README said that copy does not update itself. That was wrong, as [issue #9](https://github.com/jmdarre-v/claude-multiprofile/issues/9) showed: it is a real Claude, so Claude's own updater runs inside it. Every such update does three things you do not want. It throws away the profile's colour. It relaunches the copy **without** the launcher's `--user-data-dir`, so the new window is on your default account while looking like the profile. And it shares one update state file with your main Claude, since macOS sees them as the same app.

Since v0.1.29, profiles are updated differently:

1. **The copy's own updater is blocked, per profile.** Claude supports a "Block auto-updates" policy (`disableAutoUpdates`), and reads it from a folder named after the profile's data folder (`Claude-WORK-3p/`), so it applies to that profile alone. Your main Claude, in `/Applications`, keeps updating itself exactly as before. The tool only ever writes that folder when it does not exist, because it is also where Claude keeps a third-party inference setup (Bedrock, Vertex, a gateway), and it never edits a configuration it did not create.
2. **The launcher keeps the copy current.** When you click a profile, its launcher first compares the copy with `/Applications/Claude.app`. If the copy is behind, it rebuilds it (about a second, as an APFS clone), puts the colour back, and then opens it. So a profile picks up a new Claude the first time you open it after your main Claude updates. If anything goes wrong, it logs the problem and opens the copy as it is: the helper is never the reason Claude does not open.
3. **The launcher catches the wrong account.** If you click a profile while its copy is already open on the wrong account (from a pinned window tile, Spotlight, a Login Item, or an update relaunch), it asks whether to quit that window and reopen the profile properly. It asks rather than quitting on its own, so nothing unsaved is lost.

The launcher's work is done by a small helper at `~/Library/Application Support/claude-multiprofile/bin/launch.js`. It runs with `osascript`, which ships with macOS, because apps started from the Dock do not get your shell's `PATH` and so cannot rely on Node. Its log is `launch.log` in the same folder, and `doctor` reports any errors from it.

Two things to know:

- **The Code tab in Claude Desktop is pinned the same way.** Desktop keeps its own copy of Claude Code per profile and updates it with the same policy, so a profile's Code tab moves forward when its copy is rebuilt. The `claude-<name>` command in your terminal is unaffected: it runs your npm-installed `claude`.
- **You can opt a profile out.** `claude-multiprofile self-update <name> on` lets Claude update that profile's copy itself again, with the drawbacks above. `self-update <name> off` returns it to the default.

Profiles created before v0.1.29 are switched over by `claude-multiprofile doctor --fix`, which installs the helper, rebuilds their launchers in place (a Dock pin keeps working), and sets up the block. It takes effect the next time each profile starts.

`remove` deletes the copy along with the profile. No build tools are required: the tinting and icon work go through `osascript`, which ships with macOS.

### Claude Code

Claude Code (the terminal CLI) honors the `CLAUDE_CONFIG_DIR` environment variable. Set it to a folder, and Claude Code reads/writes all of its state (project memory, plugins, skills, MCP servers, slash commands) under that folder instead of the default `~/.claude`.

Authentication is the interesting bit. Claude Code stores its OAuth token in the macOS Keychain under a key derived from the active `CLAUDE_CONFIG_DIR`. Different config dir, different Keychain entry, separate session.

The wizard offers to copy your existing Claude Code setup into a new profile, so you don't redo it: `settings.json`, `CLAUDE.md`, skills, slash commands, agents, hooks, output styles, installed plugins, and your MCP servers (the `mcpServers` entry of `~/.claude.json`, and nothing else from that file). It works from an allowlist: anything not on that list stays behind, including your conversations (`projects/`), prompt history, sessions, shell snapshots, caches, plugin data and anything added in future that the tool doesn't know about. Paths in plugin manifests and settings that pointed into `~/.claude` are pointed at the new profile's own copies, so it doesn't keep loading plugins or hooks from your default setup. The new profile still asks you to sign in fresh.

Profiles created before v0.1.31 were seeded by copying the whole of `~/.claude`, which brought conversation history along. `doctor` reports how many conversations a profile got that way. It doesn't delete them: whether to keep them is up to you.

## Commands

### `claude-multiprofile add`

Interactive wizard. Walks through:

1. Whether to set up Desktop, Code, or both
2. The profile name (e.g. `work`, `personal`, `client-acme`)
3. Where the data/config folders should live
4. Where to save the launcher .app (Desktop only)
5. Whether to copy the Claude icon onto the launcher (Desktop only)
6. The shell alias name (Code only)
7. Whether to copy your Claude Code setup into the new profile (Code only; conversations and sign-in never come along)

Then prints a plan, asks for confirmation, and applies.

**Completing a half-built profile.** If you enter a name that already exists but is missing the half you selected, `add` offers to link it rather than refusing. Set up a Desktop profile months ago and only now want its Claude Code isolated too? Run `add`, choose Claude Code, and give it the existing name. It creates the config folder and alias, then **rebuilds the Desktop launcher** so the app points Claude Code at the new folder. Without that rebuild the link would be cosmetic and Desktop would keep spawning the shared `~/.claude`. Your existing chats, login, and settings are untouched.

The wizard refuses to claim a directory that belongs to something else. The names `mem`, `profiles`, `multiprofile`, `code`, and `desktop` are reserved outright, since each would collide with another tool's folder or this tool's own config. Beyond that, if the folder you pick already exists and is not already registered here, you get a warning describing what is in there and a chance to back out. This stops a profile named `mem` from quietly pointing at `~/.claude-mem` and, later, a `remove` from offering to delete another tool's data.

**Optional: a separate GitHub CLI login.** If `gh` is installed, `add` offers to give the profile its own GitHub account. `gh` honors `GH_CONFIG_DIR` the same way Claude Code honors `CLAUDE_CONFIG_DIR`, so the profile gets its own `hosts.yml` at `~/.claude-{name}/gh` and every `gh` command Claude runs inside that profile acts as that account. Useful when a profile maps to a client or employer with its own GitHub org.

Off by default, since one GitHub identity across all your Claude profiles is what most setups want. After enabling it, sign in once:

```bash
GH_CONFIG_DIR=~/.claude-work/gh gh auth login
```

The folder lives inside the profile, so `rename` moves it and `remove` deletes it without any extra step. Both surfaces get the variable: the shell alias covers `claude-{name}` in a terminal, and the Desktop launcher covers Claude Code opened from inside the Desktop app.

One caveat `doctor` will warn you about: if `GH_TOKEN` or `GITHUB_TOKEN` is exported in your shell, `gh` prefers it over any config directory and every profile will use that token regardless.

**Already have a profile?** Run `add`, pick the same targets, and enter the existing name. If the profile predates this feature, `add` offers to turn it on, rewrites the alias, and rebuilds the launcher.

### `claude-multiprofile list`

Prints every configured profile with its paths and creation date, plus the `claude` binary currently winning on your PATH and its version. All profiles share that one binary, so it is worth seeing alongside them.

Each profile ends with a "To launch" block naming the exact command. Worth reading rather than inferring: profile names of four characters or fewer are uppercased in the paths this tool creates, so `ipsy` becomes `Claude-IPSY` on disk while the command stays `claude-ipsy`, and shell command names are case-sensitive.

### `claude-multiprofile status`

Walks every profile and verifies the directories, .app, and shell aliases still exist. Also reports the resolved `claude` binary and warns when more than one is on your PATH. Useful after a machine migration or after manually editing your `.zshrc`.

It also checks whether the terminal you are standing in agrees with the file. A shell reads its rc file once, at startup, so a session opened before your last `add`, `rename` or `remove` still has the aliases from back then. After a rename that is actively misleading: the old alias is still defined, still runs, and still points `CLAUDE_CONFIG_DIR` at a directory that has since been moved. Every check above would pass while the command in front of you is broken. When `status` sees a session older than the aliases, it says so and tells you to re-source or open a new terminal.

This needs to know when the aliases last changed, which is not the same as when the rc file was last touched, since installers and you edit dotfiles for unrelated reasons. The managed block therefore carries its own timestamp, written only when the aliases actually change. Blocks written before v0.1.27 have no timestamp, so the check stays quiet for them until the next time your aliases change.

### `claude-multiprofile doctor [--fix]`

Diagnoses the machine, not just the registry. Where `status` asks "is each profile's paperwork in order?", `doctor` asks "will these profiles actually behave?"

It checks:

- **Which `claude` wins on PATH**, its version, and any shadowed copies. Every profile shares one binary, so a duplicate from another Node version is a common cause of "I upgraded and nothing changed."
- **Broken npm installs.** A package directory left with `node_modules/` but no `package.json` silently de-registers the command and lets PATH fall through to an older copy. It also checks that what each package declares as its executable exists, is executable, and actually runs, since a postinstall that stops partway leaves a perfect `package.json` behind a command that cannot start. And it compares the version the command reports against the version the package claims, which catches an install that fetched a different build than its manifest describes.
- **Directory collisions.** A profile pointing at another tool's data folder (`~/.claude-mem`, `~/.claude-profiles`), or two profiles sharing one directory.
- **Launcher bundle IDs.** Launchers created before v0.1.9 still carry the default AppleScript bundle identifier; with two or more of them, macOS confuses the launchers and Dock double-clicks stop working.
- **Launchers that don't export `CLAUDE_CONFIG_DIR`.** Launchers created before v0.1.12 let Claude Code sessions started from inside Desktop fall back to the shared `~/.claude`. `doctor` reads the launcher's compiled script to find them, and `--fix` rebuilds them in place.
- **How Desktop is actually being started.** A profile's copy of Claude.app is isolated by the `--user-data-dir` the launcher passes it, so a copy started any other way (a Dock tile pinned from the running window, Spotlight, a Login Item, Claude relaunching itself after an update) runs on the shared default profile instead. Nothing looks wrong; it is just the wrong account. `doctor` reports any copy running without the argument, and flags a copy pinned to the Dock, which is the usual cause.
- **Two profiles signed in as the same account.** The same wrong-account symptom from a different cause. Signing in uses a `claude://` deep link, and with two Claude windows open the callback can reach the wrong instance, putting the token in the wrong data folder. The profile then opens the right folder while authenticated as the wrong account. Comparing the recorded account across profiles is the only visible signal, and `doctor` now does it. Recovery is manual: quit every Claude window, open only the affected profile, sign out, and sign back in with nothing else running.
- **How each profile updates.** Whether its copy of Claude is blocked from updating itself and kept current by its launcher (see [How profiles stay up to date](#how-profiles-stay-up-to-date)), whether its launcher uses the launch helper, whether that helper is installed and current, and any errors the helper logged in the last week. Separately, it checks each coloured copy still has its colour, since an update removes it.
- **Desktop MCP connectors a profile doesn't have.** Copying them at creation is a snapshot, and the default profile keeps changing. `doctor` names the default profile's connectors each profile doesn't have, as information: often a profile is meant to be without some of them. It never copies them, even with `--fix`, because their settings can carry the default account's credentials and `upgrade` runs `--fix` on its own. `claude-multiprofile extensions` copies the ones you pick.
- **A corrupt registry file.** A registry that exists but isn't valid JSON otherwise masquerades as "no profiles configured". Mutating commands refuse to run until it's fixed, and every write keeps a `.bak` of the last good version next to it.
- **Cross-profile read protection** drift (see [Profile isolation](#profile-isolation) below).

`--fix` repairs what's safe to repair automatically: deny-rule drift, default bundle IDs, launchers missing `CLAUDE_CONFIG_DIR`, a lost colour, a missing or outdated launch helper, launchers that do not use it, and profiles whose copy still updates itself. It never rebuilds a copy that is open, because deleting an app while it runs can crash it. Everything else is reported with the command to run.

### `claude-multiprofile rename [old] [new]`

Renames a profile and moves everything that encodes its name: the Code config folder, the shell alias, the Desktop data folder, the launcher `.app` and its bundle ID, the registry entry, and every other profile's isolation rules.

Paths you chose manually are left where they are; only folders still at their default location get moved. The profile's copy of Claude and its update settings move with it.

A Desktop profile that is open is refused: its data folder is about to move, and a running Claude keeps writing to the path it started with. Quit it first.

**Renaming a Code profile signs it out.** Claude Code stores its login in the macOS Keychain under a key derived from the config folder path, so moving the folder orphans the token and you'll run `/login` once more. This tool deliberately does not try to move the Keychain entry: the key derivation isn't reproducible, and guessing risks clobbering a different account's credentials. Chats, skills, and MCP config all move normally. Desktop profiles are unaffected, since their auth lives inside the folder being moved.

### `claude-multiprofile extensions`

Copy Claude Desktop extensions and MCP connectors from one install into another, interactively. It prompts for the source (your default install or any profile) and then the target profile. There is no profile name to mistype, and cross-profile copying works in both directions.

When you create a profile, it starts empty by design: none of your default install's extensions, settings, or chats follow it over. That isolation is the point. But re-installing every extension on every profile by hand is tedious. This command is the relief valve.

The flow:

1. Reads the extension list from your default Claude Desktop data folder (`~/Library/Application Support/Claude/Claude Extensions/`)
2. Shows a multi-select prompt with each extension. Extensions already in the target profile are pre-deselected; new ones are pre-selected
3. Copies the selected extension folders AND their matching settings files (`Claude Extensions Settings/<id>.json`) into the target profile
4. If conflicts exist, asks once whether to overwrite (or use `--force` to skip the prompt)

```bash
claude-multiprofile extensions            # interactive: pick source, then target
claude-multiprofile extensions --force    # overwrite conflicts without asking
```

Restart Claude Desktop after running this for the new extensions to load.

This command does not apply to Code-only profiles (extensions are a Desktop concept).

### `claude-multiprofile repair [name]`

Re-registers a profile's launcher .app with macOS LaunchServices. Use this if the Dock icon stops responding to double-clicks even though the .app bundle is intact and `open path/to/Claude\ Work.app` from the terminal still works.

The underlying cause is a stale LaunchServices cache, which can happen after macOS updates, app moves, or sometimes for no clear reason. The command runs `lsregister -f` on the launcher and touches the bundle to nudge the icon cache. Running it on a healthy profile is harmless.

For Code-only profiles, this command has nothing to repair (there's no .app) and exits cleanly.

### `claude-multiprofile remove [name]`

Tears down a profile. Refuses while the profile is open in Claude Desktop, since it deletes the profile's copy of Claude. Unregisters and removes the launcher .app, removes the shell alias and the registry entry, and rewrites the remaining profiles' isolation rules. By default the data folders are kept (so you can recover your chats if you change your mind). The wizard asks separately about deleting the data folders.

One thing it deliberately leaves behind: the profile's saved login in your Keychain. Claude Code keys those entries by a hash of the config directory that this tool can't reproduce, and deleting the wrong one would take out another account's credentials. The orphan is inert. To avoid creating one, run `/logout` inside the profile before removing it; to clear it by hand, search Keychain Access for `Claude Code-credentials`.

### `claude-multiprofile self-update [name] [on|off]`

Shows or changes who updates each Desktop profile's copy of Claude. `off` is the default: the copy's own updater is blocked and its launcher keeps it current. `on` lets Claude update the copy itself, as before v0.1.29, which relaunches it on your default account and removes its colour on every update. See [How profiles stay up to date](#how-profiles-stay-up-to-date).

```bash
claude-multiprofile self-update              # every profile's mode
claude-multiprofile self-update work on      # let Claude update it itself
claude-multiprofile self-update work off     # back to the default
```

### `claude-multiprofile upgrade [--no-fix]`

Upgrades to the latest version on npm and applies its changes to your profiles, in one step.

It installs the exact version it found (not `@latest`, which npm can answer from a stale cache in the minutes after a release) and then checks what actually landed. If npm installed an older version, it says so and asks you to retry in a minute. If the new version landed in a different Node version's folder than the one your shell uses (common with nvm), it says that instead, and applies nothing until PATH is sorted. When everything checks out, it runs the new version's `doctor --fix`, so launchers, the launch helper and profile settings are brought up to date. `--no-fix` stops after the install.

If you are already on the latest version but its changes were never applied (for example, you upgraded with plain `npm install -g`), `upgrade` applies them.

### `claude-multiprofile help` / `--version`

Self-explanatory.

## First-launch checklist

This is the part most guides skip and most users get burned by.

### Desktop: signing in for the first time

Claude Desktop's sign-in flow uses a `claude://` deep link that macOS hands to whichever Claude instance is running. If two are open at once, the auth token can land on the wrong one and you'll end up with both profiles signed into the same account.

The fix is simple but important:

1. Quit any other Claude window with **Cmd+Q** before doing the very first launch of the new profile.
2. Double-click the new launcher (or run `open ~/Applications/Claude\ WORK.app`).
3. Sign in with the account for this profile.
4. Quit (Cmd+Q) once you've confirmed it logged in correctly.

From that point on, both profiles can run simultaneously. The auth token is stored in the per-profile data folder and won't get re-routed.

### Code: signing in for the first time

```bash
source ~/.zshrc          # or open a new terminal tab
claude-work              # launches Claude Code with CLAUDE_CONFIG_DIR set
```

Inside the REPL, run `/login`. A browser tab opens. Sign in with the account for this profile. The OAuth token gets stored in Keychain under a key derived from the profile's config dir, so it's fully separate from your default account.

## Common patterns

### Per-project default profile

If you always want a specific profile active in a particular repo, drop a `.envrc` (with [direnv](https://direnv.net/)) or a `.env` file:

```bash
export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
```

When you `cd` into the repo, the variable is set automatically. Plain `claude` from inside that directory uses the right profile.

### Visual disambiguation

By default, all profile launcher .apps share the Claude icon. If you want them visually distinct on the Dock:

1. Right-click `~/Applications/Claude WORK.app` → Get Info
2. Drag any image (PNG, ICNS, JPG) onto the small icon in the top-left of the Info window
3. The Dock and Cmd-Tab will pick up the new icon within a few seconds

For the terminal side, you can prefix with a colored slash command:

```bash
alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude -e "/color blue"'
```

`/color` makes the Claude Code REPL prompt visually distinct so you don't lose track of which account you're in.

### Sharing skills between profiles

Profiles are independent, so installing a skill in one doesn't affect the others. If you want one set of skills available to all your profiles, symlink the `skills` directory:

```bash
rm -rf ~/.claude-work/skills
ln -s ~/.claude/skills ~/.claude-work/skills
```

Same trick works for plugins or any sub-folder you want to share. Be careful with `projects/` if you want chat history to stay separate, that's the folder you do *not* want shared.

## Troubleshooting

**The new Desktop profile launched already signed into my other account.**

You launched it while the other Claude instance was running. The `claude://` auth deep link got routed to the wrong app. Fix:

```bash
rm -rf ~/Library/Application\ Support/Claude-WORK
```

Then quit ALL Claude windows (Cmd+Q) and launch the new profile again. It'll start fresh and you can sign in cleanly.

**The launcher icon stopped responding to double-clicks but `open` from terminal still works.**

This is a stale macOS LaunchServices cache, often combined with a stale Dock icon cache. Run:

```bash
claude-multiprofile repair <profile-name>
```

The command re-registers the .app with LaunchServices, refreshes the icon cache, and restarts the Dock so it picks up the new registration. The Dock will blink briefly (less than a second) and then come back. If clicking still doesn't work after that, log out and back in to force a full LaunchServices reset.

**The shell alias isn't found.**

Aliases live in your shell's rc file but they only get loaded when a new shell starts. Either open a new terminal tab or `source ~/.zshrc` (or whatever your shell's rc file is). Run `claude-multiprofile status` to confirm the alias is actually in the rc file.

**The launcher .app shows the AppleScript icon, not Claude's.**

You answered "no" to the icon copy step, or your Claude.app install is in a non-standard location. Either re-run `claude-multiprofile add` (and remove the old profile first) or copy the icon manually:

```bash
cp /Applications/Claude.app/Contents/Resources/*.icns \
   ~/Applications/Claude\ WORK.app/Contents/Resources/applet.icns
touch ~/Applications/Claude\ WORK.app
```

**I want to see what's in the registry.**

```bash
cat ~/.config/claude-multiprofile/profiles.json
```

It's a plain JSON file. You can inspect or hand-edit it, though running the CLI commands is safer.

**I'm on Linux.**

The Code half works fine on Linux, the Desktop half doesn't (Claude Desktop is macOS-only at the moment). The wizard skips Desktop questions on non-macOS automatically.

## Comparison with similar tools

Several good tools work on this problem, and they make different trade-offs. The main one is whether accounts run **side by side**, each in its own window or terminal at the same time, or whether you **switch** one active account. Each row below is based on that project's own README as of September 2026.

| Tool | Desktop | Code | Accounts at once | GitHub login per profile | Diagnostics | Notes |
|------|---------|------|------------------|--------------------------|-------------|-------|
| **claude-multiprofile** (this) | ✅ | ✅ | ✅ side by side, Desktop and Code | ✅ | ✅ diagnose and repair (`doctor`, `--fix`) | Interactive wizard; each Desktop profile kept current on launch |
| [Claude Profiles](https://github.com/ajipurn/claude-profiles) | ✅ | ✅ | switch | ❌ | ❌ | Menu bar app; per-account usage limits from Claude's local cache |
| [claude-profiles](https://github.com/calebbarzee/claude-profiles) | ✅ | sessions | ✅ side by side, Desktop | ❌ | partial (`inspect`, `optimize`) | Moves Claude Code sessions into Desktop profiles; `backup`, `undo`, `--dry-run` |
| [claude-desktop-profiles](https://github.com/odahcam/claude-desktop-profiles) | ✅ | ❌ | ✅ side by side, Desktop | ❌ | ❌ | Per-profile Dock colours |
| [aimux](https://github.com/Digital-Threads/aimux) | ❌ | ✅ | ✅ side by side | ❌ | diagnose (`doctor`) | Live usage in `status`; shares files between profiles with symlinks |
| [aisw](https://github.com/burakdede/aisw) | ❌ | ✅ | switch | ❌ | ✅ diagnose and repair (`doctor`, `repair`) | Also Codex CLI, Gemini CLI and Antigravity CLI |
| Manual setup | ✅ | ✅ | ✅ side by side | by hand | ❌ | Documented in [several](https://daring-designs.com/blog/how-to-run-multiple-claude-code-accounts-side-by-side) [places](https://wmedia.es/en/tips/claude-code-multiple-profiles-config-dir) |

[Jean-Claude](https://madewithlove.com/blog/running-multiple-claude-accounts-without-logging-out/) is a dotfiles approach for Claude Code with cross-machine sync, described in a blog post rather than shipped as a tool.

Where this one fits: Claude Desktop **and** Claude Code for several accounts open at the same time, each profile carrying its own GitHub login so `gh` acts as the right account, and a `doctor` that finds what drifted and repairs it as Claude updates itself. It is the only one of these that gives each profile its own GitHub login, and one of the few with a `doctor` that repairs what it finds rather than only reporting it. If you only use Claude Code, or prefer switching one active account, the tools above may suit you better.

## Profile isolation

Profiles are isolated by **configuration**: each one points Claude at a different config/data directory (`CLAUDE_CONFIG_DIR` for Code, `--user-data-dir` for Desktop). That fully separates identity and storage: separate logins, chats, settings, and MCP connectors.

What it does **not** do on its own is restrict what a running profile can *reach* on disk. A broad filesystem search from `$HOME` could surface a sibling profile's `CLAUDE.md`, skills, or MCP config, and pull the wrong context into the conversation. The design isolates identity and storage, but not discovery, a framing owed to @miketaus in [issue #4](https://github.com/jmdarre-v/claude-multiprofile/issues/4).

Since v0.1.10, Code profiles get an enforceable guard. Every profile's `settings.json` receives `permissions.deny` rules blocking reads of every *other* profile's directories:

```json
{
  "permissions": {
    "deny": ["Read(//Users/you/.claude-work/**)"]
  }
}
```

These are hard denials (they don't prompt), and Claude Code applies `Read` rules to Grep and Glob as well, so directory walks are covered too. The rules are rewritten automatically on `add`, `remove`, and `rename`, and `doctor --fix` repairs them if they drift.

Four things worth knowing:

- **Your own rules are preserved.** The tool tracks only the rules it wrote and never removes deny rules you added yourself.
- **A symlinked `settings.json` is skipped.** If a profile's `settings.json` is a symlink pointing outside that profile (a common way to share one config across profiles), the rules are not written. Writing them would push one profile's rules into a file the others also read, and each profile would then strip the others' rules on every change. `doctor` reports the profile as unprotected and names the link target; replace the link with a real file to opt back in.
- **You can turn it off.** If your profiles are meant to read each other's files, set `"readProtection": false` at the top level of `~/.config/claude-multiprofile/profiles.json`. The next `add`, `remove`, `rename`, or `doctor --fix` removes the rules it wrote (yours stay), none of them write new ones, and `doctor` stops reporting them as missing. Delete the key and run `doctor --fix` to turn it back on.
- **Desktop profiles have no equivalent hook.** Claude Desktop is Electron, not Claude Code, so there's no settings-level permission system to use. Desktop profiles remain isolated by data directory only. True filesystem confinement there would require `sandbox-exec` or a container.

## Known limitations

### Dock icons (fixed in v0.1.21)

Claude Desktop's Dock tile used to always show the standard Claude icon, even with a customised launcher, because the running window belongs to Claude's own process rather than to the launcher that started it.

Since v0.1.21 you can give a profile a colour, and it launches a private tinted copy of Claude.app instead. See [Per-profile Dock colours](#per-profile-dock-colours).

### Chats and Projects don't transfer between profiles

Profiles isolate accounts, so there's no way to move a conversation or a Desktop Project from one profile to another. Those live server-side, tied to the account that created them; this tool only ever touches local files and never talks to Claude's servers.

Your **project files on disk are already shared**, since profiles redirect Claude's own state, never your working directory. Any profile can open the same repository. What doesn't follow you is conversation history and account-bound Projects.

If you're switching profiles to spread usage across accounts, the workflow that works is to keep the context in the repository rather than in the chat: a `CLAUDE.md` (or a notes file) that any profile reads on start, so a fresh conversation in another account picks up where the last one left off.

## Security notes

To report a vulnerability, see [SECURITY.md](SECURITY.md). Please don't open a public issue for it.

**What the tool writes:**

- `~/Library/Application Support/Claude-{NAME}/`: each Desktop profile's data folder, created new. When you choose to copy MCP connectors (in `add`, or with `extensions`), its `claude_desktop_config.json` gains the ones you picked; connectors it already has, every other key (`preferences` included), and a file that does not parse are left as they are.
- `~/Library/Application Support/Claude-{NAME}-3p/`: the setting that stops that profile's copy of Claude updating itself. Only written when the folder does not exist, because Claude also keeps third-party inference setups there; never edited if the tool did not create it.
- `~/Library/Application Support/claude-multiprofile/`: each profile's copy of Claude.app (`apps/`, APFS clones carrying the colour as Finder metadata), the launch helper (`bin/launch.js`) and its log (`launch.log`).
- `~/Applications/Claude {NAME}.app`: each profile's launcher, created new, and registered with macOS LaunchServices.
- `~/.claude-{name}/`: each Code profile's config folder. When you choose to seed it, the tool copies setup from `~/.claude` from an allowlist, and the `mcpServers` entry of `~/.claude.json`, and points paths in plugin manifests and settings at the profile's own copies. It adds cross-profile `permissions.deny` rules to `settings.json`, tracking only the rules it wrote and never removing yours. With GitHub CLI isolation on, `gh/` inside it holds that profile's `gh` login.
- `~/.zshrc`, `~/.bash_profile` or `~/.config/fish/config.fish`: a delimited managed block of aliases. Lines outside the markers are never touched.
- `~/.config/claude-multiprofile/`: the registry (`profiles.json`, with a `.bak` of the last good version) and `state.json`, which records which version's fixes have been applied.

**What it only reads:**

- Your default `~/.claude`, when seeding; and for `doctor`, the names of its conversation files (to spot ones an older seed copied), never their contents.
- `~/.claude.json`, when seeding: only the `mcpServers` entry is used.
- `~/Library/Application Support/Claude/claude_desktop_config.json`, your default Desktop profile's: only its `mcpServers` entry, to offer connectors when you create a profile and to show which ones each profile doesn't have.
- Each Desktop data folder's `config.json`, for the account ID `doctor` uses to catch two profiles signed in as the same account.
- The running process list and the Dock's list of pinned apps, for `doctor`'s check that each profile was started through its launcher.
- `/Applications/Claude.app`, to copy it and compare versions.

**What it never does:**

- Read or write the macOS Keychain, where Claude Code keeps its sign-in.
- Write to your default Claude: `~/Library/Application Support/Claude/`, `~/.claude` or `~/.claude.json`.
- Delete conversations unless you ask it to. `remove` offers to delete a profile's folders, each behind its own confirmation that defaults to no. `doctor` only reports conversations an older seed copied into a profile and leaves the decision to you.
- Quit a Claude window without asking. The launch helper only quits a profile's window that is open on the wrong account, after you confirm in a dialog.
- Contact anything except the npm registry, for `upgrade` and `doctor`'s version check.

The one direct npm dependency is `@inquirer/prompts`, the interactive-prompt library, which brings 31 more packages with it. Everything else uses tools that ship with macOS.

## Contributing

Issues and PRs welcome. The codebase is small and aggressively commented, so it should be easy to navigate. Run the tests with `npm test`.

## License

MIT
