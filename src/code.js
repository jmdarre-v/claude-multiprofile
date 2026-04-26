// Claude Code profile setup.
//
// Background:
//
// Claude Code is the terminal CLI distinct from the Desktop app. It stores
// all of its state under `~/.claude` by default: credentials, project
// memory, plugins, skills, MCP server config, slash command definitions,
// and so on.
//
// The CLI honors a (currently undocumented but stable) environment
// variable, `CLAUDE_CONFIG_DIR`, that overrides this default. Set it to a
// different folder before launching `claude`, and you get a totally
// independent profile: separate auth, separate history, separate plugins.
//
// What this module does:
//
//   1. Creates the new config directory.
//   2. Optionally seeds it from your existing ~/.claude (handy for carrying
//      over installed skills, plugins, and MCP server config without
//      re-doing them all). Authentication does *not* carry over because
//      Claude Code stores its OAuth token in macOS Keychain, keyed by a
//      hash of CLAUDE_CONFIG_DIR. Different dir = different keychain
//      entry = no shared login. Convenient and safe.
//   3. Adds a managed shell alias so you can launch the profile by name:
//
//        claude-work   ->  CLAUDE_CONFIG_DIR=~/.claude-work claude
//
// On first run of the new alias, the user runs /login inside the Claude
// Code REPL and signs in with the account they want associated with that
// profile. From then on, the alias keeps that account's session.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOME, pathStr, tildify, ok, info, warn, step } from "./util.js";
import {
  detectShell,
  rcPathForShell,
  readManagedAliases,
  writeAliases,
  buildAliasLine,
} from "./shell.js";

// Default location for the brand-new profile's config dir.
export function defaultConfigDirFor(name) {
  return path.join(HOME, `.claude-${name}`);
}

// The default Claude Code config dir. Used when we offer to seed the new
// profile from an existing setup.
export const DEFAULT_CLAUDE_CONFIG_DIR = path.join(HOME, ".claude");

export function defaultAliasNameFor(name) {
  // Human-friendly alias users will actually type.
  // We deliberately don't reuse the bare `claude` command since that's
  // the default Claude Code binary. Shadowing it with an alias would
  // surprise users and break tooling that assumes `claude` is the original.
  return `claude-${name}`;
}

// ---- Directory setup -----------------------------------------------------

export function ensureConfigDir(configDir, { seedFromDefault } = {}) {
  // If the directory already exists, we leave it alone. The user is
  // probably re-running the wizard after partial completion, and we do
  // not want to clobber state they may have intentionally put there.
  if (fs.existsSync(configDir)) return false;

  if (seedFromDefault && fs.existsSync(DEFAULT_CLAUDE_CONFIG_DIR)) {
    // Copy the user's existing ~/.claude into the new dir. This carries
    // over skills, plugins, MCP server config, slash commands, and any
    // CLAUDE.md they have at the user level. Auth stays in Keychain so
    // it won't follow.
    //
    // We use `cp -R` rather than fs.cpSync because cp handles macOS
    // metadata (extended attrs, resource forks) more faithfully and
    // is just as fast for typical config sizes.
    fs.mkdirSync(path.dirname(configDir), { recursive: true });
    execFileSync("/bin/cp", [
      "-R",
      DEFAULT_CLAUDE_CONFIG_DIR + "/",
      configDir,
    ]);

    // Wipe anything that looks like a credential file inside the seeded
    // copy. Claude Code's auth lives in Keychain, not on disk, so this is
    // mostly belt-and-suspenders for older installs and project-level
    // .credentials.json files. Better safe than carrying over a stale
    // token that confuses login.
    cleanCredentialsFromDir(configDir);
  } else {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return true;
}

function cleanCredentialsFromDir(dir) {
  // Remove known credential filenames if the user had any stashed locally.
  const candidates = [
    path.join(dir, ".credentials.json"),
    path.join(dir, "credentials.json"),
    path.join(dir, "auth.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        fs.rmSync(c);
      } catch {
        // Non-fatal; user can delete manually if needed.
      }
    }
  }
}

// ---- Shell alias setup ---------------------------------------------------

export function addAlias({ aliasName, configDir }) {
  // We rebuild the entire managed block on every write rather than
  // appending. This keeps the aliases in a stable order (alphabetical)
  // and prevents duplicates.
  const shell = detectShell();
  const existing = readManagedAliases(shell).filter((a) => a.name !== aliasName);
  const newLine = buildAliasLine(shell, aliasName, configDir);
  const allLines = [...existing.map((a) => a.line), newLine].sort();
  const rcPath = writeAliases(shell, allLines);
  return { shell, rcPath };
}

export function removeAlias(aliasName) {
  const shell = detectShell();
  const remaining = readManagedAliases(shell).filter((a) => a.name !== aliasName);
  const lines = remaining.map((a) => a.line).sort();
  const rcPath = writeAliases(shell, lines);
  return { shell, rcPath };
}

// ---- Top-level orchestration ---------------------------------------------

export function setupCode({ name, configDir, aliasName, seedFromDefault }) {
  step(`Creating Claude Code profile "${name}"`);

  info(`Config folder: ${pathStr(tildify(configDir))}`);
  info(`Shell alias: ${pathStr(aliasName)}`);

  const created = ensureConfigDir(configDir, { seedFromDefault });
  if (created) {
    if (seedFromDefault) {
      ok(`Config folder created and seeded from ${pathStr(tildify(DEFAULT_CLAUDE_CONFIG_DIR))}.`);
      ok("Existing skills, plugins, and MCP config carried over. Auth did not (it lives in Keychain).");
    } else {
      ok("Config folder created (empty).");
    }
  } else {
    warn(`Config folder already existed; left untouched. (${pathStr(tildify(configDir))})`);
  }

  const { shell, rcPath } = addAlias({ aliasName, configDir });
  ok(`Alias "${aliasName}" added to ${pathStr(tildify(rcPath))} (shell: ${shell}).`);

  return { configDir, aliasName, shell, rcPath };
}
