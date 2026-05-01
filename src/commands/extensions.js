// `claude-multiprofile extensions` - copy Claude Desktop extensions from
// one Desktop install (the default install or any registered profile)
// into another registered Desktop profile.
//
// Background:
//
// Claude Desktop's extension system stores each extension as two pieces:
//
//   - A folder under `Claude Extensions/<extension-id>/` containing the
//     extension's runtime files (manifests, scripts, etc.)
//   - A JSON config file `Claude Extensions Settings/<extension-id>.json`
//     containing the user's per-extension configuration.
//
// Both pieces must travel together for the extension to work. Copying
// one without the other leaves Claude Desktop in a confused state.
//
// Profiles created by this tool start empty (we never copy extensions
// at creation time, by design — the profile is meant to be isolated).
// But "isolated" doesn't have to mean "barren forever". Re-installing
// every extension by hand on every profile is the friction this command
// removes.
//
// Usage:
//
//   claude-multiprofile extensions            # fully interactive
//   claude-multiprofile extensions --force    # overwrite conflicts
//
// Both source and target are picked from a menu — no profile name argument
// to mistype.
//
// We do NOT install extensions during `add` time — keeping `add` focused
// on getting a profile up and running. This is a separate command users
// run when they want it.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkbox, confirm, select } from "@inquirer/prompts";
import { getRegistry } from "../registry.js";
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
  dim,
  command,
} from "../util.js";
import { DEFAULT_DESKTOP_DATA_DIR, detectDefaults } from "../detect.js";

const EXT_DIR_NAME = "Claude Extensions";
const EXT_SETTINGS_DIR_NAME = "Claude Extensions Settings";

// ---- Discovery -------------------------------------------------------------

