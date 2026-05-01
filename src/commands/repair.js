// `claude-multiprofile repair <name>` - fix a profile's launcher when
// double-clicking the icon stops working.
//
// The bug class:
//
// macOS keeps a LaunchServices database that maps .app bundles to launch
// behavior. The database can get into a stale state where a previously
// working .app stops responding to double-clicks, even though the bundle
// is intact, has no quarantine xattr, and `open <path>` from the terminal
// still launches it correctly. Symptoms: clicking the Dock icon does
// nothing, dragging from Finder does nothing, but Terminal `open` works.
//
// The fix is to re-register the .app with LaunchServices using the
// bundled `lsregister` tool. This rebuilds the entry, refreshes the
// icon cache, and double-click starts working again.
//
// We don't try to detect WHEN this is needed; we just make the fix one
// command away. Running it on a healthy profile is harmless.

import { execFileSync } from "node:child_process";
import { findProfile } from "../registry.js";
import {
  header,
  ok,
  warn,
  info,
  err,
  step,
  pathStr,
  tildify,
  fileExists,
  isMac,
  command,
} from "../util.js";

// Full path to lsregister. It lives deep inside the LaunchServices
// framework and is not on $PATH by default. Hard-coded here because the
// path has been stable across macOS versions for many years.
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export async function repair(args) {
  header("Repair a profile launcher");

  if (!isMac()) {
    err("repair is a macOS-only command (LaunchServices doesn't exist elsewhere).");
    process.exit(1);
  }

  // ---- Resolve the profile -----------------------------------------------

  const name = args[0];
  if (!name) {
    err("Profile name required.");
    info(`Usage: ${command("claude-multiprofile repair <name>")}`);
    info(`Run ${command("claude-multiprofile list")} to see configured profiles.`);
    process.exit(1);
  }

  const profile = findProfile(name);
  if (!profile) {
    err(`Profile "${name}" not found.`);
    info(`Run ${command("claude-multiprofile list")} to see configured profiles.`);
    process.exit(1);
  }

  // ---- Check there's actually something to repair ------------------------

  if (!profile.desktop) {
    info(`Profile "${name}" is a Code-only profile.`);
    info("There's no Desktop launcher to repair.");
    info("If `claude-" + name + "` isn't working in your terminal, check that your shell rc file is sourced.");
    return;
  }

  const appPath = profile.desktop.appPath;
  step(`Repairing launcher for "${name}"`);
  info(`Launcher: ${pathStr(tildify(appPath))}`);

  // ---- Verify the .app bundle is on disk ---------------------------------

  if (!fileExists(appPath)) {
    err(`Launcher .app not found on disk.`);
    info(`Re-run ${command(`claude-multiprofile add`)} to recreate it (use the same profile name and paths to keep your data folder).`);
    process.exit(1);
  }

  // ---- Verify lsregister is present --------------------------------------

  if (!fileExists(LSREGISTER)) {
    err(`lsregister not found at the expected path:`);
    err(`  ${LSREGISTER}`);
    err("This is unexpected on macOS. The repair cannot proceed.");
    process.exit(1);
  }

  // ---- Re-register with LaunchServices -----------------------------------
  //
  // -f forces a refresh of the LaunchServices entry for this specific
  // bundle. We could also use -R to recursively scan a directory, but
  // targeting the single app is faster and avoids side effects.

  try {
    execFileSync(LSREGISTER, ["-f", appPath], { stdio: "pipe" });
    ok("Re-registered with LaunchServices.");
  } catch (e) {
    err(`lsregister failed: ${e.message}`);
    process.exit(1);
  }

  // ---- Touch the bundle to nudge Finder/Dock icon refresh ----------------
  //
  // Same trick we use during initial setup. Without it, the Dock can
  // sometimes hold on to a stale icon cache for a few minutes after
  // re-registration.

  try {
    execFileSync("/usr/bin/touch", [appPath]);
    ok("Refreshed bundle modification time (icon cache hint).");
  } catch {
    // Non-fatal. The lsregister step is what actually fixes the bug;
    // touch is just a polish step.
    warn("Could not touch the .app, but lsregister succeeded. The fix should still work.");
  }

  // ---- Restart the Dock --------------------------------------------------
  //
  // Even after lsregister succeeds, the Dock keeps its own in-memory
  // cache mapping its visible icons to specific .app references. If the
  // user pinned the launcher to the Dock before the LaunchServices
  // registration went stale, the pinned icon will continue to be
  // unresponsive even though the underlying app is now fixed. Killing
  // the Dock forces it to reload its state from disk, picking up the
  // refreshed registration. macOS auto-restarts the Dock immediately,
  // so the user sees a brief blink rather than a permanent absence.

  info("Refreshing the Dock (it'll briefly disappear and reappear)...");
  try {
    execFileSync("/usr/bin/killall", ["Dock"]);
    ok("Dock refreshed.");
  } catch {
    // Non-fatal. If the Dock isn't running for some reason, or killall
    // is denied, the user can still drag the icon off the Dock and
    // re-add it manually.
    warn("Could not refresh the Dock. If the icon is still unresponsive, drag it off the Dock and re-add the launcher.");
  }

  console.log("");
  ok(`Done. Try double-clicking ${pathStr(tildify(appPath))} now.`);
  info("If it still doesn't launch, log out and log back in to force a full LaunchServices reset.");
}
