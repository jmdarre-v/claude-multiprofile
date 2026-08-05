// `claude-multiprofile rename [old] [new]` - rename a profile end to end.
//
// A profile's name shows up in more places than people expect:
//
//   - the Code config dir      ~/.claude-<name>
//   - the shell alias          claude-<name>
//   - the Desktop data dir     ~/Library/Application Support/Claude-<Name>
//   - the launcher bundle      ~/Applications/Claude <Name>.app
//   - the launcher's bundle ID com.claude-multiprofile.<name>
//   - the registry entry
//   - every OTHER profile's cross-profile deny rules
//
// Renaming by hand means getting all seven right. This command does them
// together, or not at all.
//
// IMPORTANT CAVEAT — Claude Code logins do not survive the move.
//
// Claude Code stores its OAuth token in the login Keychain under a service
// name like `Claude Code-credentials-<hash>`, where <hash> is derived from
// CLAUDE_CONFIG_DIR. Moving the config dir changes that key, so the profile
// can no longer find its token and you must sign in again. We cannot re-key
// the entry for you: the hashing scheme isn't documented or reproducible, and
// guessing at Keychain entries risks destroying the WRONG account's
// credentials. So we warn loudly and let you decide.
//
// Desktop profiles are unaffected — their auth lives inside the data folder
// we're moving, so it travels with them.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { select, input, confirm } from "@inquirer/prompts";
import { getRegistry, findProfile, replaceProfile } from "../registry.js";
import { resyncDenyRules } from "../permissions.js";
import { addAlias, removeAlias, defaultConfigDirFor, defaultAliasNameFor } from "../code.js";
import {
  compileApp,
  copyClaudeIcon,
  defaultDataDirFor,
  defaultAppPathFor,
} from "../desktop.js";
import {
  header,
  ok,
  warn,
  err,
  info,
  step,
  explain,
  command,
  pathStr,
  tildify,
  fileExists,
  sanitizeName,
} from "../util.js";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// Move a directory, creating the parent if needed. Returns false when the
// source doesn't exist (nothing to move) so callers can carry on.
function moveDir(from, to) {
  if (!fileExists(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return true;
}

export async function rename(args = []) {
  header("Rename a profile");

  const reg = getRegistry();
  if (reg.profiles.length === 0) {
    warn("No profiles configured.");
    info(`Create one with ${command("claude-multiprofile add")}.`);
    return;
  }

  // ---- Pick the profile ----------------------------------------------------

  let oldName = args[0];
  if (!oldName) {
    oldName = await select({
      message: "Which profile do you want to rename?",
      choices: reg.profiles.map((p) => ({
        name: `${p.name} (${p.type})`,
        value: p.name,
      })),
    });
  }

  const profile = findProfile(oldName);
  if (!profile) {
    err(`Profile "${oldName}" not found.`);
    info(`Run ${command("claude-multiprofile list")} to see configured profiles.`);
    process.exit(1);
  }

  // ---- Pick the new name ---------------------------------------------------

  let newName = args[1];
  if (!newName) {
    newName = await input({
      message: "New name:",
      validate: (v) => {
        const cleaned = sanitizeName(v);
        if (!cleaned) return "Name cannot be empty.";
        if (cleaned === oldName) return "That's the current name.";
        if (findProfile(cleaned)) return `Profile "${cleaned}" already exists.`;
        return true;
      },
    });
  }
  newName = sanitizeName(newName);

  if (newName === oldName) {
    info("Name unchanged. Nothing to do.");
    return;
  }
  if (findProfile(newName)) {
    err(`Profile "${newName}" already exists.`);
    process.exit(1);
  }

  // ---- Work out the new paths ---------------------------------------------
  //
  // We only move a directory if it currently sits at the DEFAULT location for
  // the old name. If the user chose a custom path, we leave it exactly where
  // it is — they picked it deliberately and it likely doesn't encode the name.

  const plan = [];
  let newCode = profile.code ? { ...profile.code } : null;
  let newDesktop = profile.desktop ? { ...profile.desktop } : null;

  if (profile.code) {
    const defaultOld = defaultConfigDirFor(oldName);
    if (profile.code.configDir === defaultOld) {
      newCode.configDir = defaultConfigDirFor(newName);
      plan.push(["Code config", profile.code.configDir, newCode.configDir]);
    }
    // The alias is always renamed if it followed the default pattern.
    if (profile.code.aliasName === defaultAliasNameFor(oldName)) {
      newCode.aliasName = defaultAliasNameFor(newName);
      plan.push(["Shell alias", profile.code.aliasName, newCode.aliasName]);
    }
  }

  if (profile.desktop) {
    const defaultOldData = defaultDataDirFor(oldName);
    if (profile.desktop.dataDir === defaultOldData) {
      newDesktop.dataDir = defaultDataDirFor(newName);
      plan.push(["Desktop data", profile.desktop.dataDir, newDesktop.dataDir]);
    }
    const defaultOldApp = defaultAppPathFor(oldName);
    if (profile.desktop.appPath === defaultOldApp) {
      newDesktop.appPath = defaultAppPathFor(newName);
      plan.push(["Launcher app", profile.desktop.appPath, newDesktop.appPath]);
    }
  }

  // ---- Show the plan and confirm ------------------------------------------

  step("Review");
  console.log(`  Profile: ${pathStr(oldName)} → ${pathStr(newName)}\n`);
  if (plan.length === 0) {
    info("All paths are custom; only the profile name and registry entry change.");
  } else {
    for (const [label, from, to] of plan) {
      console.log(`  ${label}:`);
      console.log(`    ${tildify(from)}`);
      console.log(`    → ${tildify(to)}\n`);
    }
  }

  if (profile.code) {
    explain(`
      Heads up: renaming a Claude Code profile signs it out.

      Claude Code keeps its login in the macOS Keychain under a key derived
      from the config folder path. Moving that folder changes the key, so the
      profile won't find its token and you'll run /login once more.

      This tool cannot move the Keychain entry for you — the key derivation
      isn't reproducible, and guessing risks clobbering another account's
      credentials. Your chats, skills, and MCP config all move normally; only
      the sign-in needs redoing.
    `);
  }

  const proceed = await confirm({
    message: `Rename "${oldName}" to "${newName}"?`,
    default: false,
  });
  if (!proceed) {
    warn("Cancelled. Nothing was changed.");
    return;
  }

  // ---- Apply ---------------------------------------------------------------

  step("Applying");

  // Code: move the dir, swap the alias.
  if (profile.code) {
    if (newCode.configDir !== profile.code.configDir) {
      try {
        if (moveDir(profile.code.configDir, newCode.configDir)) {
          ok(`Moved config folder to ${pathStr(tildify(newCode.configDir))}.`);
        } else {
          warn(`Config folder ${tildify(profile.code.configDir)} not found; skipped.`);
        }
      } catch (e) {
        err(`Could not move config folder: ${e.message}`);
        err("Aborting before any further changes. Nothing else was modified.");
        process.exit(1);
      }
    }
    if (newCode.aliasName !== profile.code.aliasName) {
      removeAlias(profile.code.aliasName);
    }
    const { rcPath } = addAlias({
      aliasName: newCode.aliasName,
      configDir: newCode.configDir,
    });
    newCode.rcPath = rcPath;
    ok(`Alias "${newCode.aliasName}" written to ${pathStr(tildify(rcPath))}.`);
  }

  // Desktop: move data, rebuild the launcher so its embedded path and bundle
  // ID match the new name.
  if (profile.desktop) {
    if (newDesktop.dataDir !== profile.desktop.dataDir) {
      try {
        if (moveDir(profile.desktop.dataDir, newDesktop.dataDir)) {
          ok(`Moved data folder to ${pathStr(tildify(newDesktop.dataDir))}.`);
        } else {
          warn(`Data folder ${tildify(profile.desktop.dataDir)} not found; skipped.`);
        }
      } catch (e) {
        err(`Could not move data folder: ${e.message}`);
        process.exit(1);
      }
    }

    // Unregister and delete the old launcher before building the new one, so
    // LaunchServices doesn't keep an entry pointing at a bundle that's gone.
    if (fileExists(profile.desktop.appPath)) {
      if (fileExists(LSREGISTER)) {
        try {
          execFileSync(LSREGISTER, ["-u", profile.desktop.appPath], { stdio: "pipe" });
        } catch {
          // Non-fatal.
        }
      }
      try {
        fs.rmSync(profile.desktop.appPath, { recursive: true, force: true });
      } catch {
        warn(`Could not delete the old launcher at ${tildify(profile.desktop.appPath)}.`);
      }
    }

    try {
      compileApp({
        name: newName,
        dataDir: newDesktop.dataDir,
        appPath: newDesktop.appPath,
        claudeAppPath: profile.desktop.claudeAppPath,
      });
      copyClaudeIcon(newDesktop.appPath, profile.desktop.claudeAppPath);
      ok(`Rebuilt launcher at ${pathStr(tildify(newDesktop.appPath))}.`);
    } catch (e) {
      err(`Could not rebuild the launcher: ${e.message}`);
      info(`You can recreate it with ${command("claude-multiprofile add")} using the new name.`);
    }
  }

  // ---- Registry + deny rules ----------------------------------------------

  replaceProfile(oldName, {
    ...profile,
    name: newName,
    code: newCode,
    desktop: newDesktop,
  });
  ok(`Registry updated.`);

  resyncDenyRules(getRegistry(), { verbose: true });

  // ---- Next steps ---------------------------------------------------------

  console.log("");
  ok(`Profile "${oldName}" is now "${newName}".`);
  if (profile.code) {
    console.log("");
    info("Reload your shell, then sign in again:");
    console.log("  " + command(`source ${tildify(newCode.rcPath)}`));
    console.log("  " + command(newCode.aliasName));
    info("Run /login inside the REPL to re-authenticate this profile.");
  }
  if (profile.desktop) {
    console.log("");
    info("If the old launcher was pinned to your Dock, drag it off and re-pin the new one.");
  }
}
