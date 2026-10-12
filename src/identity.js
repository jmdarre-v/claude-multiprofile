// A Desktop profile's own app identity (opt-in).
//
// A profile's copy of Claude.app is a byte-for-byte clone, so macOS sees it
// and /Applications/Claude.app as the same application: same bundle ID
// (com.anthropic.claudefordesktop), same signature, same name. That keeps
// Anthropic's signature intact, and it is why nothing here is the default.
// But everything macOS addresses by bundle ID reaches BOTH copies at once:
//
//   - Granting a permission (Screen Recording, Accessibility, Input
//     Monitoring) in System Settings ends with "Quit & Reopen". That quit
//     goes to every running process with the bundle ID, so the main Claude
//     and every profile get Claude's "still working" prompt together, and
//     whatever was agreed to in one of them is interrupted in all of them.
//     Reported 2026-10-08, with both windows' quit prompts in the shared log.
//   - A permission granted to one is granted to all, and revoked from all.
//   - AppleScript's `tell application "Claude"`, `tell application id ...`
//     and anything else that looks an app up by identifier picks one of the
//     two, with no way to say which.
//
// With its own identity, a profile's copy becomes a separate application to
// macOS:
//
//   - CFBundleIdentifier com.claude-multiprofile.<name>.claude, so permission
//     changes, quits and AppleScript address this profile alone, and it keeps
//     its own permission grants.
//   - CFBundleName "Claude <Name>", the launcher's name. Electron derives the
//     app name from it, so the menu bar, the Dock tile, Cmd-Tab and Force
//     Quit finally say which profile a window is. Its helper apps are
//     renamed with it (Electron looks them up as "<name> Helper.app"), and
//     Electron's Keychain entry for the copy's encrypted storage becomes
//     "<name> Safe Storage" instead of being shared with the main Claude.
//   - Re-signed ad hoc. Changing Info.plist breaks Anthropic's signature, and
//     an app with a broken signature does not start, so the copy is signed
//     again locally. Three things go with the old signature:
//       * The entitlements that need Apple's provisioning profile
//         (application-identifier, team-identifier, keychain-access-groups).
//         Sign-in methods built on them (passkeys, hardware keys, Microsoft
//         Entra for work accounts) are unavailable in such a copy; email and
//         Google sign-in are unaffected. The msauth URL scheme goes too.
//       * The hardened runtime. Claude's frameworks and native modules keep
//         Anthropic's signature, and library validation would refuse to load
//         them next to an ad hoc main executable. Without the hardened
//         runtime there is no library validation.
//       * Gatekeeper's blessing. It never looks: the copy is made locally and
//         carries no quarantine flag (a flag inherited from /Applications is
//         removed), and Gatekeeper only assesses quarantined apps.
//     The designated requirement is set to the identifier alone. TCC and the
//     Keychain remember an app by its designated requirement, so a copy
//     rebuilt after a Claude update satisfies the same requirement and keeps
//     its permissions and its Keychain access, instead of asking again.
//
// Switching an existing profile over has two visible effects, both one-off:
// macOS asks for its permissions again (it is a new app to it), and the
// profile has to sign in again (its encrypted storage was keyed to the shared
// Keychain entry). `identity <name> shared` goes back by rebuilding the copy
// from /Applications/Claude.app, which is the only thing that restores
// Anthropic's signature.
//
// The work is done in JavaScript for Automation so the launch helper can do
// it too: the helper rebuilds a profile's copy after every Claude update, and
// a rebuilt copy must come back with the identity it had.

import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { runJxa } from "./jxa.js";
import { fileExists } from "./util.js";

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export const OWN_BUNDLE_PREFIX = "com.claude-multiprofile.";
export const OWN_BUNDLE_SUFFIX = ".claude";
export const ANTHROPIC_BUNDLE_PREFIX = "com.anthropic.";

