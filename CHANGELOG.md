# Changelog

All notable changes to claude-multiprofile. Versions follow semver; the
project is pre-1.0, so minor breakage may occur between 0.x releases.

## Unreleased

### Added

- **Desktop profiles start with the MCP connectors you already had.** Desktop
  reads its connectors from `claude_desktop_config.json` inside the
  `--user-data-dir`, so a new profile opened with none of them: every
  connector configured in the default profile was missing, with no command to
  carry them over. Code profiles already got theirs from `seedConfigDir()`.
  `add` now copies the `mcpServers` map from the default profile's Desktop
  config, and `doctor` compares each profile against it afterwards, since
  copying at creation is only a snapshot: `--fix` copies over what is missing.
  The map is updated rather than the file replaced, because that file also
  holds `preferences` and may hold servers added by hand in that profile; a
  config that does not parse is reported and left untouched.

## 0.1.31 (2026-09-27)

### Fixed

- **Seeding a Code profile copied your conversations into it.** The seed
  copied the whole of `~/.claude` and then deleted three credential
  filenames, so it also copied the default account's conversation
  transcripts (`projects/`), prompt history (`history.jsonl`), sessions and
  shell snapshots into the new profile: exactly the cross-account bleed a
  profile exists to prevent. On the machine this was found on, 34
  conversations from a personal account were sitting in a work profile.
  Pointed out in an outside review, which suggested the fix.

  Seeding now works from an allowlist. It copies `settings.json`,
  `CLAUDE.md`, `keybindings.json`, skills, commands, agents, hooks, output
  styles and installed plugins, and nothing else. Anything not named stays
  behind, including files Anthropic adds in future that the tool does not
  know about. Plugin data and account-synced plugin state stay behind too.

- **MCP servers never carried over, despite the README saying so.**
  User-level MCP servers live in `~/.claude.json`, outside the folder the
  seed copied. The seed now takes the `mcpServers` entry from that file and
  nothing else from it, since the rest is the account's identity, usage and
  caches.

- **Seeded profiles kept loading plugins and hooks from the default
  profile.** Plugin manifests and settings store absolute paths into
  `~/.claude`, and the old seed copied them verbatim, so updating a plugin in
  the default profile changed it in the seeded one too. Those paths are now
  pointed at the new profile's own copies, and only where the copy exists.

### Added

- `doctor` reports what an older seed left in existing profiles. It counts
  conversations copied from the default profile (matched by session ID,
  which is unique per conversation) and says where they are. It never
  deletes them: whether to keep them is your call. It also finds plugin and
  hook paths still leading into the default profile, and `--fix` points them
  at the profile's own copies wherever those exist, leaving the rest working
  as they are.

- CI now runs the test suite on macOS too. Launcher compilation, plist and
  bundle handling and the launch helper's decisions are tested on macOS
  only, so until now they only ever ran on a developer's machine. The macOS
  job fails if any test skips.

### Changed

- The README opens with what the tool does and how to install it, and no
  longer says profiles are "fully isolated". Each profile has its own login,
  chats, settings, MCP servers, plugins and skills; it does not have a
  sandboxed filesystem, which the README explains further down.
- The `add` wizard describes seeding precisely, and its review screen now
  shows the Dock colour and GitHub CLI choices before you confirm.
- The walkthrough is updated to what the wizard prints today.
- Removed a release tarball from v0.1.4 that had been committed to the
  repository.
- The README's comparison with similar tools no longer claims this is the
  only one handling Claude Desktop alongside Claude Code; that stopped being
  true. The table now compares what each tool actually does, checked against
  each project's own README: Desktop, Code, whether accounts run side by
  side or you switch one active account, a GitHub login per profile (which
  none of the others offer), and diagnostics.

## 0.1.30 (2026-09-27)

### Changed

