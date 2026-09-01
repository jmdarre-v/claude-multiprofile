// Claude Desktop profile setup.
//
// Background:
//
// Claude Desktop is an Electron app. Electron, like Chromium, supports
// the `--user-data-dir` command-line flag, which forces the app to read
// and write all of its state (auth tokens, chat list, settings, MCP
// connectors, projects, etc.) to a directory of your choosing rather than
// the default `~/Library/Application Support/Claude`.
//
// This is the entire mechanism behind multi-account support. Each profile
// gets its own user-data-dir, which means each profile has its own
// completely isolated:
//
//   - Logged-in account
//   - Chat history
//   - MCP servers and connectors
//   - Custom styles
//   - Projects
//   - Preferences
//
// What this module does:
//
//   1. Creates the user-data-dir for the new profile.
//   2. Builds a real macOS .app bundle (via `osacompile` from a tiny
//      AppleScript) that, when launched, invokes Claude with the right
//      --user-data-dir flag. This gives the user a draggable Dock icon.
//   3. Copies Claude's own .icns icon onto the new .app so it's
//      visually recognizable, optionally tinted later by the user.
//
// Why a .app and not a shell alias?
//
// macOS doesn't let you put shell aliases on the Dock. The user wants to
// click an icon, not type a command. .command files work but launch a
// background Terminal window, which is ugly. AppleScript .app bundles
// produced by `osacompile` are the cleanest option: they appear as real
// applications, dock-able, Spotlight-searchable, with custom names.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureColoredClone, applyColor } from "./appclone.js";
import {
  HOME,
  pathStr,
  command,
  ok,
  info,
  warn,
  step,
  tildify,
  fileExists,
  titleCase,
} from "./util.js";

// Conventional location for Claude's data folder. We don't change this for
// the default profile, only for new profiles.
const DEFAULT_CLAUDE_DATA_PARENT = path.join(
  HOME,
  "Library",
  "Application Support"
);

// Where to look for the installed Claude.app. /Applications is the standard
// install location; we fall back to ~/Applications which is where users land
// when they install without admin rights.
const CLAUDE_APP_CANDIDATES = [
  "/Applications/Claude.app",
  path.join(HOME, "Applications", "Claude.app"),
];

// ---- Discovery -----------------------------------------------------------

