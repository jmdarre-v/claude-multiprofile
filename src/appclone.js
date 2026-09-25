// Per-profile Claude.app clones, so each profile's Dock tile can carry its
// own colour (GitHub issue #2).
//
// Why a clone is necessary:
//
// Our launcher is an AppleScript bundle that runs `open -n -a Claude.app` and
// then exits. The window you end up with belongs to Claude.app's process, not
// to the launcher, so the Dock tile is Claude's and customising the launcher's
// icon cannot touch it. Finder and Get Info show the custom icon (they look at
// our bundle); the running window does not. That is the whole of issue #2.
//
// The fix is to launch a per-profile COPY of Claude.app that carries the
// colour itself. Then the running process IS the thing we customised.
//
// Why this is cheap, and why it stays safe:
//
//   - `cp -Rc` makes an APFS copy-on-write clone. Measured on macOS 26.6:
//     about 0.6s and zero additional disk for an 800MB app, because the
//     blocks are shared until one side diverges.
//   - The icon is attached as Finder metadata (an `Icon\r` file plus the
//     custom-icon flag) rather than by editing anything inside the bundle.
//     Anthropic's signature and identity survive: the bundle still reports
//     com.anthropic.claudefordesktop with its original Team ID, and Gatekeeper
//     still accepts it. Keychain access keys on identity, so logins keep
//     working.
//   - Being honest about the cost: `codesign --verify --deep --strict` does
//     fail on a bundle with a custom icon ("resource fork, Finder information,
//     or similar detritus not allowed"). Plain verification and Gatekeeper
//     both pass. This is the same trade every custom-icon app makes.
//
// Everything here runs through `osascript -l JavaScript`, which has an
// Objective-C bridge and ships with macOS. No compiler, no Xcode Command Line
// Tools, no new npm dependency.
//
// The copy updates itself (issue #9):
//
// A clone is a real Claude.app, so Claude's own updater (Squirrel's ShipIt)
// runs inside it. It downloads the new build and swaps the whole bundle
// directory, then relaunches the copy directly. Three consequences, each
// handled here or in doctor:
//
//   - The copy can be NEWER than /Applications/Claude.app. That is not
//     staleness. Rebuilding from the source would be a downgrade, of a
//     profile whose data a newer build has already opened. So versions are
//     compared numerically, and only a copy that is behind gets rebuilt.
//   - The tint is Finder metadata on the old bundle directory, so it goes out
//     with it. Checking the version says nothing about whether the colour is
//     still there; hasCustomIcon does.
//   - The relaunch has no --user-data-dir, so the relaunched window runs on
//     the shared default profile. doctor's launch-path check reports it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOME, fileExists, tildify, compareVersions } from "./util.js";

// Where per-profile clones live. Outside ~/Applications so they do not clutter
// the app list the user browses; the launcher is the thing meant to be visible.
export const CLONE_PARENT = path.join(
  HOME,
  "Library",
  "Application Support",
  "claude-multiprofile",
  "apps"
);

// Hue rotations, in degrees, applied to Claude's own icon. Chosen to be
// distinguishable from each other and from the untinted original at Dock size.
export const COLORS = {
  orange: 25,
  red: 330,
  yellow: 55,
  green: 110,
  teal: 160,
  blue: 210,
  purple: 265,
  pink: 300,
};

export function isColor(name) {
  return Object.prototype.hasOwnProperty.call(COLORS, name);
}

export function clonePathFor(profileName) {
  return path.join(CLONE_PARENT, `Claude ${profileName}.app`);
}

// ---- The JXA bridge --------------------------------------------------------

function runJxa(script, args) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-jxa-"));
  const file = path.join(tmp, "s.js");
  fs.writeFileSync(file, script, "utf8");
  try {
    return execFileSync("/usr/bin/osascript", ["-l", "JavaScript", file, ...args], {
      encoding: "utf8",
      timeout: 60_000,
    }).trim();
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best effort; the OS clears its tmpdir.
    }
  }
}

const TINT_JS = `
ObjC.import('AppKit');
ObjC.import('CoreImage');
function run(argv) {
  var src = argv[0], dst = argv[1], deg = parseFloat(argv[2]);
  var data = $.NSData.dataWithContentsOfFile($(src));
  if (!data.js) return 'ERR no-data';
  var ci = $.CIImage.imageWithData(data);
  if (!ci.js) return 'ERR not-an-image';
  var f = $.CIFilter.filterWithName($('CIHueAdjust'));
  f.setDefaults;
  f.setValueForKey(ci, $('inputImage'));
  f.setValueForKey($.NSNumber.numberWithDouble(deg * Math.PI / 180), $('inputAngle'));
  var out = f.valueForKey($('outputImage'));
  var rep = $.NSCIImageRep.imageRepWithCIImage(out);
  var img = $.NSImage.alloc.initWithSize(rep.size);
  img.addRepresentation(rep);
  var bmp = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  var png = bmp.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  png.writeToFileAtomically($(dst), true);
  return 'OK';
}`;

const SETICON_JS = `
ObjC.import('AppKit');
function run(argv) {
  var img = $.NSImage.alloc.initWithContentsOfFile($(argv[0]));
  if (!img.js) return 'ERR could-not-load';
  return $.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, $(argv[1]), 0) ? 'OK' : 'ERR set-failed';
}`;

