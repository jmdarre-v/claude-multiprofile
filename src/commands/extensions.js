// `claude-multiprofile extensions <profile>` - copy Claude Desktop extensions
// from your default install into a Desktop profile.
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
//   claude-multiprofile extensions <profile>            # interactive
//   claude-multiprofile extensions <profile> --force    # overwrite conflicts
//
// We do NOT install extensions during `add` time — keeping `add` focused
// on getting a profile up and running. This is a separate command users
// run when they want it.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkbox, confirm } from "@inquirer/prompts";
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
  dim,
  command,
} from "../util.js";
import { DEFAULT_DESKTOP_DATA_DIR } from "../detect.js";

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

  // Parse args. We accept `<profile> [--force]` in either order for
  // forgiveness on flag placement.
  const force = args.includes("--force");
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];

  if (!name) {
    err("Profile name required.");
    info(`Usage: ${command("claude-multiprofile extensions <profile> [--force]")}`);
    info(`Run ${command("claude-multiprofile list")} to see configured profiles.`);
    process.exit(1);
  }

  // ---- Resolve target profile ---------------------------------------------

  const profile = findProfile(name);
  if (!profile) {
    err(`Profile "${name}" not found.`);
    info(`Run ${command("claude-multiprofile list")} to see configured profiles.`);
    process.exit(1);
  }

  if (!profile.desktop) {
    err(`Profile "${name}" is a Code-only profile.`);
    info("Extensions are a Claude Desktop concept; they don't apply to Code profiles.");
    process.exit(1);
  }

  step(`Copying extensions into "${name}"`);
  info(`Source: ${pathStr(tildify(DEFAULT_DESKTOP_DATA_DIR))}`);
  info(`Target: ${pathStr(tildify(profile.desktop.dataDir))}`);

  // ---- Inventory ----------------------------------------------------------

  const sourceExts = listExtensions(DEFAULT_DESKTOP_DATA_DIR);
  if (sourceExts.length === 0) {
    warn("No extensions found in your default Claude Desktop install.");
    info("Install extensions in your default Claude first, then re-run this command.");
    return;
  }

  const targetExts = listExtensions(profile.desktop.dataDir);
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
      copyExtension(ext, profile.desktop.dataDir);
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
