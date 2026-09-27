// The launch helper: what a profile's launcher runs when you click it.
//
// Two jobs, both done at the moment you reach for the profile:
//
//   1. Keep the profile's copy of Claude current. Copies no longer update
//      themselves (see src/updates.js), so when /Applications/Claude.app has
//      moved ahead, the helper rebuilds the copy from it, re-applies the
//      colour, and then opens it. About a second, once per Claude update.
//   2. Catch the profile running on the wrong account. A copy started any way
//      other than through its launcher (a pinned window tile, Spotlight, a
//      Login Item, an update relaunch) has no --user-data-dir and shows the
//      default account. Clicking the launcher used to just bring that window
//      forward. Now it asks whether to quit it and reopen it properly.
//
// It is JavaScript for Automation, run by `osascript -l JavaScript`, which
// ships with macOS. Launchers are started from the Dock, which does not get
// the shell's PATH, so anything that needed Node would work on the author's
// machine and fail everywhere else. Everything here is macOS's own: plist
// reading, APFS copies, the Core Image hue filter, NSWorkspace for the icon,
// NSRunningApplication to quit one specific copy.
//
// The helper must never be the reason Claude does not open. Every failure is
// logged and falls through to opening the copy as it is, and the launcher
// itself falls back to its plain `open` line if the helper file is missing.

import fs from "node:fs";
import path from "node:path";
import { HOME, fileExists } from "./util.js";
import { COLORS } from "./appclone.js";

// Bump when HELPER_JS changes, so doctor can tell a stale copy on disk.
export const HELPER_VERSION = 1;

const TOOL_DIR = path.join(HOME, "Library", "Application Support", "claude-multiprofile");
export const HELPER_PATH = path.join(TOOL_DIR, "bin", "launch.js");
export const LAUNCH_LOG = path.join(TOOL_DIR, "launch.log");

// What compileApp needs to route a launcher through the helper.
export function helperSpecFor({ sourceAppPath, color, appPath }) {
  return {
    path: HELPER_PATH,
    source: sourceAppPath,
    hue: color && Object.prototype.hasOwnProperty.call(COLORS, color) ? String(COLORS[color]) : "",
    label: path.basename(appPath, ".app"),
  };
}

export function helperState() {
  if (!fileExists(HELPER_PATH)) return "missing";
  try {
    return fs.readFileSync(HELPER_PATH, "utf8") === HELPER_JS ? "current" : "outdated";
  } catch {
    return "missing";
  }
}

// Returns "installed", "updated", or "current".
export function installHelper() {
  const before = helperState();
  if (before === "current") return "current";
  fs.mkdirSync(path.dirname(HELPER_PATH), { recursive: true });
  fs.writeFileSync(HELPER_PATH, HELPER_JS, "utf8");
  return before === "missing" ? "installed" : "updated";
}

// Recent helper log lines, newest last. Each line is
// "YYYY-MM-DD HH:MM:SS <label>: <LEVEL> <message>".
export function recentLaunchLog({ sinceMs = 7 * 24 * 3600 * 1000, levels = null } = {}) {
  let text;
  try {
    text = fs.readFileSync(LAUNCH_LOG, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - sinceMs;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.*?): (INFO|WARN|ERROR) (.*)$/);
      if (!m) return null;
      return { at: new Date(m[1].replace(" ", "T")).getTime(), label: m[2], level: m[3], message: m[4], line };
    })
    .filter((e) => e && e.at >= cutoff && (!levels || levels.includes(e.level)));
}

// ---- The helper itself -------------------------------------------------------
//
// argv: <clone> <source> <hue|""> <dataDir> <label> <open args...>
// The open args are passed straight to /usr/bin/open as an array, so no path
// is ever re-parsed by a shell.
//
// CMP_LAUNCH_DRY_RUN=1 prints the decision instead of acting.
// CMP_LAUNCH_ASSUME=reopen|leave answers the wrong-account question without a
// dialog. Both exist so the decisions can be tested without clicking.

