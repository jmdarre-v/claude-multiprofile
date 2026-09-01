# Changelog

All notable changes to claude-multiprofile. Versions follow semver; the
project is pre-1.0, so minor breakage may occur between 0.x releases.

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
