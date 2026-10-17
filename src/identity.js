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
//     renamed with it (Electron looks them up as "<name> Helper.app").
//     Electron's Keychain entry for encrypted storage is NOT renamed: it is
//     named after the product name built into Claude's app.asar, so every
//     copy, own identity or not, uses "Claude Safe Storage", the main
//     Claude's entry. Seen 2026-10-17: a copy named "Claude Smoke" asked for
//     "Claude Safe Storage", and no "<name> Safe Storage" entry exists. macOS
//     asks before a copy with its own identity reads it, and "Always Allow"
//     adds the copy's designated requirement to that entry's access list,
//     which is one more reason the requirement must not be claimable by
//     another program (see signing below).
//   - Re-signed on this Mac. Changing Info.plist breaks Anthropic's
//     signature, and an app with a broken signature does not start, so the
//     copy is signed again. Three things go with the old signature:
//       * The entitlements that need Apple's provisioning profile
//         (application-identifier, team-identifier, keychain-access-groups).
//         Sign-in methods built on them (passkeys, hardware keys, Microsoft
//         Entra for work accounts) are unavailable in such a copy; email and
//         Google sign-in are unaffected. The msauth URL scheme goes too.
//       * Library validation, and only that. Six native modules in
//         app.asar.unpacked (computer_use.node, swift_addon.node,
//         claude-native-binding.node, pty.node x2, msal-node-runtime.node)
//         keep Anthropic's signature, and library validation refuses them
//         next to an executable signed by anyone else. The hardened runtime
//         stays on, with the disable-library-validation entitlement added;
//         DYLD_* injection stays blocked, since allowing it is a separate
//         entitlement (allow-dyld-environment-variables) that is never
//         added.
//       * Gatekeeper's blessing. It never looks: the copy is made locally and
//         carries no quarantine flag (a flag inherited from /Applications is
//         removed), and Gatekeeper only assesses quarantined apps.
//     The main bundle is signed with this Mac's own key (src/signing.js),
//     and its designated requirement is the identifier AND that key's
//     certificate. TCC and the Keychain remember an app by its designated
//     requirement, so a copy rebuilt after a Claude update meets the same
//     requirement and keeps its permissions, while no other program can meet
//     it without the key. Using the key asks for the login password, once
//     per Claude update.
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
import {
  ensureSigningIdentity,
  findSigningIdentity,
  copyAnchoredTo,
  explainSigningError,
  parseSigningIdentity,
  designatedRequirement,
  requirementAnchored,
} from "./signing.js";
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

// A profile's Desktop entry with its own identity recorded. The bundle ID is
// fixed when the profile opts in and never derived again: TCC grants and the
// Keychain follow it, so a rename must not change it. Keeps one already
// recorded.
export function withOwnIdentity(name, desktop) {
  return { ...desktop, identity: "own", bundleId: recordedBundleId(name, desktop) };
}

// The recorded bundle ID, or, for a profile that opted in before it was
// recorded, the one derived from its name.
function recordedBundleId(name, desktop) {
  return desktop.bundleId || ownBundleIdFor(name);
}