function listExtensions(dataDir) {
  // Returns the set of extension IDs in this dataDir, paired with whether
  // each has a matching settings JSON. An extension is "complete" only if
  // both the folder and the .json exist; we surface incomplete pairs as
  // warnings rather than silently dropping them.
  const extDir = path.join(dataDir, EXT_DIR_NAME);
  const settingsDir = path.join(dataDir, EXT_SETTINGS_DIR_NAME);

  if (!fileExists(extDir)) return [];

  const folderNames = fs
    .readdirSync(extDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  return folderNames.map((id) => {
    const settingsPath = path.join(settingsDir, `${id}.json`);
    return {
      id,
      folderPath: path.join(extDir, id),
      settingsPath,
      hasSettings: fileExists(settingsPath),
    };
  });
}

// ---- Copy -----------------------------------------------------------------

function copyExtension(ext, targetDataDir) {
  // Copy both the folder and (if present) the settings file. We use
  // `cp -R` so macOS metadata (extended attributes, resource forks) is
  // preserved properly, which matters for code-signed extension contents.
  const targetExtDir = path.join(targetDataDir, EXT_DIR_NAME);
  const targetSettingsDir = path.join(targetDataDir, EXT_SETTINGS_DIR_NAME);

  fs.mkdirSync(targetExtDir, { recursive: true });
  fs.mkdirSync(targetSettingsDir, { recursive: true });

  const targetFolder = path.join(targetExtDir, ext.id);

  // Remove existing target first so cp -R doesn't merge into a stale copy.
  if (fileExists(targetFolder)) {
    fs.rmSync(targetFolder, { recursive: true, force: true });
  }
  execFileSync("/bin/cp", ["-R", ext.folderPath, targetFolder]);

  if (ext.hasSettings) {
    const targetSettings = path.join(targetSettingsDir, `${ext.id}.json`);
    fs.copyFileSync(ext.settingsPath, targetSettings);
  }
}

// ---- Top-level command -----------------------------------------------------

export async function extensions(args) {
  header("Copy Claude Desktop extensions");

  const force = args.includes("--force");

  // ---- Build the list of available Desktop installs -----------------------
  //
  // Sources include the user's default install (if present) plus every
  // registered profile that has Desktop configured. Targets are the same
  // set minus the default install (we never write into the user's main
  // Claude data dir — that's reserved as their baseline).

  const defaults = detectDefaults();
  const registry = getRegistry();
  const desktopProfiles = registry.profiles.filter((p) => p.desktop);

  const sourceChoices = [];
  if (defaults.desktop) {
    sourceChoices.push({
      name: `default install ${dim(`(${tildify(DEFAULT_DESKTOP_DATA_DIR)})`)}`,
      value: { label: "default install", dataDir: DEFAULT_DESKTOP_DATA_DIR, isDefault: true },
    });
  }
  for (const p of desktopProfiles) {
    sourceChoices.push({
      name: `${p.name} ${dim(`(${tildify(p.desktop.dataDir)})`)}`,
      value: { label: p.name, dataDir: p.desktop.dataDir, isDefault: false },
    });
  }

  if (sourceChoices.length === 0) {
    err("No Claude Desktop installs found.");
    info(`Add a Desktop profile with ${command("claude-multiprofile add")}, or launch the default Claude Desktop at least once.`);
    process.exit(1);
  }
  if (desktopProfiles.length === 0) {
    err("No Desktop profiles configured to copy into.");
    info(`Create one first with ${command("claude-multiprofile add")}.`);
    process.exit(1);
  }

  // ---- Pick source --------------------------------------------------------

  const source = await select({
    message: "Copy extensions FROM:",
    choices: sourceChoices,
  });

  // Targets exclude the default install and the chosen source profile.
  const targetChoices = desktopProfiles
    .filter((p) => p.desktop.dataDir !== source.dataDir)
    .map((p) => ({
      name: `${p.name} ${dim(`(${tildify(p.desktop.dataDir)})`)}`,
      value: { label: p.name, dataDir: p.desktop.dataDir, profile: p },
    }));

  if (targetChoices.length === 0) {
    err("No eligible target profiles. (Need at least one Desktop profile other than the source.)");
    info(`Create another Desktop profile with ${command("claude-multiprofile add")}.`);
    process.exit(1);
  }

  const target = await select({
    message: "Copy extensions TO:",
    choices: targetChoices,
  });

  step(`Copying extensions: ${source.label} → ${target.label}`);
  info(`Source: ${pathStr(tildify(source.dataDir))}`);
  info(`Target: ${pathStr(tildify(target.dataDir))}`);

  // ---- Inventory ----------------------------------------------------------

  const sourceExts = listExtensions(source.dataDir);
  if (sourceExts.length === 0) {
    warn(`No extensions found in ${source.label}.`);
    info("Install extensions there first, then re-run this command.");
    return;
  }

  const targetExts = listExtensions(target.dataDir);
  const targetIds = new Set(targetExts.map((e) => e.id));

  // ---- Interactive selection ----------------------------------------------

  console.log("");
  const choices = sourceExts.map((ext) => {
    const conflict = targetIds.has(ext.id);
    const noSettings = !ext.hasSettings;
    const tags = [];
    if (conflict) tags.push("already in target");
    if (noSettings) tags.push("no settings file");
    const suffix = tags.length ? dim(` (${tags.join(", ")})`) : "";
    return {
      name: ext.id + suffix,
      value: ext.id,
      // Pre-select non-conflicting extensions to make the common path fast.
      // User can deselect or extend.
      checked: !conflict,
    };
  });

  const selected = await checkbox({
    message: "Which extensions to copy? (space to toggle, enter to confirm)",
    choices,
    pageSize: Math.min(choices.length + 2, 15),
  });

  if (selected.length === 0) {
    warn("No extensions selected. Nothing to do.");
    return;
  }

  // ---- Conflict resolution ------------------------------------------------

  const conflicts = selected.filter((id) => targetIds.has(id));
  let overwriteConflicts = force;

  if (conflicts.length > 0 && !force) {
    console.log("");
    warn(`${conflicts.length} of the selected extensions already exist in the target profile:`);
    for (const id of conflicts) console.log(`    ${id}`);
    console.log("");
    overwriteConflicts = await confirm({
      message: "Overwrite the existing copies in the target? (Their current settings will be lost.)",
      default: false,
    });
  }

  // ---- Apply --------------------------------------------------------------

  step("Copying");
  let copied = 0;
  let skipped = 0;
  for (const id of selected) {
    const ext = sourceExts.find((e) => e.id === id);
    if (!ext) continue;
    if (targetIds.has(id) && !overwriteConflicts) {
      info(`Skipped ${id} (already exists, no overwrite).`);
      skipped++;
      continue;
    }
    try {
      copyExtension(ext, target.dataDir);
      ok(`Copied ${id}${ext.hasSettings ? "" : " (no settings file)"}`);
      copied++;
    } catch (e) {
      err(`Failed to copy ${id}: ${e.message}`);
    }
  }

  console.log("");
  ok(`Done. Copied ${copied} extension${copied === 1 ? "" : "s"}${skipped > 0 ? `, skipped ${skipped}` : ""}.`);
  info("Restart Claude Desktop for the new profile to pick up the extensions.");
}
