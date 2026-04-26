// `claude-multiprofile remove <name>` - tear down a profile.
//
// Removal is destructive, so we ask twice: once for the profile choice,
// once for whether to delete the data folders. By default the data
// folders survive; we just remove the launcher .app, the shell alias,
// and the registry entry. That way if the user changes their mind, their
// chats and settings are recoverable.

import fs from "node:fs";
import { select, confirm } from "@inquirer/prompts";
import { getRegistry, removeFromRegistry } from "../registry.js";
import { removeAlias } from "../code.js";
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
} from "../util.js";

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
    }
  }

  removeFromRegistry(profile.name);
  ok(`Profile "${profile.name}" removed.`);
}
