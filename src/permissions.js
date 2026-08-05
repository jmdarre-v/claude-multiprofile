// Cross-profile filesystem confinement for Claude Code profiles.
//
// Background (GitHub issue #4):
//
// Profile isolation here is by *configuration* (CLAUDE_CONFIG_DIR), not by
// *reachability*. A running Code profile's filesystem tools can still wander
// into a sibling profile's config dir during an ordinary glob/grep/dir-walk,
// and pull another profile's CLAUDE.md, skills, or MCP config into context.
//
// Claude Code gives us an *enforceable* fix: `permissions.deny` rules with a
// `Read(...)` matcher hard-block reads (no prompt) and are best-effort applied
// to Grep and Glob as well. So for each Code profile we write deny rules that
// make every *other* profile's directories unreachable.
//
// We only manage the rules WE add. To avoid clobbering a user's own deny
// rules, or leaving stale ones behind when a profile is renamed or removed,
// we record the exact set of rules we manage in a marker key inside the same
// settings.json, and on every resync we remove the previous managed set before
// writing the current one.
//
// Desktop profiles have no equivalent hook (Electron isn't Claude Code), so
// this confinement covers Code profiles only. That limitation is documented
// in the README.

import fs from "node:fs";
import path from "node:path";
import { ok, info, dim, tildify, fileExists } from "./util.js";

// The settings key we own. Anything listed here was written by us and is safe
// to remove on the next resync; rules outside this list belong to the user.
const MARKER_KEY = "claudeMultiprofileManagedDeny";

export function settingsPathFor(configDir) {
  return path.join(configDir, "settings.json");
}

function denyRuleForPath(absPath) {
  // Claude Code absolute-path syntax uses a DOUBLE leading slash. A single
  // leading slash would be read as relative to the settings source, not the
  // filesystem root. `/**` matches the directory and everything under it, so
  // one rule per directory is enough (Grep/Glob are covered too).
  if (!absPath || !absPath.startsWith("/")) return null;
  const trimmed = absPath.replace(/\/+$/, "");
  return `Read(//${trimmed.replace(/^\/+/, "")}/**)`;
}

// The directories a given profile should be blocked from reading: every OTHER
// profile's Code config dir and Desktop data dir. We deliberately do NOT deny
// the user's default ~/.claude, which is their primary and denying it would be
// surprising; issue #4 is about profiles discovering *each other*.
function managedRulesForProfile(profile, allProfiles) {
  const rules = [];
  for (const other of allProfiles) {
    if (other.name === profile.name) continue;
    const dirs = [];
    if (other.code && other.code.configDir) dirs.push(other.code.configDir);
    if (other.desktop && other.desktop.dataDir) dirs.push(other.desktop.dataDir);
    for (const d of dirs) {
      const rule = denyRuleForPath(d);
      if (rule && !rules.includes(rule)) rules.push(rule);
    }
  }
  return rules.sort();
}

function readSettings(p) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeSettings(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// Rewrite one profile's managed deny rules. Returns a summary object, or null
// if there was nothing to do (no siblings and nothing we'd previously written).
function resyncOne(profile, allProfiles) {
  if (!profile.code || !profile.code.configDir) return null;
  const configDir = profile.code.configDir;
  // If the config dir is gone (e.g. mid-removal), skip silently.
  if (!fileExists(configDir)) return null;

  const settingsPath = settingsPathFor(configDir);
  const settings = readSettings(settingsPath);
  const prevManaged = Array.isArray(settings[MARKER_KEY]) ? settings[MARKER_KEY] : [];
  const managed = managedRulesForProfile(profile, allProfiles);

  // Nothing to add and nothing we previously added: don't create noise in a
  // fresh single-profile setup.
  if (managed.length === 0 && prevManaged.length === 0) return null;

  const prevSet = new Set(prevManaged);
  settings.permissions = settings.permissions || {};
  let deny = Array.isArray(settings.permissions.deny)
    ? settings.permissions.deny
    : [];
  // Drop our previously-managed rules, keep the user's own.
  deny = deny.filter((r) => !prevSet.has(r));
  // Add the current managed set (avoid duplicating a rule the user also set).
  for (const r of managed) if (!deny.includes(r)) deny.push(r);

  settings.permissions.deny = deny;
  if (managed.length > 0) {
    settings[MARKER_KEY] = managed;
  } else {
    // No siblings anymore, so remove our marker entirely.
    delete settings[MARKER_KEY];
  }

  writeSettings(settingsPath, settings);
  return { name: profile.name, settingsPath, ruleCount: managed.length };
}

// Rewrite deny rules for every Code profile in the registry. Call after any
// change to the profile set (add / remove / rename). `opts.verbose` prints a
// line per updated profile; otherwise it works quietly.
export function resyncDenyRules(registry, opts = {}) {
  const profiles = (registry && registry.profiles) || [];
  const results = [];
  for (const p of profiles) {
    const r = resyncOne(p, profiles);
    if (r) results.push(r);
  }
  if (opts.verbose && results.length > 0) {
    ok("Updated cross-profile read-protection:");
    for (const r of results) {
      info(
        `  ${r.name}: ${r.ruleCount} rule${r.ruleCount === 1 ? "" : "s"} ${dim(
          `(${tildify(r.settingsPath)})`
        )}`
      );
    }
  }
  return results;
}

// Read-only inspection for `doctor`: does each Code profile's settings.json
// actually deny every sibling it should? Returns per-profile findings.
export function auditDenyRules(registry) {
  const profiles = (registry && registry.profiles) || [];
  const findings = [];
  for (const p of profiles) {
    if (!p.code || !p.code.configDir) continue;
    const expected = managedRulesForProfile(p, profiles);
    if (expected.length === 0) continue;
    const settingsPath = settingsPathFor(p.code.configDir);
    const settings = readSettings(settingsPath);
    const deny = new Set(
      (settings.permissions && Array.isArray(settings.permissions.deny)
        ? settings.permissions.deny
        : []).map((r) => r)
    );
    const missing = expected.filter((r) => !deny.has(r));
    findings.push({
      name: p.name,
      settingsPath,
      expected: expected.length,
      missing,
    });
  }
  return findings;
}