- `upgrade` now applies the new version's changes to your profiles too, in
  one step. After installing and verifying, it runs the new version's
  `doctor --fix`. `--no-fix` stops after the install.

  Installing only replaces the code. The launch helper, rebuilt launchers and
  moving profiles over to a new way of working all happen in `doctor --fix`,
  so upgrading used to be two steps, and the second was easy to miss. v0.1.29
  showed the worse case: the first step quietly installed the old version,
  the second then ran as the old version, and it reported "No problems found"
  with not a single profile switched over.

  The first release to use this is the one after 0.1.30. The upgrade that
  installs 0.1.30 is still run by 0.1.29's code.

- Every command reminds you when the installed version's changes have not
  reached your profiles yet, for example after a plain `npm install -g`. The
  tool records which version's `doctor --fix` last ran, in `state.json` next to
  the registry. It is a reminder, not an automatic repair: rebuilding launchers
  as a side effect of `list` would be surprising. `upgrade` on an already
  current version applies any changes still pending.

### Fixed

- `upgrade` could reinstall the version you already had. It looked up the
  latest version with `npm view`, then installed `@latest`, which npm answered
  from its local cache: in the minutes after a release that still pointed at
  the previous version. It now installs the exact version it found and asks
  the registry rather than the cache.
- When the installed version did not match, `upgrade` always blamed PATH
  ("landed in a different Node version's global directory"). It now checks
  what npm actually installed, and tells the two cases apart.

## 0.1.29 (2026-09-27)

### Added

- Profiles no longer update themselves. Their launcher keeps them current.

  Each Desktop profile runs its own copy of Claude.app, and since #9 we know
  Claude's updater runs inside that copy. Every self-update removed the
  profile's colour, relaunched the copy without `--user-data-dir` (so the new
  window was on the default account while looking like the profile), and
  shared one update state file with the main Claude. v0.1.28 made those
  failures safe to detect; this release stops them happening.

  Three layers:

  1. **The copy's own updater is blocked, per profile.** Claude supports a
     "Block auto-updates" policy (`disableAutoUpdates`) and reads it from a
     folder named after the profile's data folder (`Claude-WORK-3p/`), so it
     applies to that profile alone. The main Claude in `/Applications` keeps
     updating itself. Verified before building: a test copy logged "Auto-updates
     disabled by enterprise policy" and stayed on claude.ai rather than
     switching to third-party inference mode. That folder is also where Claude
     keeps a third-party inference setup, so the tool writes it only when it
     does not exist and never edits a configuration it did not create.
  2. **The launcher keeps the copy current.** On click it compares the copy
     with `/Applications/Claude.app`; if the copy is behind, it rebuilds it
     (about a second), puts the colour back, and opens it. Any failure is
     logged and the copy opens as it is.
  3. **The launcher catches the wrong account.** Clicking a profile whose copy
     is already open without its profile asks whether to quit that window and
     reopen it properly, rather than bringing the wrong window forward.

  The launcher's work is done by a helper run with `osascript`, which ships
  with macOS, because apps started from the Dock do not get the shell's PATH.
  New profiles get all three. `doctor --fix` switches existing profiles over,
  rebuilding launchers in place so Dock pins keep working.

- `claude-multiprofile self-update [name] [on|off]` shows or changes who
  updates a profile's copy. `off` is the default.

### Fixed

- **Repairing a launcher pointed it back at the shared Claude.app.** `rename`,
  linking a Code half with `add`, enabling gh isolation, and `doctor`'s two
  environment repairs all rebuilt the launcher against `/Applications/Claude.app`
  instead of the profile's own copy, quietly undoing v0.1.23: no colour on the
  running window and a new window on every click. They now share one function
  that decides from the copy actually on disk.
- **`rename` left the profile's copy of Claude behind**, orphaned under the old
  name, and dropped `GH_CONFIG_DIR` from the rebuilt launcher. It now moves the
  copy and the update settings, and keeps gh isolation.
- **`rename` and `remove` refuse while the profile is open.** Rename moved the
  data folder out from under a running Claude, which keeps writing to the path
  it started with; remove deleted a running app.
- **Copies are never rebuilt while open**, by any path. Deleting an app while
  it runs can crash it. The launcher rebuilds it after it is quit instead.
