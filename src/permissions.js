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
import { ok, warn, info, dim, tildify, fileExists } from "./util.js";

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

// Read a settings.json distinguishing three cases: missing (fine, start
// empty), valid JSON object (use it), and PRESENT BUT MALFORMED. The last one
// is the dangerous case: if we treated it as empty and wrote our rules back,
// we would silently replace whatever the user had in there (a stray trailing
// comma or a JSONC-style comment is all it takes). Malformed files are
// therefore never written to; callers skip and warn instead.
function readSettings(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return { settings: {}, malformed: false }; // missing: safe to create
  }
  if (raw.trim() === "") {
    return { settings: {}, malformed: false }; // empty file: nothing to lose
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { settings: parsed, malformed: false };
    }
  } catch {
    // fall through
  }
  return { settings: null, malformed: true };
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
  const { settings, malformed } = readSettings(settingsPath);
  if (malformed) {
    // Never write over a file we couldn't parse. Report it so the resync
    // summary can tell the user to fix the JSON by hand.
    return { name: profile.name, settingsPath, skipped: "malformed" };
  }
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
  const updated = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped === "malformed");
  if (opts.verbose && updated.length > 0) {
    ok("Updated cross-profile read-protection:");
    for (const r of updated) {
      info(
        `  ${r.name}: ${r.ruleCount} rule${r.ruleCount === 1 ? "" : "s"} ${dim(
          `(${tildify(r.settingsPath)})`
        )}`
      );
    }
  }
  // A skipped file is a safety event, not a routine one: always surface it,
  // even when the caller asked for quiet output.
  for (const r of skipped) {
    warn(
      `Skipped ${r.name}: ${tildify(r.settingsPath)} is not valid JSON, so it was left untouched.`
    );
    info("  Fix the JSON by hand, then run `claude-multiprofile doctor --fix`.");
  }
  return results;
}

// Remove OUR managed rules (and the marker) from one profile's settings.json,
// leaving everything the user wrote intact. Called by `remove` when the
// profile leaves the registry but its config folder stays on disk: without
// this, the folder would keep deny rules aimed at profiles it no longer has
// any relationship with.
export function stripManagedDenyRules(profile) {
  if (!profile.code || !profile.code.configDir) return false;
  if (!fileExists(profile.code.configDir)) return false;

  const settingsPath = settingsPathFor(profile.code.configDir);
  const { settings, malformed } = readSettings(settingsPath);
  if (malformed) {
    warn(`${tildify(settingsPath)} is not valid JSON; left untouched.`);
    return false;
  }
  const prevManaged = Array.isArray(settings[MARKER_KEY]) ? settings[MARKER_KEY] : [];
  if (prevManaged.length === 0) return false;

  const prevSet = new Set(prevManaged);
  if (settings.permissions && Array.isArray(settings.permissions.deny)) {
    settings.permissions.deny = settings.permissions.deny.filter(
      (r) => !prevSet.has(r)
    );
  }
  delete settings[MARKER_KEY];
  writeSettings(settingsPath, settings);
  return true;
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
    const { settings, malformed } = readSettings(settingsPath);
    if (malformed) {
      findings.push({
        name: p.name,
        settingsPath,
        expected: expected.length,
        missing: expected,
        malformed: true,
      });
      continue;
    }
    const deny = new Set(
      settings.permissions && Array.isArray(settings.permissions.deny)
        ? settings.permissions.deny
        : []
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