// Claude ships one .icns in Resources; the exact filename has changed across
// releases, so take the first rather than hardcoding it.
export function findAppIcns(appPath) {
  const res = path.join(appPath, "Contents", "Resources");
  if (!fileExists(res)) return null;
  for (const f of fs.readdirSync(res)) {
    if (f.toLowerCase().endsWith(".icns")) return path.join(res, f);
  }
  return null;
}

// ---- Clone lifecycle -------------------------------------------------------

function appVersion(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return null;
  try {
    return execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", plist],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  } catch {
    return null;
  }
}

// Where a copy stands against the Claude.app it was built from:
//   "current"  same version
//   "behind"   the source is newer; rebuilding is an upgrade
//   "ahead"    the copy updated itself past its source; rebuilding would be
//              a downgrade, so leave it alone
//   "unknown"  a version could not be read; also leave it alone
// Compared numerically. Treating any difference as staleness is what made
// `doctor --fix` offer to replace a self-updated copy with an older build.
export function compareCloneVersions(cloneVersion, sourceVersion) {
  if (!cloneVersion || !sourceVersion) return "unknown";
  const c = compareVersions(cloneVersion, sourceVersion);
  if (c === 0) return "current";
  return c < 0 ? "behind" : "ahead";
}

export function cloneState(clonePath, claudeAppPath) {
  if (!fileExists(clonePath)) return "missing";
  return compareCloneVersions(appVersion(clonePath), appVersion(claudeAppPath));
}

// True when the copy needs building: missing, or older than its source.
export function cloneIsStale(clonePath, claudeAppPath) {
  const state = cloneState(clonePath, claudeAppPath);
  return state === "missing" || state === "behind";
}

export function cloneVersions(clonePath, claudeAppPath) {
  return { clone: appVersion(clonePath), source: appVersion(claudeAppPath) };
}

// Create (or refresh) a profile's coloured clone. Returns the clone path.
export function ensureColoredClone({ name, claudeAppPath, color, force = false }) {
  // A null colour is allowed: every Desktop profile gets its own bundle so the
  // launcher can target it specifically, and the tint is an optional extra on
  // top. Without a dedicated bundle there is no way to tell "this profile's
  // Claude" apart from any other, which is what forced `open -n` and made
  // every Dock click stack up another window.
  if (color !== null && color !== undefined && !isColor(color)) {
    throw new Error(`Unknown colour: ${color}`);
  }
  if (!fileExists(claudeAppPath)) {
    throw new Error(`Claude.app not found at ${claudeAppPath}`);
  }

  const clonePath = clonePathFor(name);
  if (force || cloneIsStale(clonePath, claudeAppPath)) {
    fs.mkdirSync(CLONE_PARENT, { recursive: true });
    if (fileExists(clonePath)) fs.rmSync(clonePath, { recursive: true, force: true });
    // -c asks for an APFS clone; fall back to a real copy on other filesystems.
    try {
      execFileSync("/bin/cp", ["-Rc", claudeAppPath, clonePath]);
    } catch {
      execFileSync("/bin/cp", ["-R", claudeAppPath, clonePath]);
    }
  }

  // Tint from the copy's own icon, not the source's. A copy that updated
  // itself can be a newer build than /Applications, and its icon is the one
  // that belongs on its tile.
  if (color) applyColor(clonePath, clonePath, color);
  return clonePath;
}

// Did the tint survive? A custom icon on a directory is two things, and
// Finder needs both: an `Icon\r` file inside it holding the image, and the
// kHasCustomIcon bit (0x0400) in the directory's FinderInfo flags. An update
// swaps the whole bundle directory, which drops both.
export function finderInfoHasCustomIcon(hexDump) {
  // `xattr -px` prints space-separated hex bytes across lines. The Finder
  // flags are big-endian bytes 8 and 9; kHasCustomIcon is 0x04 in byte 8.
  const bytes = String(hexDump || "").trim().split(/\s+/).filter(Boolean);
  if (bytes.length < 10) return false;
  const hi = parseInt(bytes[8], 16);
  return Number.isFinite(hi) && (hi & 0x04) !== 0;
}

export function hasCustomIcon(appPath) {
  if (!fileExists(path.join(appPath, "Icon\r"))) return false;
  try {
    return finderInfoHasCustomIcon(
      execFileSync("/usr/bin/xattr", ["-px", "com.apple.FinderInfo", appPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
  } catch {
    return false; // no FinderInfo at all means no custom icon
  }
}

export function applyColor(clonePath, claudeAppPath, color) {
  const icns = findAppIcns(claudeAppPath);
  if (!icns) throw new Error("No .icns found inside Claude.app");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-icon-"));
  const png = path.join(tmp, "tinted.png");
  try {
    const tinted = runJxa(TINT_JS, [icns, png, String(COLORS[color])]);
    if (tinted !== "OK") throw new Error(`Could not tint the icon: ${tinted}`);
    const set = runJxa(SETICON_JS, [png, clonePath]);
    if (set !== "OK") throw new Error(`Could not apply the icon: ${set}`);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

export function removeClone(name) {
  const p = clonePathFor(name);
  if (!fileExists(p)) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}

export function describeClone(name) {
  return tildify(clonePathFor(name));
}
