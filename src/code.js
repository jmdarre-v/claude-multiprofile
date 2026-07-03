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

// Sharing model: BLOCKLIST, not allowlist. Everything under ~/.claude is
// shareable EXCEPT auth/identity (the hard security boundary) and instance-
// local noise (caches, logs — sharing them just causes conflicts). This lets
// a user share their own custom dirs/files too, without us enumerating them.
//
// The auth exclusions are the security-critical part and are re-enforced at
// the sink (symlinkSelected), so login can never leak no matter what is passed.
const NEVER_SHARE_EXACT = new Set([
  ".claude.json", // oauthAccount identity + per-project trust
  ".credentials.json", // the login itself (Linux/Windows file form)
  "credentials.json",
  "auth.json",
  // instance-local / cache / noise: sharing these causes conflicts, not value
  "statsig", "backups", "shell-snapshots", "debug", "ide", "jobs",
  "cache", "paste-cache", "telemetry", ".DS_Store",
]);

// Patterns for names we can't enumerate (a future .credentials-v2.json, an
// api-token file, per-instance caches). The auth/identity patterns are the
// security-critical ones and are matched UNBOUNDED on purpose: for that class
// we prefer a rare false-positive (a safe file wrongly hidden from the picker)
// over ever sharing a credential. Erring closed is the point of the boundary.
const NEVER_SHARE_PATTERNS = [
  // auth / identity — fail closed
  /credential/i, /token/i, /secret/i, /password/i, /passwd/i,
  /api[-_]?key/i, /cookie/i, /keychain/i,
  /\.pem$/i, /\.key$/i, /\.jwt$/i, /id_(rsa|dsa|ecdsa|ed25519)/i,
  /(^|[.-])oauth([.-]|$)/i, /(^|[.-])auth([.-]|$)/i,
  /(^|[.-])account([.-]|$)/i, /(^|[.-])identity([.-]|$)/i,
  /^\.env($|\.)/i,
  // instance-local noise — not security, just avoids junk/conflicts
  /cache/i, /-stats\.json$/i, /^daemon/i, /\.log$/i,
];

// True if `name` (a single basename from ~/.claude) is safe to share. Rejects
// path separators and dot-segments so a crafted name can't escape the source
// or profile dir through the symlink path.
export function isShareable(name) {
  if (!name || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (NEVER_SHARE_EXACT.has(name)) return false;
  return !NEVER_SHARE_PATTERNS.some((re) => re.test(name));
}

// The shareable entries actually present under sourceDir. Populates the
// interactive picker — a user's own custom items show up here too.
export function shareableItemsIn(sourceDir = DEFAULT_CLAUDE_CONFIG_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(sourceDir);
  } catch {
    return [];
  }
  return entries.filter(isShareable).sort();
}

export function defaultAliasNameFor(name) {
  // Human-friendly alias users will actually type.
  // We deliberately don't reuse the bare `claude` command since that's
  // the default Claude Code binary. Shadowing it with an alias would
  // surprise users and break tooling that assumes `claude` is the original.
  return `claude-${name}`;
}

// ---- Directory setup -----------------------------------------------------

// seedMode:
//   "copy"    - cp -R ~/.claude into the new dir (point-in-time snapshot)
//   "symlink" - symlink the selected safe items from ~/.claude (live share)
//   "empty"   - just create an empty dir (default when there's no ~/.claude)
export function ensureConfigDir(
  configDir,
  { seedMode = "empty", seedItems } = {}
) {
  // If the directory already exists, we leave it alone. The user is
  // probably re-running the wizard after partial completion, and we do
  // not want to clobber state they may have intentionally put there.
  if (fs.existsSync(configDir)) return false;

  const hasDefault = fs.existsSync(DEFAULT_CLAUDE_CONFIG_DIR);

  if (seedMode === "copy" && hasDefault) {
    // Copy the user's existing ~/.claude into the new dir. This carries
    // over skills, plugins, slash commands, and any CLAUDE.md they have at
    // the user level. Auth stays in Keychain so it won't follow.
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

    // Copy the same safe set as symlink mode: prune anything the blocklist
    // excludes (auth/identity + cache/instance noise) from the snapshot, so
    // both modes honor one source of truth and a copied profile can never
    // retain a credential, token, or key file.
    for (const name of fs.readdirSync(configDir)) {
      if (!isShareable(name)) {
        fs.rmSync(path.join(configDir, name), { recursive: true, force: true });
      }
    }
    // Belt-and-suspenders for legacy on-disk credential files.
    cleanCredentialsFromDir(configDir);
  } else if (seedMode === "symlink" && hasDefault) {
    fs.mkdirSync(configDir, { recursive: true });
    symlinkSelected(configDir, seedItems ?? shareableItemsIn());
  } else {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return true;
}

// Symlink each selected item from ~/.claude into configDir. The profile then
// shares that live data with the root instead of holding a stale copy.
//
// Security boundary: every name is re-checked with isShareable(), so even if a
// caller passes an auth file, a cache dir, or a traversal name (../x), it is
// skipped. Auth can never be symlinked through this path.
export function symlinkSelected(configDir, items, sourceDir = DEFAULT_CLAUDE_CONFIG_DIR) {
  const linked = [];
  for (const name of items ?? []) {
    if (!isShareable(name)) {
      warn(`Refusing to symlink "${name}" (auth/identity or unsafe name).`);
      continue;
    }
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) continue; // nothing to link
    const dst = path.join(configDir, name);
    // Only clear a prior symlink so re-linking is idempotent. Never recursively
    // delete a real file/dir a caller may have placed here — if one exists,
    // symlinkSync throws EEXIST and we fail loud rather than destroy data.
    try {
      if (fs.lstatSync(dst).isSymbolicLink()) fs.rmSync(dst);
    } catch {
      // dst doesn't exist — nothing to clear.
    }
    fs.symlinkSync(src, dst);
    linked.push(name);
  }
  return linked;
}

function cleanCredentialsFromDir(dir) {
  // Remove known credential/identity filenames from a copied profile. Auth
  // lives in Keychain, but a copied .claude.json carries oauthAccount identity
  // and per-project trust, and older installs may have on-disk credential files.
  const candidates = [
    path.join(dir, ".claude.json"),
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

export function setupCode({ name, configDir, aliasName, seedMode = "empty", seedItems }) {
  step(`Creating Claude Code profile "${name}"`);

  info(`Config folder: ${pathStr(tildify(configDir))}`);
  info(`Shell alias: ${pathStr(aliasName)}`);

  const created = ensureConfigDir(configDir, { seedMode, seedItems });
  if (created) {
    if (seedMode === "copy") {
      ok(`Config folder created and copied from ${pathStr(tildify(DEFAULT_CLAUDE_CONFIG_DIR))}.`);
      ok("Existing skills, plugins, and settings carried over. Auth did not (login lives in Keychain).");
    } else if (seedMode === "symlink") {
      const linked = seedItems ?? shareableItemsIn();
      ok(`Config folder created with ${linked.length} symlink(s) into ${pathStr(tildify(DEFAULT_CLAUDE_CONFIG_DIR))}.`);
      ok("Linked items stay in sync with your root profile. Auth was not linked (it lives in Keychain).");
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