- **`rename` now checks reserved names**, so it can no longer point a profile at
  `~/.claude-mem` and similar.
- **`3p` is a reserved profile name.** Its data folder would be `Claude-3P`,
  which on the default case-insensitive disk is the main Claude's `Claude-3p`
  configuration folder.

## 0.1.28 (2026-09-25)

### Fixed

- A profile's copy of Claude that updated itself is no longer treated as
  stale, and its lost colour is detected and restored. Reported by
  @zainzafar in #9.

  Each profile's copy is a real Claude.app, so Claude's updater runs inside
  it, replaces the whole app, and relaunches it. The README said the copy
  does not update itself. That was wrong, and three problems followed:

  - Versions were compared with `!==`, so a copy that had updated past
    `/Applications/Claude.app` counted as stale. `doctor` said the profile
    "would keep launching the older build", which is backwards, and
    `doctor --fix` would have rebuilt it from the older app. Re-running
    `add` for the profile would have done the same. Versions are now
    compared numerically, and only a copy that is behind gets rebuilt.
  - The colour is Finder metadata on the app's folder, so an update throws
    it away. `doctor` only checked versions, so it reported a copy as
    healthy whether or not the colour was still there. It now checks the
    icon itself, and `--fix` re-applies the colour in place without
    rebuilding.
  - The updater relaunches the copy without `--user-data-dir`, so the new
    window runs on the default account. The launch-path check added in
    0.1.26 reports it, and the README now explains it.

- `doctor` version-checks every profile's copy, not only coloured ones.
  Contributed by Jake Barnby (@abnegate) in #7. Merged after the fix above,
  since the old comparison would otherwise have offered uncoloured copies
  the same downgrade.

### Added

- `"readProtection": false` at the top level of the registry turns off
  cross-profile read protection, for setups where profiles are meant to
  read each other's files. Every command that rewrites the rules removes
  the ones the tool wrote instead, your own deny rules stay, and `doctor`
  shows the check as off rather than reporting drift. Delete the key and
  run `doctor --fix` to turn it back on. Contributed by Jake Barnby
  (@abnegate) in #8.

## 0.1.27 (2026-09-18)

### Added

- `status` reports a terminal that is older than the aliases on disk.

  A shell reads its rc file once, at startup. Everything `status` checked
  until now was on disk, so a session opened before the last `add`, `rename`
  or `remove` would pass every check while running aliases that no longer
  match the file. After a rename it is worse than cosmetic: the old alias is
  still defined, still runs, and still exports `CLAUDE_CONFIG_DIR` pointing
  at a directory that has since been moved.

  Aliases live in the shell process and a child process cannot read its
  parent's alias table, so the check compares two times instead: when the
  session shell started, and when the aliases last changed.

  Knowing the second one required somewhere to record it. The rc file's mtime
  is the wrong signal, since installers and their owners edit dotfiles for
  unrelated reasons, and warning about somebody else's edit would be noise.
  The managed block now carries its own timestamp, rewritten only when the
  alias lines actually change, so a no-op write leaves the file byte
  identical.

  Every step degrades to staying quiet rather than guessing: a block written
  before this release has no timestamp, a shell that cannot be found in the
  process tree is not reported, and a one-shot `zsh -c` is not a session
  anyone can re-source. Sending someone to fix a file that was already fine
  is worse than saying nothing.

### Fixed

- Adding a second fish profile no longer drops the first one's function.

  Fish cannot express an env-prefixed alias, so the tool writes a function
  for it instead. The reader that returns the current contents of the managed
  block matched only lines beginning with `alias `, which made every fish
  entry invisible to it. Since `add` and `remove` rebuild the whole block
  from what that reader returns, the existing fish profiles were not carried
  across: adding a second one wrote a block containing only the second.

  The same blind spot made `status` report a fish profile's alias as missing
  when it was present and correct.

  Found while adding the timestamp above, which needs to compare the aliases
  already in the block against the ones about to be written. zsh and bash
  were never affected.

## 0.1.26 (2026-09-18)