export function findClaudeApp() {
  // Returns the path to /Applications/Claude.app or its alternative,
  // or null if not found. We don't try `mdfind` because it can be slow
  // and may surface unrelated bundles.
  for (const candidate of CLAUDE_APP_CANDIDATES) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function defaultDataDirFor(name) {
  // The standard suggestion. Users can override during the wizard.
  return path.join(DEFAULT_CLAUDE_DATA_PARENT, `Claude-${titleCase(name)}`);
}

export function defaultAppPathFor(name) {
  // Defaults to ~/Applications because it never requires sudo.
  // /Applications would arguably be more "correct" but writing there
  // can prompt for admin in some macOS configurations, which we'd rather
  // avoid in an automated wizard.
  const appsDir = path.join(HOME, "Applications");
  return path.join(appsDir, `Claude ${titleCase(name)}.app`);
}

// ---- Data directory --------------------------------------------------

export function ensureDataDir(dataDir) {
  // Creates the user-data-dir if it doesn't exist. Important: we never
  // copy the existing default Claude profile in. Doing so would carry
  // over the credentials cookie, and the new profile would launch
  // already signed into the wrong account. Each profile must start clean
  // and be signed into independently.
  fs.mkdirSync(dataDir, { recursive: true });
}

// ---- .app bundle generation ----------------------------------------

export function buildLaunchAppleScript(dataDir, claudeAppPath, codeConfigDir, ghConfigDir, dedicatedBundle = false) {
  // The `open -n` flag forces a new instance even when Claude is already
  // running. Without -n, macOS would route the request to the existing
  // Claude window and ignore our --user-data-dir argument entirely.
  //
  // The `-a` argument takes a path or app name; we pass the explicit path
  // so this works even if there are multiple Claude.app bundles around.
  //
  // `--env CLAUDE_CONFIG_DIR=...` closes the other half of the isolation.
  // --user-data-dir separates Claude DESKTOP state (auth, chats, settings,
  // MCP connectors). It does NOT separate the Claude CODE sessions that
  // Desktop spawns: those read ~/.claude in every profile, because Desktop
  // does not set CLAUDE_CONFIG_DIR for the CLI it launches. The practical
  // effect is that CLAUDE.md, settings.json, and per-project memory MERGE
  // across profiles even when Desktop itself is cleanly separated, which
  // is the failure this whole tool exists to prevent.
  //
  // Verified on macOS 25.5 (2026-07-29), A/B against a control launch:
  // `open --env` sets the variable in the launched app's environment AND in
  // the environment its child processes inherit, which is the exact relationship
  // Claude.app has with the claude-code CLI. Passing it via --env rather
  // than launching the binary directly keeps `open -n` semantics intact,
  // which the -n comment above explains is load-bearing.
  //
  // codeConfigDir is optional: when the profile has no Claude Code target,
  // omitting it leaves Desktop-spawned Claude Code on the default ~/.claude,
  // which is the pre-existing behaviour.
  //
  // Paths cross TWO quoting layers here and both have to be honoured:
  //
  //   1. the shell command, where each path sits inside single quotes
  //   2. the AppleScript string literal that `do shell script` takes
  //
  // Escaping only for the shell is what the code used to do, and it breaks on
  // an apostrophe: the POSIX escape is '\'' , and that backslash lands inside
  // an AppleScript double-quoted string where \' is not a valid escape, so
  // osacompile refuses the script outright. A user named o'brien has an
  // apostrophe in $HOME and therefore in every default path we generate, so
  // this is reachable rather than theoretical.
  //
  // GH_CONFIG_DIR rides along the same way when the profile has its own
  // GitHub CLI login. Without it, Claude Code opened from inside Desktop
  // would use the profile's Claude config but the machine's default gh
  // account, which is a confusing half-isolation.
  // `-n` forces a brand new instance. It is required when the launch target is
  // the SHARED /Applications/Claude.app, because without it macOS routes the
  // request to whatever Claude is already running and drops our
  // --user-data-dir entirely, silently opening the wrong profile.
  //
  // When the profile has its own cloned bundle, that reasoning inverts.
  // Nothing else runs from that path, so `open -a <clone>` targets exactly
  // this profile: it launches the app if it is not running, and focuses the
  // existing window if it is. Dropping `-n` there is what stops every click
  // on the Dock icon from stacking up another copy.
  const newInstance = dedicatedBundle ? "" : "-n ";
  const cmd =
    `open ${newInstance}-a ${shellQuote(claudeAppPath)} ` +
    (codeConfigDir ? `--env ${shellQuote(`CLAUDE_CONFIG_DIR=${codeConfigDir}`)} ` : "") +
    (ghConfigDir ? `--env ${shellQuote(`GH_CONFIG_DIR=${ghConfigDir}`)} ` : "") +
    `--args --user-data-dir=${shellQuote(dataDir)} > /dev/null 2>&1 &`;
  return `do shell script ${appleScriptString(cmd)}`;
}

// Wrap a value in shell single quotes, escaping embedded apostrophes the POSIX
// way (close quote, escaped quote, reopen).
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Render a value as an AppleScript string literal. AppleScript escapes only
// backslash and double quote; everything else, apostrophes included, is
// literal once the backslashes are doubled.
function appleScriptString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// PlistBuddy is the standard tool for editing .plist files on macOS. Always
// at this path, ships with the OS.
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

// ---- Reading back an existing launcher -------------------------------------
//
// A launcher built before v0.1.12 has no `--env CLAUDE_CONFIG_DIR=...` in its
// launch line, so Claude Code sessions spawned from that Desktop instance fall
// back to the shared ~/.claude. The bundle is the only record of what a
// launcher actually does (the registry never stored it), so `doctor` reads the
// compiled script back rather than inferring from the profile's age.

export function readLauncherScript(appPath) {
  // osacompile stores the compiled script here; osadecompile turns it back
  // into source. Both ship with macOS.
  const scpt = path.join(appPath, "Contents", "Resources", "Scripts", "main.scpt");
  if (!fileExists(scpt)) return null;
  try {
    return execFileSync("/usr/bin/osadecompile", [scpt], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

// The value a launcher exports for `name`, or null if it exports none.
// Returns undefined when the script can't be read at all, so callers can tell
// "no env flag" apart from "couldn't look".
export function launcherEnvVar(appPath, name) {
  const src = readLauncherScript(appPath);
  if (src === null) return undefined;
  // Our generated line places every --env before --args, so match up to the
  // closing quote that precedes either the next --env or --args.
  const m = src.match(new RegExp(`--env '${name}=(.*?)' --`));
  if (!m) return null;
  // Undo the two escaping layers in the order they were applied, outermost
  // first: the decompiled text is AppleScript source (so backslashes are
  // doubled), and inside it the path is shell single-quote escaped.
  const unAppleScript = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return unAppleScript.replace(/'\\''/g, "'");
}

export function launcherCodeConfigDir(appPath) {
  return launcherEnvVar(appPath, "CLAUDE_CONFIG_DIR");
}

export function launcherGhConfigDir(appPath) {
  return launcherEnvVar(appPath, "GH_CONFIG_DIR");
}

export function uniqueBundleId(name) {
  // Every osacompile'd AppleScript .app inherits the default
  // CFBundleIdentifier `com.apple.ScriptEditor.id.applet`. When the user
  // has multiple such launchers (one per profile), LaunchServices treats
  // them as duplicates of the same app, and Dock double-clicks can stop
  // resolving to the right binary. Giving each launcher a unique reverse-
  // DNS bundle identifier avoids the collision entirely.
  //
  // We sanitise `name` to keep it inside the [a-zA-Z0-9-] character class
  // CFBundleIdentifier expects.
  const safe = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
  return `com.claude-multiprofile.${safe}`;
}

// The identifier every osacompile'd bundle ships with until we stamp our own.
// Launchers still carrying it were created before v0.1.9 (or hand-built) and
// are exposed to the LaunchServices collision bug. `doctor` looks for it.
export const DEFAULT_APPLET_BUNDLE_ID = "com.apple.ScriptEditor.id.applet";

export function getBundleId(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return null;
  try {
    return execFileSync(PLIST_BUDDY, ["-c", "Print :CFBundleIdentifier", plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

// Hide the launcher's own Dock tile.
//
// The launcher spawns Claude and exits within about a second, so its tile
// flashes up next to Claude's own and then vanishes. That is what makes the
// Dock confusing: two tiles for what the user thinks of as one app, and the
// one that persists is Claude's, so dragging it to the Dock pins the SHARED
// Claude.app rather than the profile. LSUIElement stops the launcher from
// ever taking a tile, leaving exactly one: the profile's running window.
//
// Safe to edit here, unlike Claude.app: this bundle is ours, produced by
// osacompile, so there is no Anthropic signature to invalidate.
export function setUiElement(appPath, hidden = true) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return false;
  const value = hidden ? "true" : "false";
  try {
    execFileSync(PLIST_BUDDY, ["-c", `Set :LSUIElement ${value}`, plist], {
      stdio: "pipe",
    });
    return true;
  } catch {
    try {
      execFileSync(PLIST_BUDDY, ["-c", `Add :LSUIElement bool ${value}`, plist], {
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function isUiElement(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return null;
  try {
    const out = execFileSync(PLIST_BUDDY, ["-c", "Print :LSUIElement", plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out === "true" || out === "1";
  } catch {
    return false; // key absent means visible
  }
}

export function setBundleId(appPath, bundleId) {
  // PlistBuddy needs the literal Info.plist path, not the .app path.
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return false;
  // `Set` overwrites if present, errors if not. We pipe stderr so a missing
  // key doesn't pollute output; on error we fall back to `Add`.
  try {
    execFileSync(PLIST_BUDDY, ["-c", `Set :CFBundleIdentifier ${bundleId}`, plist], {
      stdio: "pipe",
    });
  } catch {
    try {
      execFileSync(
        PLIST_BUDDY,
        ["-c", `Add :CFBundleIdentifier string ${bundleId}`, plist],
        { stdio: "pipe" }
      );
    } catch {
      return false;
    }
  }
  return true;
}

export function stripQuarantine(appPath) {
  // Removes any com.apple.quarantine attribute applied by Gatekeeper. On a
  // freshly osacompile'd bundle there usually isn't one, but if the user
  // has copied the .app between machines via cloud sync or AirDrop it can
  // attach silently. Returns true if the call succeeded; the attribute may
  // not have been present, which is also fine.
  try {
    execFileSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", appPath], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function compileApp({ name, dataDir, appPath, claudeAppPath, codeConfigDir, ghConfigDir, dedicatedBundle = false }) {
  // We write the AppleScript to a temp file then run `osacompile` to turn
  // it into a real .app bundle. osacompile is part of macOS, no install
  // needed.
  const script = buildLaunchAppleScript(dataDir, claudeAppPath, codeConfigDir, ghConfigDir, dedicatedBundle);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
  const scriptPath = path.join(tmpDir, "launcher.applescript");
  fs.writeFileSync(scriptPath, script, "utf8");

  // Make sure the parent directory of the .app exists. ~/Applications is
  // not auto-created on a fresh user account so we ensure it.
  fs.mkdirSync(path.dirname(appPath), { recursive: true });

  // Compile into the temp directory first, never straight over the target.
  const staged = path.join(tmpDir, "staged.app");
  execFileSync("/usr/bin/osacompile", ["-o", staged, scriptPath], {
    stdio: "pipe",
  });

  // Updating an EXISTING launcher swaps only the compiled script, leaving the
  // bundle directory itself untouched.
  //
  // This matters because the Dock remembers a pinned app by its location, and
  // deleting the bundle and writing a new one in its place breaks that
  // reference: the pin goes stale and the user has to drag the icon back.
  // `rename`, `doctor --fix`, and the link flows all rebuild launchers, so
  // delete-and-recreate meant a re-pin after routine maintenance. Replacing
  // just Contents/Resources/Scripts/main.scpt keeps the bundle, and with it
  // the pin, the custom icon, and anything else already stamped on it.
  const rel = path.join("Contents", "Resources", "Scripts", "main.scpt");
  const updatingInPlace = fileExists(appPath) && fileExists(path.join(appPath, rel));
  if (updatingInPlace) {
    fs.copyFileSync(path.join(staged, rel), path.join(appPath, rel));
  } else {
    if (fileExists(appPath)) fs.rmSync(appPath, { recursive: true, force: true });
    fs.renameSync(staged, appPath);
  }

  // Stamp a unique CFBundleIdentifier so multiple profiles don't collide
  // in LaunchServices (see notes on uniqueBundleId).
  setBundleId(appPath, uniqueBundleId(name));

  // Keep the launcher out of the Dock while it runs, so the only tile is the
  // profile's actual Claude window.
  setUiElement(appPath, true);

  // Best-effort cleanup of the temp file.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Non-fatal; tmpdir gets cleaned by macOS eventually.
  }

  return appPath;
}

// ---- Icon swap -------------------------------------------------------

export function copyClaudeIcon(appPath, claudeAppPath) {
  // Find the .icns inside Claude.app's Resources and copy it onto our
  // new .app. osacompile creates a Resources directory containing
  // applet.icns, which is the file we need to overwrite.
  const sourceResources = path.join(claudeAppPath, "Contents", "Resources");
  const targetResources = path.join(appPath, "Contents", "Resources");

  if (!fileExists(sourceResources)) {
    return false;
  }

  // Look for any .icns; the exact name has changed over Claude releases.
  // First match wins, which is fine because Claude.app typically has
  // exactly one branding .icns.
  let sourceIcns = null;
  for (const file of fs.readdirSync(sourceResources)) {
    if (file.toLowerCase().endsWith(".icns")) {
      sourceIcns = path.join(sourceResources, file);
      break;
    }
  }
  if (!sourceIcns) return false;

  // Replace applet.icns inside our new .app. osacompile always names the
  // app's icon applet.icns, so we overwrite that specific filename.
  const targetIcns = path.join(targetResources, "applet.icns");
  if (!fileExists(targetIcns)) return false;
  fs.copyFileSync(sourceIcns, targetIcns);

  // Touch the .app so Finder/Dock pick up the icon change. Without this
  // step, the old generic AppleScript icon can stick around in cache for
  // a while.
  try {
    execFileSync("/usr/bin/touch", [appPath]);
  } catch {
    // Non-fatal; icon will refresh on next reboot or icon-cache rebuild.
  }
  return true;
}

// ---- Top-level orchestration -------------------------------------

export function setupDesktop({
  name,
  dataDir,
  appPath,
  claudeAppPath,
  applyIcon,
  codeConfigDir,
  ghConfigDir,
  color,
}) {
  // Wraps the whole setup. Returns a summary the wizard can save to the
  // registry and print to the user.
  step(`Creating Claude Desktop profile "${name}"`);

  info(`Data folder: ${pathStr(tildify(dataDir))}`);
  info(`Launcher app: ${pathStr(tildify(appPath))}`);
  info(`Claude.app source: ${pathStr(claudeAppPath)}`);
  if (codeConfigDir) info(`Code config for Desktop-spawned Claude Code: ${pathStr(tildify(codeConfigDir))}`);

  ensureDataDir(dataDir);
  ok("Data folder ready.");

  // A colour means the launcher opens a per-profile CLONE of Claude.app that
  // carries the tint, rather than the shared /Applications/Claude.app. That is
  // what puts the colour on the Dock tile of the running window: the running
  // process becomes the clone. See src/appclone.js for why this is cheap and
  // what it costs.
  // Every Desktop profile gets its own clone, tinted or not. Two reasons:
  //
  //   1. A dedicated bundle is what lets the launcher use `open -a <clone>`
  //      instead of `open -n`, so clicking the Dock icon focuses the profile's
  //      existing window rather than opening yet another copy of it.
  //   2. A colour, when chosen, has somewhere to live.
  //
  // The clone is an APFS copy: a couple of seconds and a few megabytes,
  // because the blocks stay shared with the original.
  let launchTarget = claudeAppPath;
  let clonePath = null;
  try {
    clonePath = ensureColoredClone({ name, claudeAppPath, color: color || null });
    launchTarget = clonePath;
    ok(color ? `Claude clone ready (${color}).` : "Claude clone ready for this profile.");
  } catch (e) {
    warn(`Could not build this profile's Claude clone: ${e.message}`);
    warn("Falling back to the shared Claude.app. Each click will open a new window.");
    color = null;
  }

  compileApp({
    name,
    dataDir,
    appPath,
    claudeAppPath: launchTarget,
    codeConfigDir,
    ghConfigDir,
    dedicatedBundle: Boolean(clonePath),
  });
  ok("Launcher .app compiled.");

  if (applyIcon) {
    const applied = copyClaudeIcon(appPath, claudeAppPath);
    if (applied) ok("Claude icon applied to launcher.");
    else warn("Could not locate a Claude icon to copy. Default AppleScript icon left in place.");
    // Tint the launcher too, so the icon you drag to the Dock matches the
    // window it opens instead of disagreeing with it.
    if (color && clonePath) {
      try {
        applyColor(appPath, claudeAppPath, color);
        ok("Launcher tinted to match.");
      } catch {
        // Non-fatal: the running app is what issue #2 is about.
      }
    }
  }

  return { dataDir, appPath, claudeAppPath, color: color || null, clonePath };
}