// The launcher is com.claude-multiprofile.<name>; the copy is that plus
// ".claude", so the two never collide and the helper can tell them apart.
export function ownBundleIdFor(name) {
  const safe =
    String(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
  return `${OWN_BUNDLE_PREFIX}${safe}${OWN_BUNDLE_SUFFIX}`;
}

// What a profile wants. Absent means shared, which is how every profile
// started out; `identity <name> own` records the choice.
export function wantsOwnIdentity(desktop) {
  return Boolean(desktop) && desktop.identity === "own";
}

// The identity a profile's copy carries when it has its own: the bundle ID
// from the profile name, the app name from the launcher, which is the name
// the user already knows the profile by.
export function ownIdentityFor(name, appPath) {
  return { bundleId: ownBundleIdFor(name), appName: path.basename(appPath, ".app") };
}

// "shared" is Claude's own identity, "own" one of ours, "foreign" anything
// else (a hand-edited plist, or a bundle that is not a copy of Claude).
export function identityKind(bundleId) {
  if (!bundleId) return "unknown";
  if (bundleId.startsWith(ANTHROPIC_BUNDLE_PREFIX)) return "shared";
  if (bundleId.startsWith(OWN_BUNDLE_PREFIX) && bundleId.endsWith(OWN_BUNDLE_SUFFIX)) return "own";
  return "foreign";
}

function plistString(plist, key) {
  try {
    return execFileSync(PLIST_BUDDY, ["-c", `Print :${key}`, plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

// The identity a bundle carries now, or null if it has no readable Info.plist.
export function readIdentity(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fileExists(plist)) return null;
  return { bundleId: plistString(plist, "CFBundleIdentifier"), name: plistString(plist, "CFBundleName") };
}

// Does the copy's signature still verify? A copy whose Info.plist was edited
// without re-signing fails here, and the kernel would refuse to start it.
export function signatureValid(appPath) {
  const r = spawnSync("/usr/bin/codesign", ["--verify", appPath], { stdio: "ignore" });
  return r.status === 0;
}

// Where a copy stands against what its profile wants. Pure, so doctor's
// wording can be tested without a copy of Claude on disk.
//   "missing"       no copy, or no Info.plist in it
//   "ok"            carries what the profile wants
//   "needs-own"     the profile wants its own identity; the copy has another
//   "needs-shared"  the profile wants Claude's identity; the copy has its own
//   "unsigned"      the right identity, but the signature does not verify
export function identityStatus({ wanted, actual, signed }) {
  if (!actual) return "missing";
  if (!wanted) return identityKind(actual.bundleId) === "own" ? "needs-shared" : "ok";
  if (actual.bundleId !== wanted.bundleId || actual.name !== wanted.appName) return "needs-own";
  if (signed === false) return "unsigned";
  return "ok";
}

// ---- The JXA ------------------------------------------------------------------
//
// Self-contained: its own Foundation import, shell runner and file manager,
// under names that do not clash with the launch helper's, which inlines it.
// Everything is macOS's own: NSMutableDictionary for the plists, NSFileManager
// for the renames, codesign for the signature, xattr for the quarantine flag.

export const IDENTITY_JXA = `
// ---- Own app identity. See src/identity.js in the claude-multiprofile repo. ----
ObjC.import('Foundation');
var idApp = Application.currentApplication();
idApp.includeStandardAdditions = true;
var idFm = $.NSFileManager.defaultManager;
var ID_CODESIGN = '/usr/bin/codesign';
var ID_XATTR = '/usr/bin/xattr';
// Entitlements that survive a re-sign. The rest need Apple's provisioning
// profile, and an app that claims them without one does not start.
var ID_KEEP_ENTITLEMENTS = 'com.apple.security.';

function idQ(s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; }
function idSh(cmd) { return idApp.doShellScript(cmd); }
function idExists(p) { return idFm.fileExistsAtPath(p); }
function idPlist(p) { return $.NSMutableDictionary.dictionaryWithContentsOfFile(p); }
function idStr(d, key) { var v = d.objectForKey(key); return v.isNil() ? null : String(v.js); }
function idSet(d, key, value) { d.setObjectForKey($(value), key); }
function idRemove(p) { if (idExists(p)) idFm.removeItemAtPathError(p, null); }

// The identity a bundle carries now.
function identityOf(appPath) {
  var d = idPlist(appPath + '/Contents/Info.plist');
  if (d.isNil()) return null;
  return { bundleId: idStr(d, 'CFBundleIdentifier'), name: idStr(d, 'CFBundleName') };
}

// Electron finds its helper apps by the main bundle's CFBundleName
// ("<name> Helper.app", "<name> Helper (Renderer).app", and so on), so a
// renamed app needs its helpers renamed with it, executable and plist too.
function renameHelpers(appPath, oldName, newName, bundleId) {
  var fw = appPath + '/Contents/Frameworks';
  var names = ObjC.deepUnwrap(idFm.contentsOfDirectoryAtPathError(fw, null)) || [];
  var prefix = oldName + ' Helper';
  names.forEach(function (n) {
    if (n.indexOf(prefix) !== 0 || n.slice(-4) !== '.app') return;
    var suffix = n.slice(prefix.length, -4);
    var oldExe = prefix + suffix, newExe = newName + ' Helper' + suffix;
    var from = fw + '/' + n, to = fw + '/' + newExe + '.app';
    if (from !== to && !idFm.moveItemAtPathToPathError(from, to, null)) throw new Error('could not rename ' + n);
    var macos = to + '/Contents/MacOS';
    if (oldExe !== newExe && idExists(macos + '/' + oldExe) &&
        !idFm.moveItemAtPathToPathError(macos + '/' + oldExe, macos + '/' + newExe, null)) {
      throw new Error('could not rename the executable of ' + n);
    }
    var plist = to + '/Contents/Info.plist';
    var d = idPlist(plist);
    if (d.isNil()) throw new Error('no Info.plist in ' + n);
    idSet(d, 'CFBundleExecutable', newExe);
    idSet(d, 'CFBundleName', newExe);
    idSet(d, 'CFBundleDisplayName', newExe);
    idSet(d, 'CFBundleIdentifier', bundleId + '.helper');
    if (!d.writeToFileAtomically(plist, true)) throw new Error('could not write the Info.plist of ' + n);
  });
}

// Keep the hardened-runtime entitlements, drop the ones that need Apple's
// provisioning profile. Returns false when the app has none to keep.
function writeKeptEntitlements(appPath, outPath) {
  var xml = '';
  try { xml = idSh(ID_CODESIGN + ' -d --entitlements - --xml ' + idQ(appPath) + ' 2>/dev/null'); } catch (e) { xml = ''; }
  if (!xml) return false;
  var data = $(xml).dataUsingEncoding($.NSUTF8StringEncoding);
  var plist = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null);
  if (plist.isNil()) return false;
  var keys = ObjC.deepUnwrap(plist.allKeys) || [];
  var out = $.NSMutableDictionary.dictionary;
  var kept = 0;
  keys.forEach(function (k) {
    if (String(k).indexOf(ID_KEEP_ENTITLEMENTS) !== 0) return;
    out.setObjectForKey(plist.objectForKey(k), k);
    kept++;
  });
  if (!kept) return false;
  return Boolean(out.writeToFileAtomically(outPath, true));
}

// The msauth.<bundle id> scheme is Microsoft's broker callback, tied to the
// keychain access group that does not survive. Without the group it would
// only ever misroute.
function dropMsalUrlTypes(d) {
  var types = d.objectForKey('CFBundleURLTypes');
  if (types.isNil()) return;
  var keep = $.NSMutableArray.array;
  for (var i = 0; i < types.count; i++) {
    var t = types.objectAtIndex(i);
    var schemes = ObjC.deepUnwrap(t.objectForKey('CFBundleURLSchemes')) || [];
    var msal = schemes.some(function (s) { return String(s).indexOf('msauth.') === 0; });
    if (!msal) keep.addObject(t);
  }
  d.setObjectForKey(keep, 'CFBundleURLTypes');
}

// Ad hoc, inner bundles first, no hardened runtime (see the module comment).
// The designated requirement is the identifier alone, so a rebuilt copy is
// the same app to TCC and the Keychain.
function signAdHoc(appPath, bundleId, entitlementsPath) {
  var fw = appPath + '/Contents/Frameworks';
  var nested = ObjC.deepUnwrap(idFm.contentsOfDirectoryAtPathError(fw, null)) || [];
  nested.forEach(function (n) {
    if (n.slice(-4) !== '.app' && n.slice(-10) !== '.framework') return;
    idSh(ID_CODESIGN + ' --force --deep --sign - --preserve-metadata=entitlements ' + idQ(fw + '/' + n) + ' 2>&1');
  });
  idSh(ID_CODESIGN + ' --force --sign - ' +
    (entitlementsPath ? '--entitlements ' + idQ(entitlementsPath) + ' ' : '') +
    "-r '=designated => identifier \\"" + bundleId + "\\"' " + idQ(appPath) + ' 2>&1');
  idSh(ID_CODESIGN + ' --verify ' + idQ(appPath) + ' 2>&1');
}

// Give a copy of Claude.app its own identity. Returns 'already' when it has
// exactly this one, 'applied' otherwise. The colour (Finder metadata on the
// bundle) is removed on the way, because the signature would seal it in as
// detritus; callers put it back afterwards.
function applyIdentity(appPath, bundleId, appName) {
  var current = identityOf(appPath);
  if (!current) throw new Error('no Info.plist in ' + appPath);
  if (current.bundleId === bundleId && current.name === appName) return 'already';
  var contents = appPath + '/Contents';
  idRemove(appPath + '/Icon\\r');
  try { idSh(ID_XATTR + ' -d com.apple.FinderInfo ' + idQ(appPath) + ' 2>/dev/null'); } catch (e) {}
  // A quarantine flag inherited from /Applications would send an ad hoc
  // signed app to Gatekeeper, which only accepts certificates.
  try { idSh(ID_XATTR + ' -dr com.apple.quarantine ' + idQ(appPath) + ' 2>/dev/null'); } catch (e) {}
  var entitlements = $.NSTemporaryDirectory().js + 'cmp-entitlements-' + $.NSProcessInfo.processInfo.processIdentifier + '.plist';
  var kept = writeKeptEntitlements(appPath, entitlements);
  try {
    renameHelpers(appPath, current.name, appName, bundleId);
    var d = idPlist(contents + '/Info.plist');
    idSet(d, 'CFBundleIdentifier', bundleId);
    idSet(d, 'CFBundleName', appName);
    idSet(d, 'CFBundleDisplayName', appName);
    dropMsalUrlTypes(d);
    if (!d.writeToFileAtomically(contents + '/Info.plist', true)) throw new Error('could not write Info.plist');
    idRemove(contents + '/embedded.provisionprofile');
    signAdHoc(appPath, bundleId, kept ? entitlements : null);
  } finally {
    idRemove(entitlements);
  }
  return 'applied';
}
`;

const IDENTITY_RUNNER = `
function run(argv) { return applyIdentity(argv[0], argv[1], argv[2]); }
`;

// Apply an identity to a copy on disk. Returns "applied" or "already".
// Signing hashes the whole app, so give it time.
export function applyOwnIdentity(appPath, { bundleId, appName }) {
  const out = runJxa(IDENTITY_JXA + IDENTITY_RUNNER, [appPath, bundleId, appName], { timeout: 300_000 });
  if (out !== "applied" && out !== "already") throw new Error(out || "no result from the identity script");
  if (out === "applied" && fileExists(LSREGISTER)) {
    try {
      execFileSync(LSREGISTER, ["-f", appPath], { stdio: "pipe" });
    } catch {
      // Non-fatal; LaunchServices catches up on the next launch.
    }
  }
  return out;
}
