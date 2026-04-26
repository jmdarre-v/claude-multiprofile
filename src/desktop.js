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

export function buildLaunchAppleScript(dataDir, claudeAppPath) {
  // The `open -n` flag forces a new instance even when Claude is already
  // running. Without -n, macOS would route the request to the existing
  // Claude window and ignore our --user-data-dir argument entirely.
  //
  // The `-a` argument takes a path or app name; we pass the explicit path
  // so this works even if there are multiple Claude.app bundles around.
  //
  // We escape any single quotes in the paths defensively, though Library
  // and Applications paths shouldn't contain them in practice.
  const safeApp = claudeAppPath.replace(/'/g, "'\\''");
  const safeDir = dataDir.replace(/'/g, "'\\''");
  return `do shell script "open -n -a '${safeApp}' --args --user-data-dir='${safeDir}' > /dev/null 2>&1 &"`;
}

export function compileApp({ name, dataDir, appPath, claudeAppPath }) {
  // We write the AppleScript to a temp file then run `osacompile` to turn
  // it into a real .app bundle. osacompile is part of macOS, no install
  // needed.
  const script = buildLaunchAppleScript(dataDir, claudeAppPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
  const scriptPath = path.join(tmpDir, "launcher.applescript");
  fs.writeFileSync(scriptPath, script, "utf8");

  // Make sure the parent directory of the .app exists. ~/Applications is
  // not auto-created on a fresh user account so we ensure it.
  fs.mkdirSync(path.dirname(appPath), { recursive: true });

  // If the app already exists, remove it first so osacompile won't error.
  if (fileExists(appPath)) {
    fs.rmSync(appPath, { recursive: true, force: true });
  }

  execFileSync("/usr/bin/osacompile", ["-o", appPath, scriptPath], {
    stdio: "pipe",
  });

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

export function setupDesktop({ name, dataDir, appPath, claudeAppPath, applyIcon }) {
  // Wraps the whole setup. Returns a summary the wizard can save to the
  // registry and print to the user.
  step(`Creating Claude Desktop profile "${name}"`);

  info(`Data folder: ${pathStr(tildify(dataDir))}`);
  info(`Launcher app: ${pathStr(tildify(appPath))}`);
  info(`Claude.app source: ${pathStr(claudeAppPath)}`);

  ensureDataDir(dataDir);
  ok("Data folder ready.");

  compileApp({ name, dataDir, appPath, claudeAppPath });
  ok("Launcher .app compiled.");

  if (applyIcon) {
    const applied = copyClaudeIcon(appPath, claudeAppPath);
    if (applied) ok("Claude icon applied to launcher.");
    else warn("Could not locate a Claude icon to copy. Default AppleScript icon left in place.");
  }

  return { dataDir, appPath, claudeAppPath };
}