### Added

- `doctor` reports a Claude copy that was started without going through its
  launcher. Contributed by Jake Barnby (@abnegate) in #6.

  Desktop isolation lives in the launch command, not in the copy. The launcher
  runs `open -a <copy> --args --user-data-dir=<profile>`, and the copy itself
  holds no profile, so anything that starts it another way falls back to the
  shared default profile and opens whichever account is signed in there.
  Nothing about the window looks wrong. It is simply the wrong account.

  v0.1.23 made this harder to notice rather than easier. When every profile
  shared one `Claude.app`, a tile pinned from the running window was visibly
  the stock icon. Now that tile is the profile's own coloured copy, so it looks
  exactly like a correctly pinned launcher. Spotlight, a Login Item, and Claude
  relaunching itself after an update all reach the copy the same way.

  `doctor` now reports any profile copy running without `--user-data-dir`, with
  its pid, and flags a copy pinned to the Dock as the usual cause. Read only:
  the repair is a Dock edit, which does not belong in an automated path.

  This is the second cause of the same symptom, alongside the account collision
  check added in 0.1.25. Neither check sees the other's case.

### Fixed

- `parseRunningCopies` no longer skips a profile whose name contains "Helper".

  Helper processes were excluded twice, once by the `/Contents/MacOS/` path
  needle and again by matching the word "Helper" in the command line. Helpers
  live under `Contents/Frameworks`, so the needle already excluded them and the
  second filter only ever matched profile names. A profile called "Helper" was
  dropped from the check entirely, meaning `doctor` would report that every
  copy was started through its launcher while that one sat on the shared
  default account. That silence is the exact failure the check exists to break.

## 0.1.25 (2026-09-18)

### Added

- `doctor` reports when two profiles are signed in as the same account.

  Reported after a Claude Desktop update: two profiles both opened the same
  account, and `doctor` said "No problems found". It was right about
  everything it checked. The data directories were separate, the launchers
  worked, LaunchServices resolved correctly, and no path was wrong. What had
  happened is that a `claude://` sign-in callback was routed to the wrong
  running instance, so the token landed in the wrong data folder. A profile
  can open exactly the right folder while authenticated as somebody else, and
  nothing about the filesystem shows it.

  The one visible signal is that two data directories record the same
  `lastKnownAccountUuid`, which is never legitimate, since being a different
  account is the entire point of a profile. `doctor` now compares them across
  the default install and every Desktop profile, and reports a collision as a
  problem with the steps to undo it.

  Not auto-fixable: recovering means signing out and back in with only one
  Claude running, which is yours to do. A Claude update that forces
  re-authentication is the usual trigger, because every profile gets prompted
  at once.

## 0.1.24 (2026-09-01)

Three fixes for one long-standing complaint: a profile's Dock icon that
showed blank, would not stay pinned, and opened a new window on every click.
Earlier releases guessed at this. These are the measured causes.

### Fixed

- **Blank Dock icon.** `osacompile` emits a compiled asset catalog
  (`Assets.car`) holding the stock AppleScript icon, and points
  `CFBundleIconName` at it. macOS prefers the catalog over
  `CFBundleIconFile`, so the Claude icon copied onto `applet.icns` was never
  what the Dock read. Verified by comparing a launcher's catalog against a
  freshly compiled applet's: byte-identical. Finder and Get Info read the
  `.icns` and looked correct throughout, which is what made this hard to see.
  Launchers now have the catalog and its key removed, leaving `applet.icns`
  as the only icon source.

- **Launcher would not stay pinned or relaunch.** 0.1.22 set `LSUIElement` to
  hide the launcher's brief Dock tile. That was a mistake: `LSUIElement`
  marks an app as a background agent, and macOS does not keep agent apps
  pinned or reliably relaunch them from a pin. The flicker it removed was
  cosmetic; what it broke was not. Reverted.

- **Every click opened another window.** Profiles created before 0.1.23 have
  no dedicated copy of Claude.app, so their launcher still uses `open -n`,
  which forces a new instance. `doctor --fix` now builds the copy and
  rebuilds the launcher to target it, so existing profiles get the same
  focus-instead-of-duplicate behaviour as new ones.