export const HELPER_JS = `// claude-multiprofile launch helper v${HELPER_VERSION}
// Written by claude-multiprofile; rewritten by \`claude-multiprofile doctor --fix\`.
// Keeps this profile's copy of Claude current and catches it running on the
// wrong account. See src/launchhelper.js in the claude-multiprofile repo.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreImage');

var app = Application.currentApplication();
app.includeStandardAdditions = true;
var fm = $.NSFileManager.defaultManager;
var LOG = $.NSHomeDirectory().js + '/Library/Application Support/claude-multiprofile/launch.log';
var LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
var label = 'launcher';

function env(name) {
  var v = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return v.isNil() ? '' : v.js;
}
function q(s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; }
function exists(p) { return fm.fileExistsAtPath(p); }
function pad(n) { return (n < 10 ? '0' : '') + n; }

function log(level, msg) {
  // A dry run reports; it must not leave entries for doctor to find.
  if (env('CMP_LAUNCH_DRY_RUN') === '1') return;
  try {
    var d = new Date();
    var line = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' +
      label + ': ' + level + ' ' + String(msg).replace(/[\\r\\n]+/g, ' ') + '\\n';
    var data = $(line).dataUsingEncoding($.NSUTF8StringEncoding);
    if (!exists(LOG)) { data.writeToFileAtomically(LOG, true); return; }
    var attrs = fm.attributesOfItemAtPathError(LOG, null);
    if (!attrs.isNil() && attrs.fileSize > 262144) {
      // Keep the log small: drop the older half.
      var old = $.NSString.stringWithContentsOfFileEncodingError(LOG, $.NSUTF8StringEncoding, null).js || '';
      $(old.slice(old.length / 2)).writeToFileAtomicallyEncodingError(LOG, true, $.NSUTF8StringEncoding, null);
    }
    var h = $.NSFileHandle.fileHandleForWritingAtPath(LOG);
    h.seekToEndOfFile;
    h.writeData(data);
    h.closeFile;
  } catch (e) {}
}

function plistValue(appPath, key) {
  var d = $.NSDictionary.dictionaryWithContentsOfFile(appPath + '/Contents/Info.plist');
  if (d.isNil()) return null;
  var v = d.objectForKey(key);
  return v.isNil() ? null : v.js;
}
function version(appPath) { return plistValue(appPath, 'CFBundleShortVersionString'); }

// Only ever open Claude. If the path handed to us is anything else (a
// launcher, most dangerously this one), opening it would run the helper
// again and loop. A missing copy is different: open fails harmlessly.
function isClaude(appPath) {
  var id = plistValue(appPath, 'CFBundleIdentifier');
  return id === null || id.indexOf('com.anthropic.') === 0;
}

function compare(a, b) {
  var x = String(a).split('.'), y = String(b).split('.');
  for (var i = 0; i < Math.max(x.length, y.length); i++) {
    var p = parseInt(x[i] || '0', 10), r = parseInt(y[i] || '0', 10);
    if (p < r) return -1;
    if (p > r) return 1;
  }
  return 0;
}

// Main processes of this copy, with their command lines. Helper processes
// live under Contents/Frameworks, so matching Contents/MacOS/ excludes them.
function running(clone) {
  var out = app.doShellScript('/bin/ps -axww -o pid=,command=');
  var needle = clone + '/Contents/MacOS/';
  var found = [];
  out.split(/[\\r\\n]+/).forEach(function (line) {
    var m = line.match(/^\\s*(\\d+)\\s+(.*)$/);
    if (m && m[2].indexOf(needle) === 0) found.push({ pid: parseInt(m[1], 10), command: m[2] });
  });
  return found;
}

function onProfile(command, dataDir) {
  // Followed by a space or the end, so Claude-WORK never matches Claude-WORK2.
  var flag = ' --user-data-dir=' + dataDir;
  var i = command.indexOf(flag);
  if (i < 0) return false;
  var next = command.charAt(i + flag.length);
  return next === '' || next === ' ';
}

function tint(appPath, hue) {
  var res = appPath + '/Contents/Resources';
  var names = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(res, null)) || [];
  var icns = null;
  for (var i = 0; i < names.length; i++) {
    if (names[i].toLowerCase().slice(-5) === '.icns') { icns = res + '/' + names[i]; break; }
  }
  if (!icns) throw new Error('no .icns in the copy');
  var data = $.NSData.dataWithContentsOfFile(icns);
  var ci = $.CIImage.imageWithData(data);
  if (ci.isNil()) throw new Error('icon is not an image');
  var f = $.CIFilter.filterWithName('CIHueAdjust');
  f.setDefaults;
  f.setValueForKey(ci, 'inputImage');
  f.setValueForKey($.NSNumber.numberWithDouble(parseFloat(hue) * Math.PI / 180), 'inputAngle');
  // Same route as the tool's own tint (src/appclone.js): render the filter
  // into a bitmap before handing it to NSWorkspace.
  var rep = $.NSCIImageRep.imageRepWithCIImage(f.valueForKey('outputImage'));
  var img = $.NSImage.alloc.initWithSize(rep.size);
  img.addRepresentation(rep);
  var bmp = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  var out = $.NSImage.alloc.initWithSize(bmp.size);
  out.addRepresentation(bmp);
  var ok = $.NSWorkspace.sharedWorkspace.setIconForFileOptions(out, appPath, 0);
  if (!ok) throw new Error('could not set the icon');
}

// Rebuild the copy from its source when the source is newer. The new copy is
// built beside the old one and swapped in only once it is complete, so a
// failure at any step leaves the old copy exactly as it was.
function refresh(clone, source, hue) {
  var have = version(clone), want = version(source);
  if (!have || !want) { log('WARN', 'could not read versions (copy ' + have + ', source ' + want + '); opening as is'); return 'unknown'; }
  if (compare(have, want) >= 0) return 'current';
  if (env('CMP_LAUNCH_DRY_RUN') === '1') return 'would-refresh ' + have + ' -> ' + want;

  var tmp = clone + '.refreshing', old = clone + '.previous';
  try {
    if (exists(tmp)) app.doShellScript('/bin/rm -rf ' + q(tmp));
    try { app.doShellScript('/bin/cp -Rc ' + q(source) + ' ' + q(tmp)); }
    catch (e) { app.doShellScript('/bin/cp -R ' + q(source) + ' ' + q(tmp)); }
    if (version(tmp) !== want) throw new Error('the copy came out as ' + version(tmp) + ', not ' + want);
    if (hue) tint(tmp, hue);
    if (exists(old)) app.doShellScript('/bin/rm -rf ' + q(old));
    app.doShellScript('/bin/mv ' + q(clone) + ' ' + q(old));
    try { app.doShellScript('/bin/mv ' + q(tmp) + ' ' + q(clone)); }
    catch (e) { app.doShellScript('/bin/mv ' + q(old) + ' ' + q(clone)); throw e; }
    app.doShellScript('/bin/rm -rf ' + q(old));
    try { app.doShellScript(q(LSREGISTER) + ' -f ' + q(clone)); } catch (e) {}
    log('INFO', 'updated the copy from ' + have + ' to ' + want);
    return 'refreshed';
  } catch (e) {
    try { if (exists(tmp)) app.doShellScript('/bin/rm -rf ' + q(tmp)); } catch (e2) {}
    log('ERROR', 'could not update the copy from ' + have + ' to ' + want + ': ' + e.message + '; opening ' + have);
    return 'failed';
  }
}

function quit(pids) {
  pids.forEach(function (pid) {
    var ra = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (!ra.isNil()) ra.terminate;
  });
  for (var i = 0; i < 60; i++) {
    var alive = pids.filter(function (pid) {
      return !$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid).isNil();
    });
    if (alive.length === 0) return true;
    delay(0.25);
  }
  return false;
}

function ask(message, buttons, defaultButton) {
  var assumed = env('CMP_LAUNCH_ASSUME');
  if (assumed) return assumed === 'reopen' ? defaultButton : buttons[0];
  app.activate();
  try {
    return app.displayDialog(message, {
      withTitle: label, buttons: buttons, defaultButton: defaultButton,
      cancelButton: buttons[0], withIcon: 'caution'
    }).buttonReturned;
  } catch (e) {
    return buttons[0];
  }
}

function open(args) {
  var t = $.NSTask.alloc.init;
  t.launchPath = '/usr/bin/open';
  t.arguments = $(args);
  t.launch;
  t.waitUntilExit;
}

function run(argv) {
  var clone = argv[0], source = argv[1], hue = argv[2], dataDir = argv[3];
  label = argv[4] || label;
  var openArgs = argv.slice(5);
  var dry = env('CMP_LAUNCH_DRY_RUN') === '1';

  if (!isClaude(clone)) {
    log('ERROR', clone + ' is not a copy of Claude (bundle ' + plistValue(clone, 'CFBundleIdentifier') +
      '); not opening it. Run claude-multiprofile doctor --fix');
    return dry ? 'refused: not Claude' : 'refused';
  }

  try {
    var procs = running(clone);
    if (procs.length) {
      var wrong = procs.filter(function (p) { return !onProfile(p.command, dataDir); });
      if (!wrong.length) {
        if (dry) return 'running on its profile: focus';
        open(openArgs);
        return 'focused';
      }
      var pids = wrong.map(function (p) { return p.pid; });
      log('WARN', 'open on the wrong account (pid ' + pids.join(', ') + ', not started with this profile\\'s data folder)');
      if (dry) return 'wrong account: pid ' + pids.join(', ');
      var answer = ask(
        label + ' is open on the wrong account.\\n\\n' +
        'It was started without its profile (by a Claude update, a pinned window tile, Spotlight or a Login Item), ' +
        'so it is showing your default Claude account instead.\\n\\nQuit it and reopen ' + label + ' correctly?',
        ['Leave It Open', 'Quit and Reopen'], 'Quit and Reopen');
      if (answer !== 'Quit and Reopen') {
        log('INFO', 'left the wrong-account window open, as asked');
        return 'left';
      }
      if (!quit(pids)) {
        log('WARN', 'it did not quit within 15 seconds');
        ask(label + ' did not quit. Quit it from its Claude menu, then click ' + label + ' again.', ['OK'], 'OK');
        return 'quit-timeout';
      }
      log('INFO', 'quit the wrong-account window; reopening on the profile');
    }
    var r = refresh(clone, source, hue);
    if (dry) return 'not running: ' + r;
  } catch (e) {
    log('ERROR', 'unexpected: ' + e.message + '; opening as is');
    if (dry) return 'error: ' + e.message;
  }
  open(openArgs);
  return 'opened';
}
`;