// The identity a profile's copy carries when it has its own: the recorded
// bundle ID (from the name, for a profile that opted in before it was
// recorded), and the app name from the launcher, which is the name the user
// already knows the profile by.
export function ownIdentityFor(name, desktop) {
  return { bundleId: recordedBundleId(name, desktop), appName: path.basename(desktop.appPath, ".app") };
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
//   "unanchored"    the right identity, but not signed with this Mac's key
//                   (signed before the key existed, or with one made since)
export function identityStatus({ wanted, actual, signed, anchored }) {
  if (!actual) return "missing";
  if (!wanted) return identityKind(actual.bundleId) === "own" ? "needs-shared" : "ok";
  if (actual.bundleId !== wanted.bundleId || actual.name !== wanted.appName) return "needs-own";
  if (signed === false) return "unsigned";
  if (anchored === false) return "unanchored";
  return "ok";
}

// Where a copy on disk stands against what its profile wants, checking its
// signature and that it is signed with this Mac's key only when it carries
// the wanted bundle ID. `signer` is this Mac's key, or null when it has none.
export function checkCopyIdentity(clonePath, wanted) {
  const actual = readIdentity(clonePath);
  const signed = wanted && actual && actual.bundleId === wanted.bundleId ? signatureValid(clonePath) : null;
  const signer = signed ? findSigningIdentity() : null;
  const anchored = signed ? Boolean(signer) && copyAnchoredTo(clonePath, signer) : null;
  return { actual, signer, state: identityStatus({ wanted, actual, signed, anchored }) };
}

// ---- The JXA ------------------------------------------------------------------
//
// Self-contained: its own Foundation import, shell runner and file manager,
// under names that do not clash with the launch helper's, which inlines it:
// helpers are prefixed id*, and the rest are named for what they do to an
// identity (applyIdentity, signCopy, ...), which the helper never defines.
// The signing helpers are pasted in from src/signing.js.
// Everything is macOS's own: NSMutableDictionary for the plists, NSFileManager
// for the renames, codesign for the signature, removexattr for the quarantine
// flag.

export const IDENTITY_JXA = `
// ---- Own app identity. See src/identity.js in the claude-multiprofile repo. ----
ObjC.import('Foundation');
ObjC.bindFunction('removexattr', ['int', ['char *', 'char *', 'int']]);
var idApp = Application.currentApplication();
idApp.includeStandardAdditions = true;
var idFm = $.NSFileManager.defaultManager;
var ID_CODESIGN = '/usr/bin/codesign';
// Entitlements that survive a re-sign. The rest need Apple's provisioning
// profile, and an app that claims them without one does not start.
var ID_KEEP_ENTITLEMENTS = 'com.apple.security.';
// Added to every re-signed bundle: Claude's native modules keep Anthropic's
// signature, which library validation refuses next to our own. It relaxes
// that one check; DYLD_* variables stay blocked by the hardened runtime,
// since allowing them is a separate entitlement we never add.
var ID_DISABLE_LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation';

function idQ(s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; }
function idSh(cmd) { return idApp.doShellScript(cmd); }
function idExists(p) { return idFm.fileExistsAtPath(p); }
function idPlist(p) { return $.NSMutableDictionary.dictionaryWithContentsOfFile(p); }
function idStr(d, key) { var v = d.objectForKey(key); return v.isNil() ? null : String(v.js); }
function idSet(d, key, value) { d.setObjectForKey($(value), key); }
function idRemove(p) { if (idExists(p)) idFm.removeItemAtPathError(p, null); }

// This Mac's signing key (src/signing.js), found the same way as from Node.
${parseSigningIdentity.toString()}
${designatedRequirement.toString()}
${requirementAnchored.toString()}
// Never from the environment: see src/signing.js.
function idSigner() {
  var out = '';
  try { out = idSh('/usr/bin/security find-identity -p codesigning'); } catch (e) {}
  var hash = parseSigningIdentity(out);
  if (!hash) throw new Error('no signing key on this Mac; run claude-multiprofile doctor --fix');
  return hash;
}
function idAnchored(appPath, signer) {
  var text = '';
  try { text = idSh('/usr/bin/codesign -d -r- ' + idQ(appPath) + ' 2>/dev/null'); } catch (e) { return false; }
  return requirementAnchored(text, signer);
}

// Remove an extended attribute by path, from this process. Not /usr/bin/xattr:
// it opens every file, and endpoint security software can hold each open
// by a process started from osascript while it inspects it. On a Mac
// running such software that turned removing the quarantine flag from Claude's
// ~4,000 files into minutes; removexattr opens nothing and takes under a
// second. XATTR_NOFOLLOW: a link's own attribute, never its target's.
function idRemoveXattr(p, name) { $.removexattr(p, name, 1); }
function idRemoveXattrTree(root, name) {
  idRemoveXattr(root, name);
  (ObjC.deepUnwrap(idFm.subpathsOfDirectoryAtPathError(root, null)) || []).forEach(function (sub) {
    idRemoveXattr(root + '/' + sub, name);
  });
}

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

// The entitlements a bundle is re-signed with: its own hardened-runtime ones,
// without those that need Apple's provisioning profile, plus library
// validation turned off.
function writeKeptEntitlements(appPath, outPath) {
  var xml = '';
  try { xml = idSh(ID_CODESIGN + ' -d --entitlements - --xml ' + idQ(appPath) + ' 2>/dev/null'); } catch (e) { xml = ''; }
  var out = $.NSMutableDictionary.dictionary;
  if (xml) {
    var data = $(xml).dataUsingEncoding($.NSUTF8StringEncoding);
    var plist = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null);
    if (!plist.isNil()) {
      (ObjC.deepUnwrap(plist.allKeys) || []).forEach(function (k) {
        if (String(k).indexOf(ID_KEEP_ENTITLEMENTS) === 0) out.setObjectForKey(plist.objectForKey(k), k);
      });
    }
  }
  out.setObjectForKey($.NSNumber.numberWithBool(true), ID_DISABLE_LIBRARY_VALIDATION);
  if (!out.writeToFileAtomically(outPath, true)) throw new Error('could not write the entitlements for ' + appPath);
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

// Inner bundles first, all with the hardened runtime (see the module
// comment). Helper apps keep their own entitlements, through
// writeKeptEntitlements like the app itself, and are signed ad hoc: TCC and
// the Keychain identify the app by its main bundle, so only that is signed
// with this Mac's key, and the key's password prompt comes once.
function signCopy(appPath, bundleId, entitlementsPath, signer) {
  var fw = appPath + '/Contents/Frameworks';
  var nested = ObjC.deepUnwrap(idFm.contentsOfDirectoryAtPathError(fw, null)) || [];
  nested.forEach(function (n) {
    var inner = fw + '/' + n;
    if (n.slice(-10) === '.framework') {
      idSh(ID_CODESIGN + ' --force --deep --sign - ' + idQ(inner) + ' 2>&1');
    } else if (n.slice(-4) === '.app') {
      var ents = entitlementsPath + '.' + n.replace(/[^A-Za-z0-9]+/g, '-') + '.plist';
      try {
        writeKeptEntitlements(inner, ents);
        idSh(ID_CODESIGN + ' --force --sign - --options runtime --entitlements ' + idQ(ents) + ' ' + idQ(inner) + ' 2>&1');
      } finally {
        idRemove(ents);
      }
    }
  });
  idSh(ID_CODESIGN + ' --force --sign ' + idQ(signer) + ' --options runtime --entitlements ' + idQ(entitlementsPath) + ' ' +
    '-r ' + idQ('=designated => ' + designatedRequirement(bundleId, signer)) + ' ' + idQ(appPath) + ' 2>&1');
  idSh(ID_CODESIGN + ' --verify ' + idQ(appPath) + ' 2>&1');
}

// Give a copy of Claude.app its own identity. Returns 'already' when it has
// exactly this one, signed with this Mac's key, 'applied' otherwise. The
// colour (Finder metadata on the bundle) is removed on the way, because the
// signature would seal it in as detritus; callers put it back afterwards.
// The bundle carries this identity, signed with this key.
function idHas(appPath, current, bundleId, appName, signer) {
  return current.bundleId === bundleId && current.name === appName && idAnchored(appPath, signer);
}

function applyIdentity(appPath, bundleId, appName, signer) {
  signer = signer || idSigner();
  var current = identityOf(appPath);
  if (!current) throw new Error('no Info.plist in ' + appPath);
  if (idHas(appPath, current, bundleId, appName, signer)) return 'already';
  var contents = appPath + '/Contents';
  idRemove(appPath + '/Icon\\r');
  idRemoveXattr(appPath, 'com.apple.FinderInfo');
  // A quarantine flag inherited from /Applications (it is on every file)
  // would send an ad hoc signed app to Gatekeeper, which only accepts
  // certificates.
  idRemoveXattrTree(appPath, 'com.apple.quarantine');
  var entitlements = $.NSTemporaryDirectory().js + 'cmp-entitlements-' + $.NSProcessInfo.processInfo.processIdentifier + '.plist';
  try {
    writeKeptEntitlements(appPath, entitlements);
    renameHelpers(appPath, current.name, appName, bundleId);
    var d = idPlist(contents + '/Info.plist');
    idSet(d, 'CFBundleIdentifier', bundleId);
    idSet(d, 'CFBundleName', appName);
    idSet(d, 'CFBundleDisplayName', appName);
    dropMsalUrlTypes(d);
    if (!d.writeToFileAtomically(contents + '/Info.plist', true)) throw new Error('could not write Info.plist');
    idRemove(contents + '/embedded.provisionprofile');
    signCopy(appPath, bundleId, entitlements, signer);
  } finally {
    idRemove(entitlements);
  }
  return 'applied';
}

// Remove a staged or previous copy, read-only folders and all.
function idDiscard(p) {
  if (idExists(p)) idSh('/bin/chmod -R u+w ' + idQ(p) + ' && /bin/rm -rf ' + idQ(p));
}

// applyIdentity for a copy that is in use as a profile's app. The identity is
// applied to a clone beside it, which is swapped in only once its signature
// verifies, so a failure at any step leaves the copy exactly as it was:
// applyIdentity renames the helpers and rewrites Info.plist before it signs,
// and a copy cut off in between does not start. Same scheme and leftover
// names as the launch helper's refresh, which cleans up after a cut-off run.
function applyIdentityStaged(appPath, bundleId, appName, signer) {
  signer = signer || idSigner();
  var current = identityOf(appPath);
  if (!current) throw new Error('no Info.plist in ' + appPath);
  if (idHas(appPath, current, bundleId, appName, signer)) return 'already';
  var tmp = appPath + '.refreshing', old = appPath + '.previous';
  try {
    idDiscard(tmp);
    try { idSh('/bin/cp -Rc ' + idQ(appPath) + ' ' + idQ(tmp)); }
    catch (e) { idSh('/bin/cp -R ' + idQ(appPath) + ' ' + idQ(tmp)); }
    applyIdentity(tmp, bundleId, appName, signer);
    idDiscard(old);
    idSh('/bin/mv ' + idQ(appPath) + ' ' + idQ(old));
    try { idSh('/bin/mv ' + idQ(tmp) + ' ' + idQ(appPath)); }
    catch (e) { idSh('/bin/mv ' + idQ(old) + ' ' + idQ(appPath)); throw e; }
  } catch (e) {
    try { idDiscard(tmp); } catch (e2) {}
    throw e;
  }
  // The new copy is in place; a previous one left behind is cleaned up by
  // the launch helper's recover() or doctor, not reported as a failure.
  try { idDiscard(old); } catch (e) {}
  return 'applied';
}
`;

const IDENTITY_RUNNER = `
function run(argv) { return applyIdentityStaged(argv[0], argv[1], argv[2], argv[3]); }
`;

// Apply an identity to a copy on disk. Returns "applied" or "already".
// Signing hashes the whole app, so give it time. Staged: on failure the copy
// is left as it was.
// `signer` is for tests only: "-" signs ad hoc (src/signing.js).
export function applyOwnIdentity(appPath, { bundleId, appName }, { signer = ensureSigningIdentity().hash } = {}) {
  // The key is made on first use; signing asks for the login keychain password.
  let out;
  try {
    out = runJxa(IDENTITY_JXA + IDENTITY_RUNNER, [appPath, bundleId, appName, signer], { timeout: 300_000 });
  } catch (e) {
    throw new Error(explainSigningError(String(e.stderr || e.message).trim()));
  }
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