`repair` and `doctor --fix` both apply all three to launchers built by
earlier versions.

## 0.1.23 (2026-09-01)

### Fixed

- Clicking a profile's Dock icon focuses its window instead of opening
  another copy of it. The launcher used `open -n`, which forces a brand new
  instance every time. That flag was necessary while profiles shared
  `/Applications/Claude.app`, because without it macOS routes the request to
  whatever Claude is already running and drops `--user-data-dir`, silently
  opening the wrong profile.

  Every Desktop profile now gets its own cloned bundle, not only coloured
  ones. Nothing else runs from that path, so `open -a <clone>` addresses
  exactly one profile: it launches if the profile is closed and focuses it if
  it is already open. The clone costs a couple of seconds and a few megabytes,
  since APFS keeps the blocks shared.

- `doctor --fix` refreshes the launcher after editing its `Info.plist`.
  Finder and the Dock cache an app's icon against its bundle, so rewriting
  the plist without touching the bundle left the pinned icon blank. 0.1.22
  introduced that when it started setting `LSUIElement` through `--fix`;
  `repair` had always done the refresh, and `--fix` did not. Every `--fix`
  path that rewrites a bundle now goes through one helper that touches it and
  re-registers it with LaunchServices.

### Known limitation

The running window is still titled "Claude" rather than the profile name.
That comes from `CFBundleName` inside the app, and changing it means editing
`Info.plist`, which fails `codesign` and Gatekeeper outright. The icon can
differ per profile; the name cannot, short of re-signing and losing the
Keychain login.

## 0.1.22 (2026-09-01)

Both changes target the same complaint: a pinned profile icon that keeps
needing to be dragged back after a quit or an upgrade.

### Fixed

- Rebuilding a launcher no longer breaks its Dock pin. The Dock remembers a
  pinned app by where it lives, and rebuilds deleted the bundle and wrote a
  new one in its place, which invalidates that reference. Since `rename`,
  `doctor --fix`, and the link flows all rebuild launchers, routine
  maintenance quietly cost you a re-pin. Rebuilds now replace only the
  compiled script inside the existing bundle, so the pin, the custom icon,
  and anything else stamped on it survive.

- Launchers no longer take a Dock tile of their own (`LSUIElement`). A
  launcher spawns Claude and exits within about a second, so its tile
  appeared beside Claude's own and then vanished. Two tiles for one apparent
  app is what leads to dragging the wrong one down: the tile that persists
  belongs to Claude itself, so pinning it launches the shared Claude rather
  than the profile. That is the actual reason a "profile icon" stops opening
  the right account.

  `repair` and `doctor --fix` apply this to launchers built earlier, and
  `doctor` reports the ones that still need it.

- `add` now says which icon to pin, and `repair`'s closing advice was wrong
  in the same way, telling you to re-pin from Finder without explaining that
  the running tile is the wrong thing to drag.

## 0.1.21 (2026-09-01)

### Added

