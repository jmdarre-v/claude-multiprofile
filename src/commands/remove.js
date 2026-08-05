// `claude-multiprofile remove <name>` - tear down a profile.
//
// Removal is destructive, so we ask twice: once for the profile choice,
// once for whether to delete the data folders. By default the data
// folders survive; we just remove the launcher .app, the shell alias,
// and the registry entry. That way if the user changes their mind, their
// chats and settings are recoverable.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { select, confirm } from "@inquirer/prompts";
import { getRegistry, removeFromRegistry } from "../registry.js";
import { removeAlias } from "../code.js";
import { resyncDenyRules, stripManagedDenyRules } from "../permissions.js";
import {
  header,
  ok,
  warn,
  info,
  step,
  explain,
  pathStr,
  tildify,
  fileExists,
  dim,
} from "../util.js";

// Same path `repair` uses. Deleting a .app without unregistering it leaves a
// dangling LaunchServices entry, which is one source of "ghost" launchers
// that still appear in Spotlight / Open With menus after removal.
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export async function remove(args) {
  header("Remove a Claude profile");

  const reg = getRegistry();
  if (reg.profiles.length === 0) {
    warn("No profiles configured.");
    return;
  }

  // Allow `claude-multiprofile remove work` as a shortcut.
  let target = args[0];
  if (!target) {
    target = await select({
      message: "Which profile do you want to remove?",
      choices: reg.profiles.map((p) => ({
        name: `${p.name} (${p.type})`,
        value: p.name,
      })),
    });
  }

  const profile = reg.profiles.find((p) => p.name === target);
  if (!profile) {
    warn(`Profile "${target}" not found. Run \`claude-multiprofile list\` to see options.`);
    return;
  }

  explain(`
    Removal does the following:

      - Deletes the launcher .app (Desktop profiles only)
      - Removes the shell alias from your rc file (Code profiles only)
      - Removes the entry from the registry

    By default, the data folder (chat history, settings, MCP config) is
    LEFT IN PLACE so you can recover it later. You'll be asked separately
    if you want to delete it too.
  `);

  const proceed = await confirm({
    message: `Remove profile "${profile.name}"?`,
    default: false,
  });
  if (!proceed) {
    warn("Cancelled.");
    return;
  }

  // ---- Desktop teardown ------------------------------------------------

  if (profile.desktop) {
    step("Removing Desktop launcher");
    if (fileExists(profile.desktop.appPath)) {
      // Unregister from LaunchServices BEFORE deleting the bundle. Once the
      // files are gone lsregister can't resolve the bundle to remove its
      // entry, and the stale registration lingers until the database is
      // rebuilt.
      if (fileExists(LSREGISTER)) {
        try {
          execFileSync(LSREGISTER, ["-u", profile.desktop.appPath], {
            stdio: "pipe",
          });
          ok("Unregistered launcher from LaunchServices.");
        } catch {
          // Non-fatal: worst case is a stale entry until the next rebuild.
          warn("Could not unregister from LaunchServices (continuing).");
        }
      }
      try {
        fs.rmSync(profile.desktop.appPath, { recursive: true, force: true });
        ok(`Deleted ${pathStr(tildify(profile.desktop.appPath))}.`);
      } catch (e) {
        warn(`Could not delete launcher: ${e.message}`);
      }
    } else {
      info("Launcher already gone, skipping.");
    }

    const wipeDesktopData = await confirm({
      message: `Also delete the Desktop data folder (${tildify(profile.desktop.dataDir)})? This is permanent.`,
      default: false,
    });
    if (wipeDesktopData && fileExists(profile.desktop.dataDir)) {
      try {
        fs.rmSync(profile.desktop.dataDir, { recursive: true, force: true });
        ok(`Deleted ${pathStr(tildify(profile.desktop.dataDir))}.`);
      } catch (e) {
        warn(`Could not delete data folder: ${e.message}`);
      }
    }
  }

  // ---- Code teardown ---------------------------------------------------

  if (profile.code) {
    step("Removing Code alias");
    const { rcPath } = removeAlias(profile.code.aliasName);
    ok(`Alias removed from ${pathStr(tildify(rcPath))}.`);

    const wipeCodeData = await confirm({
      message: `Also delete the Code config folder (${tildify(profile.code.configDir)})? This is permanent.`,
      default: false,
    });
    if (wipeCodeData && fileExists(profile.code.configDir)) {
      try {
        fs.rmSync(profile.code.configDir, { recursive: true, force: true });
        ok(`Deleted ${pathStr(tildify(profile.code.configDir))}.`);
      } catch (e) {
        warn(`Could not delete config folder: ${e.message}`);
      }
    } else if (!wipeCodeData) {
      // The folder stays behind, so clean OUR deny rules out of its
      // settings.json. The profile is leaving the registry; stale rules
      // pointing at its former siblings would silently block reads if this
      // folder is ever used with Claude Code again.
      if (stripManagedDenyRules(profile)) {
        ok("Removed this tool's read-protection rules from the kept folder.");
      }
    }
  }

  removeFromRegistry(profile.name);
  ok(`Profile "${profile.name}" removed.`);

  // Rewrite the remaining profiles' cross-profile deny rules so they no
  // longer reference the profile we just deleted.
  resyncDenyRules(getRegistry(), { verbose: true });

  // ---- Keychain guidance -------------------------------------------------
  //
  // Claude Code stores its OAuth token in the login Keychain under a service
  // name like `Claude Code-credentials-<hash>`, where the hash is derived
  // from CLAUDE_CONFIG_DIR by a scheme we can't reproduce. That means we
  // cannot reliably identify (let alone delete) the entry for this specific
  // profile, and guessing risks deleting the WRONG account's credentials.
  //
  // The orphaned entry is inert, since nothing reads it once the config dir
  // is gone, so leaving it is safe. We tell the user the clean way to avoid
  // creating one in the first place.
  if (profile.code) {
    console.log("");
    info("Note: this profile's saved login remains in your Keychain.");
    console.log(
      "  " +
        dim(
          "It's inert (nothing reads it now), but to avoid leaving one behind next time,"
        )
    );
    console.log(
      "  " + dim('run "/logout" inside the profile before removing it.')
    );
    console.log(
      "  " +
        dim(
          'To clear it by hand: Keychain Access → search "Claude Code-credentials".'
        )
    );
  }
}
