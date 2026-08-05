# Changelog

All notable changes to claude-multiprofile. Versions follow semver; the
project is pre-1.0, so minor breakage may occur between 0.x releases.

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