- Per-profile Dock colours, closing
  [#2](https://github.com/jmdarre-v/claude-multiprofile/issues/2).

  The Dock tile of a running Claude Desktop window always showed the standard
  icon, no matter what you did to the launcher, because the window belongs to
  Claude's process and the launcher has already exited. Customising the
  launcher could never reach it. That issue was previously closed as a known
  limitation on the reasoning that the only alternative, a per-profile copy of
  Claude.app, would break code signing. That reasoning was wrong and had not
  been tested.

  Choosing a colour during `add` now builds a tinted copy of Claude.app for
  the profile and points the launcher at it, so the running process is the
  thing carrying the colour. Eight colours, produced by hue-rotating Claude's
  own icon.

  Measured rather than assumed, on macOS 26.6 Apple Silicon: the copy is an
  APFS clone costing about 1.5 seconds and 3MB of real disk against an 800MB
  app, since the blocks stay shared. The tint is attached as Finder metadata
  rather than by editing the bundle, so the copy keeps
  `com.anthropic.claudefordesktop` and Anthropic's Team ID and is accepted by
  Gatekeeper. `codesign --verify --deep --strict` does fail on it, as it does
  for any bundle with a custom icon; that is stated in the README rather than
  glossed over.

  Off by default. Choosing no colour keeps the previous behaviour exactly.

  No new dependencies and no build step: the tinting (`CIHueAdjust`) and the
  icon attachment (`NSWorkspace.setIcon`) both run through `osascript -l
  JavaScript`, which ships with macOS.

- `doctor` reports a profile whose tinted copy was built from an older
  Claude.app, since Claude updates itself and the copy does not, and a stale
  copy would silently keep launching the old build. `doctor --fix` rebuilds
  it. `remove` deletes the copy along with the profile.

## 0.1.20 (2026-09-01)

### Added

- `list` and `status` now print the exact command to start each profile.

  Profile names of four characters or fewer are uppercased in the paths the
  tool creates, so a profile named `ipsy` appears everywhere as
  `Claude-IPSY` and `Claude IPSY.app` while the command to run it is
  `claude-ipsy`. Shell command names are case-sensitive, so reading the
  prominent uppercase form and typing it back gives "command not found", and
  nothing in the output contradicts that reading. Both commands now end each
  profile with a "To launch" block naming the alias verbatim and the `open`
  command for the Desktop launcher.

  The casing itself is unchanged, since altering it would move the folders
  and launchers of every existing profile.

## 0.1.19 (2026-09-01)

### Added

- `doctor` compares the version a command reports against the version its
  package claims. An install step that fetches an artifact not matching the
  manifest leaves everything looking healthy while the command you run is a
  different build entirely, which is the whole "I upgraded and nothing
  changed" trap. Found on a real machine where `claude --version` reported
  2.1.126 under a package declaring 2.1.240.

### Fixed

- The per-package summary line can no longer contradict the detail above it.
  It previously printed "install looks intact" directly beneath a warning
  about that same package, which is the false reassurance 0.1.18 set out to
  remove. Summaries now distinguish an unusable command, a usable one with a
  caveat, and a clean install.

## 0.1.18 (2026-08-22)

### Fixed

- `doctor` no longer reports a package as intact based on its `package.json`
  alone. It now resolves what the package declares as its executable and
  checks that the file exists, carries the execute bit, and actually runs.

  The case that exposed this: a Claude Code install whose postinstall stopped
  partway. The manifest was perfect and the native binary had been
  downloaded, but `bin/claude.exe` was still the "not installed" stub at mode
  644, so `claude` failed with `permission denied`. `doctor` reported
  "install looks intact" in the same breath as "No claude on PATH". A false
  reassurance is worse than silence, because it points away from the fault.

  Failures are now named specifically: a missing target, a missing execute
  bit, a non-zero exit (quoting what the command said), or death by signal.
  For `SIGKILL` on Apple Silicon it points at an unsigned or invalid
  signature, which the kernel refuses to start. Each one suggests re-running
  the package's own postinstall first, since that is usually the step that
  did not finish, with a full reinstall as the fallback.

## 0.1.17 (2026-08-12)

### Fixed

- The Desktop launcher now exports `GH_CONFIG_DIR` alongside
  `CLAUDE_CONFIG_DIR`. 0.1.16 wired per-profile GitHub logins into the shell
  alias only, so Claude Code opened from inside the Desktop app used the
  profile's Claude config but the machine's default gh account. `doctor`
  detects launchers missing it and `doctor --fix` rebuilds them.
- `doctor --fix` carries an existing `GH_CONFIG_DIR` through when it rebuilds
  a launcher to repair `CLAUDE_CONFIG_DIR`, instead of stripping it.

### Added

- `add` can turn on gh isolation for a profile that is already complete.
  Profiles created before 0.1.16, or ones that declined at creation, had no
  way to enable it short of hand-editing the alias: `add` refused the name
  because nothing was missing. It now offers the upgrade, rewrites the alias,
  and rebuilds the Desktop launcher so both surfaces match.

## 0.1.16 (2026-08-12)

### Added

- Optional per-profile GitHub CLI login. When `gh` is installed, `add` offers
  to give the profile its own GitHub account by pointing `GH_CONFIG_DIR` at
  `~/.claude-{name}/gh`, so every `gh` command Claude runs inside that profile
  acts as that account. Off by default, since a single GitHub identity across
  profiles is what most setups want.

  The config folder nests inside the profile's own directory, so `rename`
  moves it and `remove` deletes it with no extra handling. `rename` recomputes
  the path so the rewritten alias points at the folder that now exists.
- `doctor` reports per-profile gh isolation, and warns when `GH_TOKEN`,
  `GITHUB_TOKEN`, or `GH_ENTERPRISE_TOKEN` is exported in your environment.
  `gh` prefers those over any config directory, so one of them set globally
  silently makes every profile use the same account. It also flags a gh config
  folder that has gone missing, which sends `gh` back to your default login.

Profiles that do not opt in generate exactly the same alias line as before.

## 0.1.15 (2026-08-09)

### Added

- `add` can complete a half-built profile. Entering an existing name is now
  only an error when the profile already has everything you selected. If it
  is missing the half you picked (the common case being a Desktop profile
  created before you cared about isolating Claude Code), `add` offers to link
  the missing half onto it instead of refusing the name.

  Linking Claude Code onto an existing Desktop profile also **rebuilds the
  Desktop launcher**, because the `CLAUDE_CONFIG_DIR` it exports is compiled
  into the launcher at creation time. Without that step the link would look
  successful while Desktop kept spawning Claude Code against the shared
  `~/.claude`. Existing chats, logins, and settings are untouched.
- `doctor` reports Desktop-only profiles and names the consequence: Claude
  Code opened from inside them uses the shared `~/.claude`. Informational
  only, since Desktop-only is a legitimate choice, so it does not count as a
  problem or a warning.

## 0.1.14 (2026-08-05)

### Added

- `doctor` reads each launcher's compiled script and reports profiles whose
  launcher does not export `CLAUDE_CONFIG_DIR` while the profile has a Code
  target. Those are launchers built before 0.1.12, where Claude Code started
  from inside Desktop silently uses the shared `~/.claude`. A launcher
  pointing at a stale directory is reported too. `doctor --fix` rebuilds them,
  reapplying the icon and bundle ID and re-registering with LaunchServices.
  This makes the 0.1.12 fix retroactive instead of requiring users to re-run
  `add` for every existing profile.

### Fixed

- Launcher generation escaped paths for the shell but not for the AppleScript
  string literal wrapping the command. The POSIX escape for an apostrophe
  contains a backslash, and `\'` is not a valid AppleScript escape, so
  `osacompile` rejected the script and profile creation failed outright. Any
  user whose home directory contains an apostrophe hit this on every `add`
  with a default path. Both layers are now escaped.

## 0.1.13 (2026-08-05)

### Fixed

- Cross-profile deny rules are no longer written through a `settings.json`
  symlink. Writing to a link mutates its target, so a profile whose
  `settings.json` points at shared config (for example `~/.claude`) would have
  had its per-profile rules pushed into a file every other profile reads, with
  each profile then stripping the others' rules on every `add`, `remove`, or
  `rename`. Such profiles are now skipped with an explanation, and `doctor`
  reports them as unprotected and names the link target. A symlink that stays
  inside the profile's own directory is still fine. Broken links are refused
  rather than silently creating the target.
- `doctor --fix` no longer claims to have repaired deny rules when the only
  findings are ones it deliberately refuses to touch (symlinked or malformed
  `settings.json`).

## 0.1.12 (2026-08-05)

### Fixed

- Claude Code sessions spawned from inside Claude Desktop no longer fall back
  to the shared `~/.claude`. Desktop launchers for profiles that also have a
  Code target now pass `--env 'CLAUDE_CONFIG_DIR=...'`, so `CLAUDE.md`,
  `settings.json`, and per-project memory stay inside the profile instead of
  merging across profiles that looked isolated. Thanks to
  [@teloscientist-hub](https://github.com/teloscientist-hub) for the
  diagnosis and the fix ([#5](https://github.com/jmdarre-v/claude-multiprofile/pull/5)).
- `rename` passes the renamed config directory through when it rebuilds a
  launcher, so renaming a Desktop plus Code profile no longer drops that
  isolation.

### Note

Existing launchers keep their old launch line. Re-run `add` for the profile,
or `rename` it, to regenerate one that sets the variable.

## 0.1.11 (2026-08-05)

Hardening release: three bug fixes found in an internal audit, plus
diagnostics that catch older launchers.

### Fixed

- A malformed `settings.json` (trailing comma, stray comment) is no longer
  silently overwritten when cross-profile deny rules are synced. The file is
  left byte-identical and the skip is reported.
- A corrupt registry file no longer reads as "no profiles configured" and can
  no longer be clobbered: mutating commands refuse to run until the JSON is
  fixed, every write keeps a `profiles.json.bak` of the last good version,
  and `list`/`status`/`doctor` call out the corruption.
- `remove` now strips this tool's deny rules from a kept config folder, so a
  folder that outlives its profile no longer blocks reads of former siblings.
- Version comparisons are numeric: a local build ahead of npm no longer
  reports "a newer version is available".
- `help` no longer claims `repair` requires a profile name (it has been
  interactive since 0.1.9).

### Added

- `doctor` checks each launcher's bundle identifier and flags ones still on
  the colliding AppleScript default (profiles created before 0.1.9);
  `doctor --fix` restamps and re-registers them.
- `upgrade` verifies that the binary winning on PATH actually reports the new
  version after installing, and explains the multiple-Node-versions trap when
  it doesn't.
- `prepublishOnly` runs the test suite, so a broken tree can't be published.
- Removing the last Code profile now removes the managed alias block from the
  shell rc file instead of leaving an empty marker pair.

## 0.1.10 (2026-08-05)

- New `doctor [--fix]` command: PATH resolution for `claude`, broken npm
  install detection, directory-collision checks, and cross-profile
  read-protection audit.
- New `rename [old] [new]` command: moves the config dir, alias, Desktop data
  dir, launcher, and bundle ID together (Code profiles must sign in again;
  the Keychain entry cannot be migrated).
- Cross-profile read protection (issue #4): every Code profile's
  `settings.json` gets `permissions.deny` rules blocking reads of every other
  profile's directories, kept in sync on `add`/`remove`/`rename`.
- `add` refuses reserved names (`mem`, `profiles`, `multiprofile`, `code`,
  `desktop`) and warns before claiming a pre-existing unmanaged directory.
- `list` and `status` show which `claude` binary wins on PATH.
- `remove` deregisters the launcher from LaunchServices before deleting it.

## 0.1.9 (2026-05-03)

- `repair` fixes the real cause of unresponsive Dock launchers: every
  osacompile launcher shared the same default bundle identifier, confusing
  LaunchServices. Launchers now get a unique per-profile bundle ID, both at
  creation and on repair.
- `repair` also strips the quarantine attribute and prompts for a profile
  when run without a name.

## 0.1.8 (2026-05-01)

- Running `claude-multiprofile` with no arguments opens an interactive menu.
- `extensions` picks source and target interactively; cross-profile copying
  works in both directions.

## 0.1.7 (2026-05-01)

- New `upgrade` command: checks npm for the latest version and installs it.

## 0.1.6 (2026-05-01)

- New `extensions` command: copy Claude Desktop extensions (folder plus
  settings JSON, together) from the default install into a profile, with
  conflict detection and `--force`.

## 0.1.4 and earlier (2026-04)

- Initial releases: `add`, `list`, `status`, `remove`; Desktop isolation via
  `--user-data-dir` launchers, Code isolation via `CLAUDE_CONFIG_DIR`
  aliases; rename from claude-profiles to claude-multiprofile.
